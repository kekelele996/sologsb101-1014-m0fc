/**
 * 移交基线（HandoverBaseline）
 * 地块验收合格、移交给养护队时，把移交当天的栽植总株数 / 成活株数 / 缺株数
 * 抄成基线留底。同一次移交按归属侧（项目部 / 养护队）各存一条，两边各自留底：
 * - 项目部那份成活率停在移交当天，不再随养护复查变化；
 * - 养护队那份作为补苗数与复查对账的依据；
 * - 任一侧写入失败都不回滚另一侧，养护侧缺失时只允许「只补跑本侧」。
 */

/** 归属侧：项目部（移交前数据）/ 养护队（移交后管护） */
export type HandoverSide = '项目部' | '养护队';

/** 基线来源：现场移交动作 / 旧数据升级时按地块状态补建 */
export type HandoverSource = 'handover' | 'migration';

export const HANDOVER_SIDE_OPTIONS: HandoverSide[] = ['项目部', '养护队'];

/** 某次移交的批次号（两条本侧记录共享同一批次号，便于对账） */
export type HandoverBatch = string;

/** 移交时抄底的三项核心数据，两边各留一份 */
export interface BaselineFigures {
  /** 栽植总株数（株） */
  totalCount: number;
  /** 移交当天最新测次的成活株数（株） */
  aliveCount: number;
  /** 缺株数（株）= 栽植总株数 - 成活株数 */
  missingCount: number;
  /** 移交当天那版成活率（%，保留 1 位小数）——项目部那份就此冻结 */
  survivalRate: number;
  /** 作为基线的验收测次 */
  surveyRound: number;
}

export interface HandoverBaseline extends BaselineFigures {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 移交批次号：同一次移交的项目部 / 养护队两条记录一致 */
  batch: HandoverBatch;
  /** 该条留底归属哪一侧 */
  side: HandoverSide;
  /** 移交日期 YYYY-MM-DD */
  handoverDate: string;
  /** 基线来源：现场移交 / 升级补建 */
  source: HandoverSource;
  /** 备注，如升级时补不齐的说明或补跑原因 */
  note: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 移交时需要确认的表单草稿 */
export interface HandoverDraft {
  handoverDate: string;
  note: string;
}

/** 两侧留底是否齐全（用于「只补跑本侧」提示与对账） */
export interface HandoverCopies {
  batch: HandoverBatch | null;
  project?: HandoverBaseline;
  care?: HandoverBaseline;
  /** 养护侧是否缺留底（项目部侧存在、养护侧缺失时可补跑） */
  careMissing: boolean;
}
