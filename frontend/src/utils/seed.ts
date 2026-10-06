/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 → 验收 → 补植
 * v3 起额外演示「按移交切开」：北屿外滩 B 区已移交，两侧基线留底 + 养护队管护作业单
 * （含一条超出基线缺株数、被挂起复核的补苗单）。
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { HandoverBaseline } from '../types/handover';
import type { CareRecheck } from '../types/care';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
} as const;

/** 北屿外滩 B 区的移交批次（固定，方便演示两侧留底与养护对账） */
export const SEED_HANDOVER_C = 'handover-beiyu-b-seed';

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision'>): Planting {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function surveyRow(row: Omit<Survey, 'createdAt' | 'updatedAt' | 'revision' | 'grade' | 'gradeManual' | 'survivalRate'>, total: number): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function baselineRow(row: Omit<HandoverBaseline, 'createdAt' | 'updatedAt' | 'revision'>): HandoverBaseline {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function careRow(row: Omit<CareRecheck, 'createdAt' | 'updatedAt' | 'revision'>): CareRecheck {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 地块（3 块，覆盖三种潮位带与三种底质；C 已移交） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      handoverBatch: '',
      handoverDate: '',
      readOnly: false,
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      handoverBatch: '',
      handoverDate: '',
      readOnly: false,
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已移交',
      handoverBatch: SEED_HANDOVER_C,
      handoverDate: '2024-09-02',
      readOnly: false,
      // 移交后缺株数冻结为基线值 560（8000 - 7440），不随养护补苗回写
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),
  ];

  // ---------------- 苗木批次（每地块 2 批） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16' }),
  ];

  // ---------------- 栽植记录（每地块 2 条，引用真实苗木批次） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1500, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 3300,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收记录（每地块 2–3 个测次；C 的测次停在移交当天） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2772, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2112, avgHeightCm: 55 }, totalByPlot[SEED_IDS.plotB]),
    // 北屿外滩 B 区：第 2 测次即移交当天那版，项目部成活率就此冻结
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),
  ];

  // ---------------- 补植计划（未移交地块；C 的移交后遗留单已复核留档） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 1188, planDate: '2025-04-18', species: '白骨壤', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

  // ---------------- 移交基线（C 地块两侧各留一份，数据一致） ----------------
  // 移交当天：栽植 8000 / 成活 7440 / 缺株 560 / 成活率 93.0% / 第 2 测次
  const handoverBaselines: HandoverBaseline[] = [
    baselineRow({
      id: 'baseline-c-project',
      plotId: SEED_IDS.plotC,
      batch: SEED_HANDOVER_C,
      side: '项目部',
      handoverDate: '2024-09-02',
      source: 'handover',
      note: '移交当天基线留底（项目部），成活率停在此版',
      totalCount: 8000,
      aliveCount: 7440,
      missingCount: 560,
      survivalRate: 93.0,
      surveyRound: 2,
    }),
    baselineRow({
      id: 'baseline-c-care',
      plotId: SEED_IDS.plotC,
      batch: SEED_HANDOVER_C,
      side: '养护队',
      handoverDate: '2024-09-02',
      source: 'handover',
      note: '移交当天基线留底（养护队），补苗与复查按此对账',
      totalCount: 8000,
      aliveCount: 7440,
      missingCount: 560,
      survivalRate: 93.0,
      surveyRound: 2,
    }),
  ];

  // ---------------- 养护队管护作业单（补苗上报 / 复查，单独记） ----------------
  const careRechecks: CareRecheck[] = [
    // 第一批补苗 400 株：在基线缺株 560 内，对账一致
    careRow({
      id: 'care-c-replant-1',
      plotId: SEED_IDS.plotC,
      batch: SEED_HANDOVER_C,
      kind: '补苗',
      date: '2024-09-20',
      replantCount: 400,
      aliveCount: 0,
      avgHeightCm: 0,
      species: '无瓣海桑',
      crew: '养护一班',
      status: 'normal',
      note: '按移交基线缺株补第一批',
    }),
    // 移交后复查：成活株数单独记（7440 + 400 已成活），不回写项目部验收
    careRow({
      id: 'care-c-recheck-1',
      plotId: SEED_IDS.plotC,
      batch: SEED_HANDOVER_C,
      kind: '复查',
      date: '2024-12-10',
      replantCount: 0,
      aliveCount: 7840,
      avgHeightCm: 102,
      species: '无瓣海桑',
      crew: '养护一班',
      status: 'normal',
      note: '移交后首次复查，与基线口径一致',
    }),
    // 第二批补苗报 200 株：已放行 400 + 200 = 600 > 基线缺株 560，比基线多出，挂起复核
    careRow({
      id: 'care-c-replant-2',
      plotId: SEED_IDS.plotC,
      batch: SEED_HANDOVER_C,
      kind: '补苗',
      date: '2025-03-05',
      replantCount: 200,
      aliveCount: 0,
      avgHeightCm: 0,
      species: '白骨壤',
      crew: '养护二班',
      status: 'overBaseline',
      note: '累计补苗将达 600 株，超过基线缺株 560 株，挂起复核，暂缓出补植计划',
    }),
  ];

  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.handoverBaselines, db.careRechecks],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
      await db.handoverBaselines.bulkPut(handoverBaselines);
      await db.careRechecks.bulkPut(careRechecks);
    },
  );
}
