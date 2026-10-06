/**
 * 修复地块（Plot）
 * 红树林修复项目的最小管理单元，按潮位带与底质区分立地条件。
 */

/** 潮位带：低 / 中 / 高 */
export type TideZone = '低' | '中' | '高';

/** 底质：淤泥质 / 砂质 / 砂泥质 */
export type Substrate = '淤泥质' | '砂质' | '砂泥质';

/** 修复方式：造林 / 补植 / 自然恢复 */
export type RestoreMode = '造林' | '补植' | '自然恢复';

/** 地块跟踪状态：跟踪中 / 已验收 */
export type PlotState = '跟踪中' | '已验收';

/**
 * 移交状态：
 * - 未移交：地块、栽植记录、验收测次归项目部维护；
 * - 已移交：项目部侧冻结（成活率停在移交当天），管护作业单归养护队；
 * - 待补录：升级时按地块状态补基线没补齐（缺栽植或验收数据），只读留着，不允许改动。
 */
export type HandoverState = '未移交' | '已移交' | '待补录';

export const TIDE_ZONE_OPTIONS: TideZone[] = ['低', '中', '高'];
export const SUBSTRATE_OPTIONS: Substrate[] = ['淤泥质', '砂质', '砂泥质'];
export const RESTORE_MODE_OPTIONS: RestoreMode[] = ['造林', '补植', '自然恢复'];
export const PLOT_STATE_OPTIONS: PlotState[] = ['跟踪中', '已验收'];
export const HANDOVER_STATE_OPTIONS: HandoverState[] = ['未移交', '已移交', '待补录'];

export interface Plot {
  id: string;
  /** 地块名 */
  name: string;
  /** 面积（亩） */
  areaMu: number;
  /** 潮位带 */
  tideZone: TideZone;
  /** 底质 */
  substrate: Substrate;
  /** 修复方式 */
  restoreMode: RestoreMode;
  /** 跟踪状态 */
  state: PlotState;
  /** 移交状态（按移交切开项目部 / 养护队职责） */
  handoverState: HandoverState;
  /** 关联的移交单 id；空串表示尚未移交 */
  handoverId: string;
  /** 缺株数（株）——补植完成后由此回写；移交后冻结为基线缺株 */
  missingCount: number;
  /** 最近一次补植/复壮回写日期 */
  lastReplantDate: string;
  createdAt: string;
  updatedAt: string;
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

/** 新建 / 编辑地块时的表单草稿 */
export interface PlotDraft {
  name: string;
  areaMu: number;
  tideZone: TideZone;
  substrate: Substrate;
  restoreMode: RestoreMode;
  state: PlotState;
}
