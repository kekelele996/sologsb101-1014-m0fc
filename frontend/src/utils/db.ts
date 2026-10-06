/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3 起增加「移交基线」与「养护复查」两张表，按移交切开项目部 / 养护队两侧数据
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { HandoverBaseline, HandoverBatch, HandoverSide } from '../types/handover';
import type { CareRecheck, CareRecheckDraft } from '../types/care';
import { rateLevel } from './rate';
import { buildBaselineFigures, reconcileCareJob } from './baseline';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  handoverBaselines!: Table<HandoverBaseline, string>;
  careRechecks!: Table<CareRecheck, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：按移交切开项目部 / 养护队两侧 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt, handoverBatch',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        // 移交基线：按地块 + 批次 + 归属侧各留一条
        handoverBaselines: 'id, plotId, batch, side, [plotId+side], handoverDate',
        // 养护队管护作业单（补苗上报 / 复查），按地块对账
        careRechecks: 'id, plotId, batch, date, status, [plotId+status]',
      })
      .upgrade(async (tx) => {
        const plotRows = await tx.table('plots').toArray() as Plot[];
        const surveys = (await tx.table('surveys').toArray()) as Survey[];
        const plantings = (await tx.table('plantings').toArray()) as Planting[];
        const stamp = nowIso();
        const migratedHandedIds = new Set<string>();

        // 迁移 1：地块补齐移交相关字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.handoverBatch !== 'string') row.handoverBatch = '';
          if (typeof row.handoverDate !== 'string') row.handoverDate = '';
          if (typeof row.readOnly !== 'boolean') row.readOnly = false;
        });

        // 迁移 2：已有数据没有移交标记——按地块状态补基线。
        // state 为「已验收」的地块视同已移交；能算出基线的，补两侧留底并标记已移交；
        // 补不齐的（无栽植 / 无验收）先只读留着，不补基线、不开放养护对账。
        for (const plot of plotRows) {
          if (plot.state !== '已验收') continue;
          const figures = buildBaselineFigures(plot.id, surveys, plantings);
          if (figures === null) {
            await tx.table('plots').update(plot.id, { readOnly: true, updatedAt: stamp });
            continue;
          }
          const batch = `handover-mig-${plot.id}`;
          const makeRow = (side: HandoverSide): HandoverBaseline => ({
            id: uuid(`baseline-${side === '项目部' ? 'proj' : 'care'}`),
            plotId: plot.id,
            batch,
            side,
            handoverDate: plot.handoverDate || today(),
            source: 'migration',
            note: '旧数据升级：按地块「已验收」状态补建移交基线',
            ...figures,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
          await tx.table('handoverBaselines').put(makeRow('项目部'));
          await tx.table('handoverBaselines').put(makeRow('养护队'));
          migratedHandedIds.add(plot.id);
          await tx.table('plots').update(plot.id, {
            state: '已移交',
            handoverBatch: batch,
            handoverDate: plot.handoverDate || today(),
            missingCount: figures.missingCount,
            updatedAt: stamp,
          });
        }

        // 迁移 3：只有真正补上基线、转为已移交的地块，其旧「待补植」计划才置为已复核留档
        //（只读留底地块不补基线，也不动其补植计划）
        await tx.table('replants').toCollection().modify((row: Record<string, unknown>) => {
          if (migratedHandedIds.has(String(row.plotId)) && row.state === '待补植') {
            row.state = '已复核';
            row.updatedAt = stamp;
          }
        });

        // 迁移 4：全部行修订号升到当前结构
        for (const name of ['plots', 'seedlings', 'plantings', 'surveys', 'replants']) {
          await tx.table(name).toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
          });
        }
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下全部子记录（含移交基线与管护作业单） */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handoverBaselines, db.careRechecks],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.handoverBaselines.where('plotId').equals(id).delete();
      await db.careRechecks.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写（仅作用于未移交地块）：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 * 移交后的地块归养护队：此回写不得改动项目部停在移交当天那版成活率，直接跳过。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;
    // 移交切开：移交后的回写归养护侧，项目部数据冻结
    if (plot.state === '已移交') return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ------------------------------ 移交基线 ------------------------------ */

export interface HandoverResult {
  batch: HandoverBatch;
  /** 项目部侧留底是否已写入（必须成功） */
  projectWritten: boolean;
  /** 养护队侧留底是否已写入；false 时可调用 backfillCareBaseline 只补跑本侧 */
  careWritten: boolean;
  reason?: string;
}

/** 列出移交基线（可按地块过滤） */
export async function listHandoverBaselines(plotId?: string): Promise<HandoverBaseline[]> {
  if (plotId === undefined) return db.handoverBaselines.toArray();
  return db.handoverBaselines.where('plotId').equals(plotId).toArray();
}

/** 取某地块某归属侧的留底 */
export async function getHandoverCopy(plotId: string, side: HandoverSide): Promise<HandoverBaseline | undefined> {
  const rows = await db.handoverBaselines
    .where('[plotId+side]')
    .equals([plotId, side] as [string, HandoverSide])
    .toArray();
  return rows[0];
}

/**
 * 执行移交（地块验收合格 → 养护队）。
 * 把移交当天的栽植总株数 / 成活株数 / 缺株数抄成基线，两边各自留底：
 * - 先在一个事务内写「项目部侧留底 + 地块移交标记」（必须成功，失败整体回滚）；
 * - 养护队侧留底单独再写一次：该侧写不进去（唯一约束等）不影响已成功的项目部侧，
 *   只返回 careWritten=false，由调用方走「只补跑本侧」。
 */
export async function performHandover(
  plotId: string,
  handoverDate: string,
  note: string,
): Promise<HandoverResult> {
  const handover = await db.transaction(
    'rw',
    db.plots,
    db.surveys,
    db.plantings,
    db.handoverBaselines,
    async () => {
      const plot = await db.plots.get(plotId);
      if (!plot) throw new Error('地块不存在，无法移交');
      if (plot.readOnly) throw new Error('该地块为升级补不齐的只读留底，补齐基线前不可移交');
      if (plot.state === '已移交') throw new Error('该地块已移交给养护队，不能重复移交');

      const [surveys, plantings] = await Promise.all([
        db.surveys.where('plotId').equals(plotId).toArray(),
        db.plantings.where('plotId').equals(plotId).toArray(),
      ]);
      const figures = buildBaselineFigures(plotId, surveys, plantings);
      if (figures === null) {
        throw new Error('缺少栽植记录或验收测次，无法抄出移交基线，请先补齐');
      }

      const batch = `handover-${plotId}-${Date.now().toString(36)}`;
      const stamp = nowIso();
      const projectRow: HandoverBaseline = {
        id: uuid('baseline-proj'),
        plotId,
        batch,
        side: '项目部',
        handoverDate,
        source: 'handover',
        note,
        ...figures,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await db.handoverBaselines.put(projectRow);
      // 项目部那份成活率停在移交当天那版：冻结缺株数、打移交标记
      await db.plots.update(plotId, {
        state: '已移交',
        handoverBatch: batch,
        handoverDate,
        missingCount: figures.missingCount,
        updatedAt: stamp,
      });
      return { batch, figures };
    },
  );

  // 养护侧留底：只补跑本侧，失败不回滚项目部侧
  try {
    const stamp = nowIso();
    const careRow: HandoverBaseline = {
      id: uuid('baseline-care'),
      plotId,
      batch: handover.batch,
      side: '养护队',
      handoverDate,
      source: 'handover',
      note,
      ...handover.figures,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.handoverBaselines.put(careRow);
    return { batch: handover.batch, projectWritten: true, careWritten: true };
  } catch (err) {
    return {
      batch: handover.batch,
      projectWritten: true,
      careWritten: false,
      reason: err instanceof Error ? err.message : '养护队侧留底写入失败',
    };
  }
}

/**
 * 只补跑养护队本侧留底（项目部侧已存在、养护侧缺失时使用）。
 * 两侧基线必须一致，故直接复制项目部那份数据。
 */
export async function backfillCareBaseline(plotId: string): Promise<HandoverBaseline> {
  return db.transaction('rw', db.plots, db.handoverBaselines, async () => {
    const plot = await db.plots.get(plotId);
    if (!plot) throw new Error('地块不存在');
    const project = await getHandoverCopy(plotId, '项目部');
    if (!project) throw new Error('缺少项目部侧留底，无法补跑养护侧');
    const existing = await getHandoverCopy(plotId, '养护队');
    if (existing) return existing;
    const stamp = nowIso();
    const careRow: HandoverBaseline = {
      ...project,
      id: uuid('baseline-care'),
      side: '养护队',
      source: project.source === 'migration' ? 'migration' : 'handover',
      note: project.note ? `${project.note}（养护侧补跑留底）` : '养护侧补跑留底',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.handoverBaselines.put(careRow);
    if (plot.handoverBatch === '') {
      await db.plots.update(plotId, { handoverBatch: project.batch, handoverDate: project.handoverDate });
    }
    return careRow;
  });
}

/* ------------------------------ 养护管护作业单 ------------------------------ */

export async function listCareRechecks(): Promise<CareRecheck[]> {
  const rows = await db.careRechecks.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.plotId.localeCompare(b.plotId));
}

export async function listCareRechecksByPlot(plotId: string): Promise<CareRecheck[]> {
  return db.careRechecks.where('plotId').equals(plotId).toArray();
}

/**
 * 新建养护队管护作业单（补苗上报 / 复查），按地块与养护侧基线对账。
 * 对不上 / 比基线多出的自动挂起（held）；挂起单照常留痕，但挂起期间不出补植计划。
 * @returns 实际写入后的状态
 */
export async function createCareRecheck(draft: CareRecheckDraft): Promise<CareRecheck> {
  return db.transaction('rw', db.plots, db.handoverBaselines, db.careRechecks, async () => {
    const plot = await db.plots.get(draft.plotId);
    if (!plot) throw new Error('地块不存在');
    if (plot.readOnly) throw new Error('该地块为只读留底，暂不可登记管护作业');
    const baseline = await getHandoverCopy(draft.plotId, '养护队');
    if (!baseline) throw new Error('缺少养护队侧基线留底，无法对账');

    const stamp = nowIso();
    const row: CareRecheck = {
      id: uuid('care'),
      plotId: draft.plotId,
      batch: baseline.batch,
      kind: draft.kind,
      date: draft.date,
      replantCount: Math.max(0, Math.round(draft.replantCount) || 0),
      aliveCount: Math.max(0, Math.round(draft.aliveCount) || 0),
      avgHeightCm: Math.max(0, draft.avgHeightCm || 0),
      species: draft.species,
      crew: draft.crew,
      status: 'normal',
      note: draft.note,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };

    const acceptedBefore = (await db.careRechecks.where('plotId').equals(draft.plotId).toArray())
      .filter((item) => item.status === 'normal' || item.status === 'resolved')
      .reduce((acc, item) => acc + (item.kind === '补苗' ? item.replantCount : 0), 0);
    const status = reconcileCareJob(row, baseline.missingCount, acceptedBefore);
    row.status = status === 'normal' ? 'normal' : status === 'overBaseline' ? 'overBaseline' : 'mismatch';
    await db.careRechecks.put(row);
    return row;
  });
}

/** 手动挂起复核（对不上先挂起） */
export async function holdCareRecheck(id: string, note: string): Promise<void> {
  await db.careRechecks.update(id, { status: 'held', note, updatedAt: nowIso() });
}

/** 复核放行：挂起单核对清楚后放行；补苗额自放行起计入已放行累计 */
export async function resolveCareRecheck(id: string, note: string): Promise<void> {
  await db.transaction('rw', db.handoverBaselines, db.careRechecks, async () => {
    const row = await db.careRechecks.get(id);
    if (!row) return;
    const baseline = await getHandoverCopy(row.plotId, '养护队');
    if (!baseline) throw new Error('缺少养护队侧基线留底');
    if (row.kind === '补苗') {
      const acceptedOthers = (await db.careRechecks.where('plotId').equals(row.plotId).toArray())
        .filter((item) => item.id !== id && (item.status === 'normal' || item.status === 'resolved'))
        .reduce((acc, item) => acc + (item.kind === '补苗' ? item.replantCount : 0), 0);
      if (acceptedOthers + row.replantCount > baseline.missingCount) {
        throw new Error(
          `放行后累计补苗 ${acceptedOthers + row.replantCount} 株将超过基线缺株 ${baseline.missingCount} 株，请先核减`,
        );
      }
    }
    await db.careRechecks.update(id, {
      status: 'resolved',
      note: note || row.note,
      updatedAt: nowIso(),
    });
  });
}

export async function removeCareRecheck(id: string): Promise<void> {
  await db.careRechecks.delete(id);
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  handoverBaselines: HandoverBaseline[];
  careRechecks: CareRecheck[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, handoverBaselines, careRechecks] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.handoverBaselines.toArray(),
    db.careRechecks.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    handoverBaselines,
    careRechecks,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handoverBaselines, db.careRechecks],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.handoverBaselines.clear(),
        db.careRechecks.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 旧存档（v2 以前）没有移交 / 养护表，导入空集合即可
      await db.handoverBaselines.bulkPut(
        (snapshot.handoverBaselines ?? []).map((row) => ({ ...row, revision: ROW_REVISION })),
      );
      await db.careRechecks.bulkPut((snapshot.careRechecks ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handoverBaselines, db.careRechecks],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.handoverBaselines.clear(),
        db.careRechecks.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, handoverBaselines, careRechecks] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.handoverBaselines.count(),
    db.careRechecks.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, handoverBaselines, careRechecks };
}
