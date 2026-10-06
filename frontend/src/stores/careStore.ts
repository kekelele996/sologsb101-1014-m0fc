/**
 * 管护作业单状态管理（Zustand）
 * 移交后的管护作业单归养护队：维护筛选条件与对账结果消息；
 * 写操作（含按基线对账）统一收口在 utils/db，写完后由 plotStore 的 liveQuery 回灌。
 */
import { create } from 'zustand';
import type { CareKind, CareState, CareTask, CareTaskDraft } from '../types/care';
import { createCareTaskChecked, initDatabase, releaseCareTask, removeCareTask } from '../utils/db';
import { usePlotStore } from './plotStore';

/** 管护作业单筛选条件 */
export interface CareFilters {
  plotId: string | 'all';
  kind: CareKind | 'all';
  state: CareState | 'all';
  keyword: string;
}

interface CareStoreState {
  filters: CareFilters;
  lastMessage: string;
  revision: number;
  init: () => Promise<void>;
  setFilters: (patch: Partial<CareFilters>) => void;
  resetFilters: () => void;
  /** 新建作业单并按基线对账；返回 null 表示地块未移交或养护队侧未建档 */
  createTask: (draft: CareTaskDraft) => Promise<CareTask | null>;
  /** 复核放行：人工确认后解除挂起 */
  release: (taskId: string) => Promise<void>;
  remove: (taskId: string) => Promise<void>;
  /** 只补跑养护队侧建档（项目部侧已冻结不动） */
  retryMaintenanceSide: (handoverId: string) => Promise<boolean>;
}

const EMPTY_FILTERS: CareFilters = { plotId: 'all', kind: 'all', state: 'all', keyword: '' };

export const useCareStore = create<CareStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  lastMessage: '',
  revision: 0,

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  async createTask(draft) {
    const row = await createCareTaskChecked(draft);
    if (row === null) {
      set({ lastMessage: '该地块未移交或养护队侧尚未建档，无法登记管护作业单' });
      return null;
    }
    set({
      revision: get().revision + 1,
      lastMessage:
        row.state === '挂起复核'
          ? `已登记但与基线对不上，挂起复核：${row.suspendReason}；挂起期间该地块不出补植计划`
          : '已登记，与移交基线对账一致',
    });
    return row;
  },

  async release(taskId) {
    await releaseCareTask(taskId);
    set({ revision: get().revision + 1, lastMessage: '复核通过，已解除挂起并计入已确认累计' });
  },

  async remove(taskId) {
    await removeCareTask(taskId);
    set({ revision: get().revision + 1 });
  },

  async retryMaintenanceSide(handoverId) {
    const ok = await usePlotStore.getState().retryMaintenanceSide(handoverId);
    set({
      revision: get().revision + 1,
      lastMessage: ok ? '养护队侧补跑完成，基线已建档' : '养护队侧补跑失败，请稍后再试',
    });
    return ok;
  },
}));
