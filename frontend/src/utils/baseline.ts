/**
 * 移交基线与养护对账（纯函数）
 * 口径集中在这里，供 db 层、store、页面复用，避免「项目部成活率」与「养护队对账」两边口径漂移：
 * - 移交基线三要素：栽植总株数 / 成活株数 / 缺株数；
 * - 项目部那份成活率停在移交当天那版；
 * - 养护队的补苗上报、复查都按地块与基线对账，对不上 / 超基线先挂起。
 */
import type { Plot } from '../types/plot';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { CarePlotLedger, CareRecheck, CareReconcileStatus } from '../types/care';
import type { BaselineFigures } from '../types/handover';
import { calcSurvivalRate } from './rate';

/** 移交当天的基线三要素，取地块最新一个验收测次 */
export function buildBaselineFigures(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
): BaselineFigures | null {
  const totalCount = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
  const plotSurveys = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round);
  const latest = plotSurveys.length > 0 ? plotSurveys[plotSurveys.length - 1] : null;
  if (totalCount <= 0 || latest === null) return null;
  const aliveCount = latest.aliveCount;
  const missingCount = Math.max(0, totalCount - aliveCount);
  return {
    totalCount,
    aliveCount,
    missingCount,
    survivalRate: calcSurvivalRate(aliveCount, totalCount),
    surveyRound: latest.round,
  };
}

/** 地块是否已移交（只有已移交地块才走养护对账） */
export function isHandedOver(plot: Plot | undefined): boolean {
  return plot !== undefined && plot.state === '已移交' && plot.handoverBatch !== '';
}

/** 只读留底：升级时补不齐基线的已移交地块 */
export function isReadOnlyLegacy(plot: Plot | undefined): boolean {
  return plot !== undefined && plot.readOnly === true;
}

/**
 * 单条养护作业单的对账结论（不含写库）。
 * @param acceptedBefore 本单之前该地块已放行（normal/resolved）的累计补苗数
 */
export function reconcileCareJob(job: CareRecheck, baselineMissing: number, acceptedBefore: number): CareReconcileStatus {
  if (job.kind === '补苗') {
    if (!Number.isFinite(job.replantCount) || job.replantCount <= 0) return 'mismatch';
    // 累计补苗超过基线缺株数：比基线多出
    if (acceptedBefore + job.replantCount > baselineMissing) return 'overBaseline';
    return 'normal';
  }
  // 复查单：不涉及补苗额，成活株数为非负即视为一致；异常由人工挂起/放行
  if (!Number.isFinite(job.aliveCount) || job.aliveCount < 0) return 'mismatch';
  return 'normal';
}

/** 汇总某地块移交后的养护对账台账 */
export function buildCareLedger(plotId: string, batch: string, baseline: BaselineFigures, jobs: CareRecheck[]): CarePlotLedger {
  const plotJobs = jobs.filter((row) => row.plotId === plotId);
  const held = plotJobs.filter((row) => row.status === 'held' || row.status === 'mismatch' || row.status === 'overBaseline');
  const accepted = plotJobs
    .filter((row) => row.status === 'normal' || row.status === 'resolved')
    .reduce((acc, row) => acc + (row.kind === '补苗' ? row.replantCount : 0), 0);
  const pending = plotJobs
    .filter((row) => row.status === 'held' || row.status === 'mismatch' || row.status === 'overBaseline')
    .reduce((acc, row) => acc + (row.kind === '补苗' ? row.replantCount : 0), 0);
  const rechecks = plotJobs
    .filter((row) => row.kind === '复查')
    .sort((a, b) => a.date.localeCompare(b.date));
  const latestRecheck = rechecks.length > 0 ? rechecks[rechecks.length - 1] : null;
  return {
    plotId,
    batch,
    baselineMissing: baseline.missingCount,
    baselineAlive: baseline.aliveCount,
    baselineTotal: baseline.totalCount,
    heldCount: held.length,
    acceptedReplant: accepted,
    pendingReplant: pending,
    latestRecheckAlive: latestRecheck ? latestRecheck.aliveCount : null,
    blocked: held.length > 0,
  };
}

/** 对账状态对应的标签颜色，供页面与导出统一 */
export function reconcileStatusColor(status: CareReconcileStatus): string {
  switch (status) {
    case 'normal':
      return 'green';
    case 'resolved':
      return 'cyan';
    case 'mismatch':
      return 'volcano';
    case 'overBaseline':
      return 'red';
    case 'held':
    default:
      return 'orange';
  }
}
