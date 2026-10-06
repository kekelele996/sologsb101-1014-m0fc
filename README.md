# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。
地块验收合格后**按移交切开项目部与养护队**：移交时把栽植总株数、成活株数、缺株数抄成基线两边各自留底，
移交后管护作业单归养护队并与基线按地块对账，对不上或比基线多出的挂起复核，挂起期间不出补植计划。

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
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
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
        ├── pages/              # 6 个模块页面
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts export.ts seed.ts id.ts reconcile.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率、已验收地块一键移交 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示）；已移交/待补录地块只读 |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性；已移交/待补录地块只读 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入、自动算成活率、低于阈值告警、批量调整成活率等级；已移交地块测次冻结 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看；挂起地块不出计划 |
| `/care` | `pages/CareBoard.tsx` | 管护作业单（养护队）：补苗/复查登记并按移交基线对账、挂起复核与放行、按地块对账总览、养护队侧补跑 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移，
  `version(3)` 按移交切开项目部 / 养护队：
  * 新增 `handovers`（移交基线，两边各自留底）与 `careTasks`（管护作业单）两张表；
  * `plots` 增加 `handoverState`（未移交 / 已移交 / 待补录）与 `handoverId`；
  * 已有数据没有移交标记：升级时按地块状态补基线——「已验收」地块能由栽植记录与最新测次推齐
    基线的补建移交单，补不齐的标记「待补录」只读留着；
  * 导入旧版 JSON 存档时走同一套补基线逻辑（`normalizeSnapshotHandover`）。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, handoverState, createdAt, updatedAt |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade |
  | `replants` | id | plotId, planDate, state, species |
  | `handovers` | id | plotId, handoverDate |
  | `careTasks` | id | plotId, handoverId, workDate, state, kind |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 → 验收 → 补植 → 移交 → 管护** 互相引用：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（每地块 2 批）、6 条栽植记录（每地块 2 条，引用真实批次 id）；
  * 7 条验收记录（每地块 2–3 个测次，成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态）；
  * 1 张移交单（北屿外滩 B 区：基线 8000 / 7440 / 560 株、成活率 93.0%，两边留底）；
  * 3 条管护作业单（正常补苗 300 株 / 正常复查 7700 株 / 挂起复核补苗 400 株——超出剩余可补 260 株）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录、补植计划、移交单与管护作业单（同一 Dexie 事务内完成）。

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
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率；已移交地块项目部口径冻结，不回写。
* **移交切开**（`src/utils/db.ts` 分侧落库 + `src/utils/reconcile.ts` 对账）：
  * 移交前：地块、栽植记录、验收测次归项目部维护；移交后项目部侧冻结只读，
    项目部那份成活率停在移交当天那版（基线 `projectCopy`），管护作业单归养护队；
  * 移交时把栽植总株数、成活株数、缺株数、成活率抄成基线，`projectCopy` / `maintenanceCopy`
    两边各自留底；落库分「项目部侧冻结」「养护队侧建档」两个独立事务，
    养护队侧写不进去时只补跑本侧（幂等），项目部留底不动；
  * 养护队的补苗数与复查成活株数按地块与基线（`maintenanceCopy`）对账：
    补苗超过「基线缺株 − 已确认补苗累计」、复查超过「基线成活 + 已确认补苗」或超过基线总株数，
    都视为对不上 / 比基线多出，**挂起复核**；挂起期间该地块不出补植计划（新建与一键生成均拦截）；
  * 养护队复查单独记在 `careTasks`，不回写项目部验收测次；
  * 升级 / 导入旧存档时按地块状态补基线，补不齐的「待补录」只读留着。
