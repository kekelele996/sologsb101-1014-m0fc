# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移（v3 按移交切开两侧） |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts handover.ts care.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts careStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含养护管护台 CareBoard）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts baseline.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台（**项目部**）：按测次录入、自动算成活率、低于阈值告警、批量调整成活率等级；已移交地块冻结 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划（**项目部**，仅未移交地块）：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看 |
| `/care` | `pages/CareBoard.tsx` | 养护管护台（**养护队**，移交后）：管护作业单（补苗上报 / 复查），按地块与移交基线对账，对不上 / 超基线挂起，挂起期间不出补植计划 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引，`version(3)` 按移交切开两侧数据：
  * v2 迁移内容：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM`；回填 `revision` / 时间戳、`missingCount` / `lastReplantDate`、验收 `grade` / `gradeManual`。
  * **v3 迁移（移交切开）**：`plots` 增加 `handoverBatch` / `handoverDate` / `readOnly`，新增两张表 `handoverBaselines`、`careRechecks`。已有数据没有移交标记，升级时**按地块状态补基线**：
    - `已验收` 且能算出基线（有栽植 + 有验收）的地块，补建项目部 / 养护队两侧留底（`source='migration'`）并转为 `已移交`；
    - `已验收` 但补不齐（缺栽植或验收）的地块**先只读留着**（`readOnly=true`），不补基线、不开放管护对账；
    - 已移交地块上的旧「待补植」补植计划置为「已复核」留档，移交后不再出补植计划。
* **按移交切开的数据归属**：
  * **移交前**的地块档案、苗木批次、栽植记录、验收测次归**项目部**；
  * **移交时**把「栽植总株数 / 成活株数 / 缺株数」抄成基线（`handoverBaselines`），按归属侧（`项目部` / `养护队`）各存一条，**两边各自留底**；
  * **移交后**的管护作业单（补苗上报、复查）归**养护队**（`careRechecks`）。
* **移交 / 对账规则**（`src/utils/baseline.ts`、`src/utils/db.ts`）：
  * 移交在一个事务内先写项目部侧留底并给地块打移交标记；养护队侧留底单独再写——**养护侧写不进去只补跑本侧**（地块台账提供「只补跑养护侧」，复制项目部那份基线），不回滚项目部侧。
  * 项目部那份**成活率停在移交当天那版**：已移交地块的总株数 / 成活率取基线值，移交后的测次不进项目部口径，补植完成回写也跳过已移交地块。
  * 养护队的补苗数与复查按地块与养护侧基线对账：**对不上**（缺数据）标记 `mismatch`，**累计补苗超过基线缺株数**标记 `overBaseline`，两者都先**挂起复核（held）**；**挂起期间不出补植计划**，核对清楚后「复核放行（resolved）」。
  * 养护复查的成活株数**单独记**，不回写项目部验收。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt, handoverBatch |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade |
  | `replants` | id | plotId, planDate, state, species |
  | `handoverBaselines` | id | plotId, batch, side, [plotId+side], handoverDate |
  | `careRechecks` | id | plotId, batch, date, status, [plotId+status] |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 → 验收 → 补植** 三层互相引用：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；其中**北屿外滩 B 区已移交**养护队（两侧基线留底 + 3 张管护作业单，含 1 张超基线被挂起的补苗单）；
  * 6 个苗木批次（每地块 2 批）、6 条栽植记录（每地块 2 条，引用真实批次 id）；
  * 7 条验收记录（每地块 2–3 个测次，成活率自洽：90.0% → 85.0% → 79.0% 等；已移交地块的测次停在移交当天）；
  * 3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态；已移交地块上的为已复核留档）。
  * 2 条移交基线（已移交地块的项目部 / 养护队各一条，数据一致）+ 3 条养护管护作业单。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **成活率** = 成活株数 ÷ 该地块栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写（仅未移交地块）**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率。**已移交地块跳过此回写**（项目部数据冻结）。
* **移交切开**：地块验收合格后执行「移交养护」，把栽植总株数 / 成活株数 / 缺株数抄成基线两侧留底；
  项目部那份成活率停在移交当天那版，移交后的补苗与复查由养护队按地块对账（对不上 / 超基线先挂起，
  挂起期间不出补植计划）。养护侧留底写不进去时只补跑本侧；旧数据升级补不齐基线的地块先只读留着。
