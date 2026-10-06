/**
 * 移交基线对账（纯函数）
 * - 由栽植记录与验收测次推移交基线
 * - 养护队补苗 / 复查与基线按地块对账：对不上或比基线多出 → 挂起复核
 * 不触碰 IndexedDB，便于迁移、导入与页面共用同一口径。
 */
import type { HandoverBaseline } from '../types/handover';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { CareKind } from '../types/care';
import { calcSurvivalRate } from './rate';

/**
 * 由栽植记录与验收测次推移交基线。
 * 栽植总株数 ≤ 0 或没有任何验收测次时返回 null（基线补不齐，调用方按「待补录」只读处理）。
 */
export function deriveBaseline(plantings: Planting[], surveys: Survey[]): HandoverBaseline | null {
  const totalCount = plantings.reduce((acc, row) => acc + row.count, 0);
  if (totalCount <= 0 || surveys.length === 0) return null;
  const latest = surveys.reduce((acc, row) => (row.round > acc.round ? row : acc));
  const aliveCount = latest.aliveCount;
  return {
    totalCount,
    aliveCount,
    missingCount: Math.max(0, totalCount - aliveCount),
    survivalRate: calcSurvivalRate(aliveCount, totalCount),
    surveyId: latest.id,
    round: latest.round,
  };
}

/** 对账结果：ok = false 时 reason 为挂起原因 */
export interface ReconcileResult {
  ok: boolean;
  reason: string;
}

/** 待对账的作业内容 */
export interface CareReconcileInput {
  kind: CareKind;
  replantCount: number;
  recheckAliveCount: number | null;
}

const OK: ReconcileResult = { ok: true, reason: '' };

/**
 * 养护队作业单 vs 移交基线（按地块）：
 * - 补苗：本笔 + 已确认补苗累计 超过基线缺株 → 比基线多出，挂起；非正数 → 对不上，挂起；
 * - 复查：成活株数缺失 / 超过基线栽植总株数 → 对不上，挂起；
 *         比「基线成活 + 已确认补苗累计」还多 → 比基线多出，挂起。
 */
export function reconcileCareTask(
  baseline: HandoverBaseline,
  confirmedReplantTotal: number,
  input: CareReconcileInput,
): ReconcileResult {
  if (input.kind === '补苗') {
    if (!Number.isFinite(input.replantCount) || input.replantCount <= 0) {
      return { ok: false, reason: '补苗数不是正数，与基线对不上' };
    }
    const remaining = Math.max(0, baseline.missingCount - confirmedReplantTotal);
    if (input.replantCount > remaining) {
      return {
        ok: false,
        reason: `补苗 ${input.replantCount} 株比基线多出：基线缺株 ${baseline.missingCount} 株，已确认补苗 ${confirmedReplantTotal} 株，剩余可补 ${remaining} 株`,
      };
    }
    return OK;
  }

  const recheck = input.recheckAliveCount;
  if (recheck === null || !Number.isFinite(recheck) || recheck < 0) {
    return { ok: false, reason: '复查成活株数缺失，与基线对不上' };
  }
  if (recheck > baseline.totalCount) {
    return {
      ok: false,
      reason: `复查成活 ${recheck} 株超过基线栽植总株数 ${baseline.totalCount} 株，与基线对不上`,
    };
  }
  const expectedMax = baseline.aliveCount + confirmedReplantTotal;
  if (recheck > expectedMax) {
    return {
      ok: false,
      reason: `复查成活 ${recheck} 株比基线多出：基线成活 ${baseline.aliveCount} 株 + 已确认补苗 ${confirmedReplantTotal} 株 = ${expectedMax} 株`,
    };
  }
  return OK;
}
