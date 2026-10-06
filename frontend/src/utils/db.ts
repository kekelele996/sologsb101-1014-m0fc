/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3 起按「移交」切开项目部 / 养护队：新增 handovers（移交基线，两边各自留底）与
 *   careTasks（管护作业单）两张表，并按地块状态补基线，补不齐的标记「待补录」只读
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Handover } from '../types/handover';
import type { CareTask, CareTaskDraft } from '../types/care';
import { rateLevel } from './rate';
import { deriveBaseline, reconcileCareTask } from './reconcile';
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
  handovers!: Table<Handover, string>;
  careTasks!: Table<CareTask, string>;

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

    // ---------- v3：按移交切开项目部 / 养护队 ----------
    // 新增 handovers（移交基线，两边各自留底）与 careTasks（管护作业单）；
    // 已有数据没有移交标记：按地块状态补基线——「已验收」地块能推齐基线的补移交，
    // 补不齐的标记「待补录」只读留着。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, handoverState, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        handovers: 'id, plotId, handoverDate',
        careTasks: 'id, plotId, handoverId, workDate, state, kind',
      })
      .upgrade(async (tx) => {
        // 迁移 1：全部旧表行修订号对齐
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
          });
        }
        // 迁移 2：按地块状态补移交基线
        const plotRows = (await tx.table('plots').toArray()) as Array<Record<string, unknown>>;
        for (const row of plotRows) {
          if (typeof row.handoverState === 'string' && typeof row.handoverId === 'string') continue;
          const plotId = String(row.id);
          if (row.state !== '已验收') {
            await tx.table('plots').update(plotId, { handoverState: '未移交', handoverId: '' });
            continue;
          }
          const plantings = (await tx.table('plantings').where('plotId').equals(plotId).toArray()) as Planting[];
          const surveys = (await tx.table('surveys').where('plotId').equals(plotId).toArray()) as Survey[];
          const baseline = deriveBaseline(plantings, surveys);
          if (baseline === null) {
            // 基线补不齐：只读留着，等人工核对后再补录
            await tx.table('plots').update(plotId, { handoverState: '待补录', handoverId: '' });
            continue;
          }
          const stamp = nowIso();
          const handover: Handover = {
            id: uuid('handover'),
            plotId,
            handoverDate: typeof row.updatedAt === 'string' ? String(row.updatedAt).slice(0, 10) : today(),
            projectCopy: { ...baseline },
            maintenanceCopy: { ...baseline },
            projectFrozen: true,
            maintenanceFiled: true,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          };
          await tx.table('handovers').put(handover);
          await tx.table('plots').update(plotId, {
            handoverState: '已移交',
            handoverId: handover.id,
            missingCount: baseline.missingCount,
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

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划、移交单与管护作业单 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handovers, db.careTasks], async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.handovers.where('plotId').equals(id).delete();
    await db.careTasks.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
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
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 * 已移交地块：项目部口径冻结在移交当天，缺株数与验收成活率都不回写（补苗走养护队管护作业单）。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;
    if (plot.handoverState === '已移交') return;

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

/* ------------------------------ 移交（分侧落库） ------------------------------ */

export async function listHandovers(): Promise<Handover[]> {
  const rows = await db.handovers.toArray();
  return rows.sort((a, b) => a.handoverDate.localeCompare(b.handoverDate));
}

export async function getHandoverByPlot(plotId: string): Promise<Handover | undefined> {
  return db.handovers.where('plotId').equals(plotId).first();
}

/**
 * 移交 · 项目部侧（独立事务）：
 * 抄基线、写移交单（项目部留底）、冻结地块（缺株数对齐基线）。
 * 养护队侧在此刻尚未建档（maintenanceFiled = false），由 fileMaintenanceSide 补齐。
 * 幂等：已移交的地块直接返回既有移交单。
 */
export async function freezeProjectSide(plotId: string): Promise<Handover | null> {
  return db.transaction('rw', db.plots, db.plantings, db.surveys, db.handovers, async () => {
    const plot = await db.plots.get(plotId);
    if (!plot) return null;
    if (plot.handoverState === '已移交' && plot.handoverId !== '') {
      return (await db.handovers.get(plot.handoverId)) ?? null;
    }
    const plantings = await db.plantings.where('plotId').equals(plotId).toArray();
    const surveys = await db.surveys.where('plotId').equals(plotId).toArray();
    const baseline = deriveBaseline(plantings, surveys);
    if (baseline === null) return null;
    const stamp = nowIso();
    const handover: Handover = {
      id: uuid('handover'),
      plotId,
      handoverDate: today(),
      projectCopy: { ...baseline },
      maintenanceCopy: { ...baseline },
      projectFrozen: true,
      maintenanceFiled: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.handovers.put(handover);
    await db.plots.update(plotId, {
      handoverState: '已移交',
      handoverId: handover.id,
      missingCount: baseline.missingCount,
      updatedAt: stamp,
    });
    return handover;
  });
}

/**
 * 移交 · 养护队侧（独立事务，写不进去时只补跑本侧）：
 * 把项目部留底抄为养护队留底并建档。幂等：已建档直接返回 true。
 */
export async function fileMaintenanceSide(handoverId: string): Promise<boolean> {
  return db.transaction('rw', db.handovers, async () => {
    const handover = await db.handovers.get(handoverId);
    if (!handover) return false;
    if (handover.maintenanceFiled) return true;
    await db.handovers.update(handoverId, {
      maintenanceCopy: { ...handover.projectCopy },
      maintenanceFiled: true,
      updatedAt: nowIso(),
    });
    return true;
  });
}

/**
 * 一键移交：先项目部侧冻结，再养护队侧建档。
 * 养护队侧写不进去时项目部侧不回滚，返回 maintenanceOk = false，由调用方补跑本侧。
 */
export async function handoverPlot(plotId: string): Promise<{ handover: Handover | null; maintenanceOk: boolean }> {
  const handover = await freezeProjectSide(plotId);
  if (handover === null) return { handover: null, maintenanceOk: false };
  if (handover.maintenanceFiled) return { handover, maintenanceOk: true };
  try {
    const maintenanceOk = await fileMaintenanceSide(handover.id);
    return { handover, maintenanceOk };
  } catch {
    return { handover, maintenanceOk: false };
  }
}

/* ------------------------------ 管护作业单（养护队） ------------------------------ */

export async function listCareTasks(): Promise<CareTask[]> {
  const rows = await db.careTasks.toArray();
  return rows.sort((a, b) => b.workDate.localeCompare(a.workDate));
}

export async function listCareTasksByPlot(plotId: string): Promise<CareTask[]> {
  const rows = await db.careTasks.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.workDate.localeCompare(a.workDate));
}

/** 某地块已确认（正常状态）的补苗累计，用于对账 */
export async function confirmedReplantTotal(plotId: string): Promise<number> {
  const rows = await db.careTasks.where('plotId').equals(plotId).toArray();
  return rows
    .filter((row) => row.kind === '补苗' && row.state === '正常')
    .reduce((acc, row) => acc + row.replantCount, 0);
}

/**
 * 新增管护作业单并按基线对账（同一事务）：
 * 对不上或比基线多出 → 挂起复核；地块未移交或养护队侧未建档时返回 null。
 */
export async function createCareTaskChecked(draft: CareTaskDraft): Promise<CareTask | null> {
  return db.transaction('rw', db.plots, db.handovers, db.careTasks, async () => {
    const plot = await db.plots.get(draft.plotId);
    if (!plot || plot.handoverState !== '已移交' || plot.handoverId === '') return null;
    const handover = await db.handovers.get(plot.handoverId);
    if (!handover || !handover.maintenanceFiled) return null;
    const confirmed = await confirmedReplantTotal(plot.id);
    const check = reconcileCareTask(handover.maintenanceCopy, confirmed, draft);
    const stamp = nowIso();
    const row: CareTask = {
      id: uuid('care'),
      plotId: plot.id,
      handoverId: handover.id,
      kind: draft.kind,
      workDate: draft.workDate,
      replantCount: draft.kind === '补苗' ? draft.replantCount : 0,
      recheckAliveCount: draft.kind === '复查' ? draft.recheckAliveCount : null,
      state: check.ok ? '正常' : '挂起复核',
      suspendReason: check.reason,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.careTasks.put(row);
    return row;
  });
}

/** 复核放行：人工确认后解除挂起，该笔计入已确认累计 */
export async function releaseCareTask(id: string): Promise<void> {
  await db.careTasks.update(id, { state: '正常', suspendReason: '', updatedAt: nowIso() });
}

export async function removeCareTask(id: string): Promise<void> {
  await db.careTasks.delete(id);
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
  handovers: Handover[];
  careTasks: CareTask[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, handovers, careTasks] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.handovers.toArray(),
    db.careTasks.toArray(),
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
    handovers,
    careTasks,
  };
}

/**
 * 旧存档规范化：没有移交标记的地块按状态补基线（与 v3 迁移同口径），
 * 补不齐的标记「待补录」只读；返回规范化后的地块与需补建的移交单。
 */
function normalizeSnapshotHandover(
  plots: Plot[],
  plantings: Planting[],
  surveys: Survey[],
): { plots: Plot[]; handovers: Handover[] } {
  const extraHandovers: Handover[] = [];
  const nextPlots = plots.map((plot) => {
    if (typeof plot.handoverState === 'string' && typeof plot.handoverId === 'string') return plot;
    if (plot.state !== '已验收') return { ...plot, handoverState: '未移交' as const, handoverId: '' };
    const baseline = deriveBaseline(
      plantings.filter((row) => row.plotId === plot.id),
      surveys.filter((row) => row.plotId === plot.id),
    );
    if (baseline === null) return { ...plot, handoverState: '待补录' as const, handoverId: '' };
    const stamp = nowIso();
    const handover: Handover = {
      id: uuid('handover'),
      plotId: plot.id,
      handoverDate: today(),
      projectCopy: { ...baseline },
      maintenanceCopy: { ...baseline },
      projectFrozen: true,
      maintenanceFiled: true,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    extraHandovers.push(handover);
    return {
      ...plot,
      handoverState: '已移交' as const,
      handoverId: handover.id,
      missingCount: baseline.missingCount,
    };
  });
  return { plots: nextPlots, handovers: extraHandovers };
}

/** 用快照覆盖整库（导入存档）；兼容没有移交表与移交标记的旧存档 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const normalized = normalizeSnapshotHandover(snapshot.plots, snapshot.plantings, snapshot.surveys);
  const handovers = [...(snapshot.handovers ?? []), ...normalized.handovers];
  const careTasks = snapshot.careTasks ?? [];
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handovers, db.careTasks], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.handovers.clear(),
      db.careTasks.clear(),
    ]);
    await db.plots.bulkPut(normalized.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.handovers.bulkPut(handovers.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.careTasks.bulkPut(careTasks.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handovers, db.careTasks], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.handovers.clear(),
      db.careTasks.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, handovers, careTasks] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.handovers.count(),
    db.careTasks.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, handovers, careTasks };
}
