/**
 * 移交单（Handover）
 * 地块验收合格后由项目部移交给养护队时生成：
 * 把移交当天的栽植总株数、成活株数、缺株数与成活率抄成基线，
 * 项目部与养护队各自留底（projectCopy / maintenanceCopy），之后各改各的口径互不影响。
 *
 * 落库分两侧独立事务：
 * - 项目部侧：冻结地块与基线（projectFrozen）
 * - 养护队侧：建立养护档案（maintenanceFiled）
 * 任一侧写不进去时只补跑本侧，另一侧的留底不动。
 */

/** 移交基线快照：移交当天抄定，之后不再随任何一侧的录入变化 */
export interface HandoverBaseline {
  /** 栽植总株数（株） */
  totalCount: number;
  /** 成活株数（株） */
  aliveCount: number;
  /** 缺株数（株） */
  missingCount: number;
  /** 移交当天成活率（%）——项目部口径，冻结 */
  survivalRate: number;
  /** 基线来源测次 id（无验收记录时为 null） */
  surveyId: string | null;
  /** 基线来源测次 */
  round: number | null;
}

export interface Handover {
  id: string;
  /** 移交地块 */
  plotId: string;
  /** 移交日期 YYYY-MM-DD */
  handoverDate: string;
  /** 项目部留底（项目部侧事务写入） */
  projectCopy: HandoverBaseline;
  /** 养护队留底（养护队侧事务写入；对账以这份为准） */
  maintenanceCopy: HandoverBaseline;
  /** 项目部侧是否已冻结 */
  projectFrozen: boolean;
  /** 养护队侧是否已建档（false 时需补跑养护队侧） */
  maintenanceFiled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 数据行结构修订号 */
  revision: number;
}

/** 由基线派生：剩余可补缺株 = 基线缺株 - 已确认补苗累计（不低于 0） */
export function baselineRemaining(baseline: HandoverBaseline, confirmedReplantTotal: number): number {
  return Math.max(0, baseline.missingCount - confirmedReplantTotal);
}
