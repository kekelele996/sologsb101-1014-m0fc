import 'fake-indexeddb/auto';
import {
  db,
  initDatabase,
  performHandover,
  backfillCareBaseline,
  createCareRecheck,
  holdCareRecheck,
  resolveCareRecheck,
  getHandoverCopy,
  resetDatabase,
} from '../src/utils/db';
import { seedDatabase } from '../src/utils/seed';
import { buildBaselineFigures, buildCareLedger } from '../src/utils/baseline';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  // ---------- 场景 1：空库播种后，验证移交 / 冻结 / 对账主流程 ----------
  await initDatabase();
  await seedDatabase();

  const plotA = await db.plots.get('plot-donggang-3');
  const plotC = await db.plots.get('plot-beiyu-b');
  assert(plotA!.state === '跟踪中', '播种：东港地块跟踪中');
  assert(plotC!.state === '已移交', '播种：北屿地块已移交');

  // 移交前基线数字
  const surveys = await db.surveys.toArray();
  const plantings = await db.plantings.toArray();
  const figures = buildBaselineFigures('plot-donggang-3', surveys, plantings);
  assert(figures !== null && figures.totalCount === 5200, '基线：东港栽植 5200');
  assert(figures!.aliveCount === 4108, '基线：东港最新成活 4108');
  assert(figures!.missingCount === 1092, '基线：东港缺株 1092');

  // 执行移交
  const res = await performHandover('plot-donggang-3', '2025-10-01', '验收合格移交');
  assert(res.projectWritten && res.careWritten, '移交：两侧留底都写入');
  const proj = await getHandoverCopy('plot-donggang-3', '项目部');
  const care = await getHandoverCopy('plot-donggang-3', '养护队');
  assert(proj !== undefined && care !== undefined, '移交：两侧记录可查');
  assert(proj!.batch === care!.batch && proj!.batch === res.batch, '移交：两侧同一批次号');
  assert(proj!.missingCount === care!.missingCount && proj!.missingCount === 1092, '移交：两侧缺株一致 1092');
  const after = await db.plots.get('plot-donggang-3');
  assert(after!.state === '已移交' && after!.handoverBatch !== '', '移交：地块标记已移交');
  assert(after!.missingCount === 1092, '移交：地块缺株冻结为基线值');

  // 重复移交应失败
  let threw = false;
  try {
    await performHandover('plot-donggang-3', '2025-10-02', '');
  } catch {
    threw = true;
  }
  assert(threw, '移交：不能重复移交');

  // ---------- 场景 2：养护队对账 ----------
  // 基线缺株 1092：补 1000 正常
  const j1 = await createCareRecheck({
    plotId: 'plot-donggang-3',
    kind: '补苗',
    date: '2025-10-10',
    replantCount: 1000,
    aliveCount: 0,
    avgHeightCm: 0,
    species: '秋茄',
    crew: '养护一班',
    note: '',
  });
  assert(j1.status === 'normal', '对账：补苗 1000（≤1092）一致');

  // 复查单独记
  const r1 = await createCareRecheck({
    plotId: 'plot-donggang-3',
    kind: '复查',
    date: '2025-11-01',
    replantCount: 0,
    aliveCount: 5100,
    avgHeightCm: 100,
    species: '秋茄',
    crew: '养护一班',
    note: '',
  });
  assert(r1.status === 'normal', '对账：复查单一致');

  // 再补 200 → 累计 1200 > 1092 超基线挂起
  const j2 = await createCareRecheck({
    plotId: 'plot-donggang-3',
    kind: '补苗',
    date: '2025-11-05',
    replantCount: 200,
    aliveCount: 0,
    avgHeightCm: 0,
    species: '秋茄',
    crew: '养护二班',
    note: '',
  });
  assert(j2.status === 'overBaseline', '对账：累计 1200 超基线 1092，标记超基线');

  // 挂起台账 blocked
  let careJobs = await db.careRechecks.where('plotId').equals('plot-donggang-3').toArray();
  let ledger = buildCareLedger('plot-donggang-3', proj!.batch, proj!, careJobs);
  assert(ledger.blocked === true, '台账：存在超基线条目 → blocked（不出补植计划）');
  assert(ledger.acceptedReplant === 1000, '台账：已放行补苗 1000');
  assert(ledger.pendingReplant === 200, '台账：挂起待核 200');
  assert(ledger.latestRecheckAlive === 5100, '台账：最近复查成活 5100（养护侧单独记）');

  // 超基线放行应被拒（放行后 1200 > 1092）
  threw = false;
  try {
    await resolveCareRecheck(j2.id, '');
  } catch {
    threw = true;
  }
  assert(threw, '复核：超基线条目不能直接放行');

  // 改成挂起→核减为 92 后放行：先 hold 再更新数量，再放行（模拟人工核减后重报）
  await holdCareRecheck(j2.id, '人工核减');
  // 直接把该单补苗数核减到 92（1000+92=1092）
  await db.careRechecks.update(j2.id, { replantCount: 92 });
  await resolveCareRecheck(j2.id, '核减后放行');
  const j2again = await db.careRechecks.get(j2.id);
  assert(j2again!.status === 'resolved', '复核：核减到 92（累计 1092）可放行');
  careJobs = await db.careRechecks.where('plotId').equals('plot-donggang-3').toArray();
  ledger = buildCareLedger('plot-donggang-3', proj!.batch, proj!, careJobs);
  assert(ledger.blocked === false, '台账：挂起清空后不再 blocked');
  assert(ledger.acceptedReplant === 1092, '台账：放行累计恰好等于基线缺株 1092');

  // 项目部成活率没被养护作业影响
  const plotASurveys = surveys.filter((s) => s.plotId === 'plot-donggang-3');
  const latestProj = plotASurveys.sort((a, b) => b.round - a.round)[0];
  assert(latestProj.aliveCount === 4108, '冻结：项目部最新验收成活仍为 4108，未被养护复查改写');

  // ---------- 场景 3：只补跑养护侧 ----------
  // 手工删掉东港养护侧留底，模拟「养护侧写不进去」
  await db.careRechecks.where('plotId').equals('plot-donggang-3').delete();
  const careCopy = await getHandoverCopy('plot-donggang-3', '养护队');
  await db.handoverBaselines.delete(careCopy!.id);
  assert((await getHandoverCopy('plot-donggang-3', '养护队')) === undefined, '补跑：养护侧已删除');
  const backfilled = await backfillCareBaseline('plot-donggang-3');
  assert(backfilled.side === '养护队' && backfilled.missingCount === 1092, '补跑：只补跑养护侧且数据与项目部一致');
  // 再次补跑应幂等
  const again = await backfillCareBaseline('plot-donggang-3');
  assert(again.id === backfilled.id, '补跑：重复补跑幂等');

  console.log('\n所有运行时断言通过 ✅');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
