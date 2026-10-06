import 'fake-indexeddb/auto';
import Dexie from 'dexie';

// 用 v2 结构建库并灌入「旧数据」（没有任何移交标记），再用当前 db 打开触发升级
async function seedV2(): Promise<void> {
  const legacy = new Dexie('gbmangrove');
  legacy.version(1).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
    seedlings: 'id, plotId, species, source, arrivalDate',
    plantings: 'id, plotId, seedlingId, plantDate',
    surveys: 'id, plotId, round, date',
    replants: 'id, plotId, planDate, state',
  });
  legacy.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });

  const stamp = '2025-01-01T00:00:00.000Z';
  // 地块 P1：已验收且数据齐全 → 应补两侧基线并转「已移交」
  // 地块 P2：已验收但缺验收记录 → 补不齐，应只读留底
  // 地块 P3：跟踪中 → 不动
  await legacy.table('plots').bulkPut([
    {
      id: 'P1', name: '齐整地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林',
      state: '已验收', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2,
    },
    {
      id: 'P2', name: '缺验收地块', areaMu: 10, tideZone: '低', substrate: '砂质', restoreMode: '造林',
      state: '已验收', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2,
    },
    {
      id: 'P3', name: '跟踪中地块', areaMu: 10, tideZone: '高', substrate: '砂泥质', restoreMode: '补植',
      state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2,
    },
  ]);
  await legacy.table('plantings').bulkPut([
    { id: 'pl1', plotId: 'P1', seedlingId: 's1', plantDate: '2024-04-01', spacingM: 1, count: 1000, operator: '一班', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'pl2', plotId: 'P2', seedlingId: 's2', plantDate: '2024-04-01', spacingM: 1, count: 500, operator: '一班', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await legacy.table('surveys').bulkPut([
    { id: 'sv1', plotId: 'P1', round: 1, date: '2024-06-01', aliveCount: 900, avgHeightCm: 50, survivalRate: 90, grade: 'excellent', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  // P1 有一条「待补植」旧计划，升级后已移交应被置为已复核（挂起留档，不再出计划）
  // P2 是只读留底地块，它的待补植计划不应被改动
  await legacy.table('replants').bulkPut([
    { id: 'rp1', plotId: 'P1', missingCount: 100, planDate: '2024-09-01', species: '秋茄', state: '待补植', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'rp2', plotId: 'P2', missingCount: 50, planDate: '2024-09-01', species: '秋茄', state: '待补植', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await legacy.close();
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  await seedV2();

  // 用当前（v3）db 打开，触发 .upgrade()
  const { db } = await import('../src/utils/db');
  await db.open();

  const p1 = await db.plots.get('P1');
  const p2 = await db.plots.get('P2');
  const p3 = await db.plots.get('P3');
  assert(p1!.state === '已移交', '升级：齐整的已验收地块 → 已移交');
  assert(p1!.handoverBatch.startsWith('handover-mig-P1'), '升级：补建批次号');
  assert(p1!.missingCount === 100, '升级：缺株冻结 1000-900=100');
  assert(p1!.readOnly === false, '升级：齐整地块非只读');

  const p1proj = await db.handoverBaselines.where('[plotId+side]').equals(['P1', '项目部'] as unknown as [string, string]).toArray();
  const p1care = await db.handoverBaselines.where('[plotId+side]').equals(['P1', '养护队'] as unknown as [string, string]).toArray();
  assert(p1proj.length === 1 && p1care.length === 1, '升级：P1 两侧基线补齐');
  assert(p1proj[0].totalCount === 1000 && p1proj[0].aliveCount === 900, '升级：基线数字 1000/900');
  assert(p1proj[0].source === 'migration' && p1care[0].source === 'migration', '升级：来源标记 migration');

  assert(p2!.state === '已验收' && p2!.readOnly === true, '升级：补不齐的已验收地块只读留底，状态不转已移交');
  const p2base = await db.handoverBaselines.where('plotId').equals('P2').toArray();
  assert(p2base.length === 0, '升级：P2 不补基线（先只读留着）');

  assert(p3!.state === '跟踪中' && !p3!.readOnly, '升级：跟踪中地块不动');

  const rp1 = await db.replants.get('rp1');
  assert(rp1!.state === '已复核', '升级：已移交地块的待补植旧计划置为已复核留档');
  const rp2 = await db.replants.get('rp2');
  assert(rp2!.state === '待补植', '升级：只读留底地块的补植计划原样保留，不误改');

  // 只读地块不能登记养护作业
  let threw = false;
  try {
    const { createCareRecheck } = await import('../src/utils/db');
    await createCareRecheck({
      plotId: 'P2', kind: '补苗', date: '2025-10-01', replantCount: 10, aliveCount: 0,
      avgHeightCm: 0, species: '秋茄', crew: 'x', note: '',
    });
  } catch {
    threw = true;
  }
  assert(threw, '只读留底地块不可登记管护作业');

  console.log('\n迁移断言全部通过 ✅');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
