/**
 * 管护作业单（CareTask）
 * 地块移交后归养护队：补苗与复查都记在这里，按地块与移交基线对账。
 * 复查成活株数单独记在本表，不回写项目部的验收测次（项目部口径冻结在移交当天）。
 */

/** 作业类型：补苗 / 复查 */
export type CareKind = '补苗' | '复查';

/** 对账状态：正常 / 挂起复核（对不上或比基线多出时挂起，挂起期间不出补植计划） */
export type CareState = '正常' | '挂起复核';

export const CARE_KIND_OPTIONS: CareKind[] = ['补苗', '复查'];
export const CARE_STATE_OPTIONS: CareState[] = ['正常', '挂起复核'];

export interface CareTask {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 关联的移交单（对账基线来源） */
  handoverId: string;
  /** 作业类型 */
  kind: CareKind;
  /** 作业日期 YYYY-MM-DD */
  workDate: string;
  /** 补苗数（株）——kind = 补苗 时有效 */
  replantCount: number;
  /** 复查成活株数——kind = 复查 时有效；养护队复查单独记，不进项目部验收表 */
  recheckAliveCount: number | null;
  /** 对账状态 */
  state: CareState;
  /** 挂起原因（对账不通过时写入；复核放行后清空） */
  suspendReason: string;
  createdAt: string;
  updatedAt: string;
  /** 数据行结构修订号 */
  revision: number;
}

/** 新建管护作业单的表单草稿 */
export interface CareTaskDraft {
  plotId: string;
  kind: CareKind;
  workDate: string;
  replantCount: number;
  recheckAliveCount: number | null;
}
