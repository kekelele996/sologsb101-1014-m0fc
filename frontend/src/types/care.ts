/**
 * 养护复查（CareRecheck）
 * 移交后的地块归养护队管护：复查单独记，不再回写项目部的验收记录。
 * 每条补苗上报与复查都按地块与移交基线对账：
 * - 补苗数对不上基线缺株数、或累计补苗超过基线缺株数时，先挂起复核；
 * - 挂起期间不出补植计划。
 */
import type { SeedlingSpecies } from './seedling';

/** 管护作业类型：补苗（老缺株补植）/ 复查（移交后成活率复查） */
export type CareTaskKind = '补苗' | '复查';

/** 对账结论 */
export type CareReconcileStatus =
  | 'normal' // 与基线一致
  | 'mismatch' // 对不上：本单补苗数与基线/上报不符
  | 'overBaseline' // 比基线多出：累计补苗超过基线缺株数
  | 'held' // 已挂起复核
  | 'resolved'; // 挂起后复核通过

export const CARE_TASK_KIND_OPTIONS: CareTaskKind[] = ['补苗', '复查'];

export const CARE_RECONCILE_LABEL: Record<CareReconcileStatus, string> = {
  normal: '对账一致',
  mismatch: '对不上',
  overBaseline: '超出基线',
  held: '挂起复核中',
  resolved: '复核已放行',
};

export interface CareRecheck {
  id: string;
  /** 所属地块（必须已移交、存在养护侧基线） */
  plotId: string;
  /** 对账所用的移交批次号 */
  batch: string;
  /** 作业类型 */
  kind: CareTaskKind;
  /** 作业日期 YYYY-MM-DD */
  date: string;
  /** 本次上报补苗数（株）；复查单可为 0 */
  replantCount: number;
  /** 复查成活株数（株）——养护侧单独记录，不回写项目部验收；补苗单可为 0 */
  aliveCount: number;
  /** 复查平均株高（厘米），可空 */
  avgHeightCm: number;
  /** 补植树种 */
  species: SeedlingSpecies;
  /** 作业班组 */
  crew: string;
  /** 对账状态 */
  status: CareReconcileStatus;
  /** 挂起 / 复核说明 */
  note: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建管护作业单的表单草稿 */
export interface CareRecheckDraft {
  plotId: string;
  kind: CareTaskKind;
  date: string;
  replantCount: number;
  aliveCount: number;
  avgHeightCm: number;
  species: SeedlingSpecies;
  crew: string;
  note: string;
}

/** 某地块移交后的养护侧累计对账汇总 */
export interface CarePlotLedger {
  plotId: string;
  batch: string;
  /** 基线缺株数 */
  baselineMissing: number;
  /** 基线成活株数 */
  baselineAlive: number;
  /** 基线栽植总株数 */
  baselineTotal: number;
  /** 已挂起（未放行）的作业单数 */
  heldCount: number;
  /** 已放行/正常的累计补苗数 */
  acceptedReplant: number;
  /** 挂起单上的待核补苗数（不计入已放行累计） */
  pendingReplant: number;
  /** 最近一次复查的成活株数（养护侧单独记） */
  latestRecheckAlive: number | null;
  /** 是否存在挂起单——挂起期间不出补植计划 */
  blocked: boolean;
}
