/**
 * 养护队管护状态管理（Zustand）
 * 移交后的管护作业单（补苗上报 / 复查）在这里收口：
 * - 作业单按地块与养护侧基线对账，对不上 / 超基线自动挂起；
 * - 挂起期间不出补植计划（地块 careBlocked）；
 * - 养护侧复查单独记，不回写项目部验收。
 */
import { create } from 'zustand';
import type { CarePlotLedger, CareRecheck, CareRecheckDraft, CareReconcileStatus } from '../types/care';
import {
  createCareRecheck,
  db,
  holdCareRecheck,
  initDatabase,
  removeCareRecheck,
  resolveCareRecheck,
} from '../utils/db';
import { buildCareLedger } from '../utils/baseline';
import { usePlotStore } from './plotStore';

/** 管护作业单筛选条件 */
export interface CareFilters {
  plotId: string | 'all';
  kind: CareRecheck['kind'] | 'all';
  status: CareReconcileStatus | 'all';
  keyword: string;
}

interface CareStoreState {
  filters: CareFilters;
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<CareFilters>) => void;
  resetFilters: () => void;
  /** 登记管护作业单（自动对账，可能被挂起） */
  createJob: (draft: CareRecheckDraft) => Promise<CareRecheck>;
  holdJob: (id: string, note: string) => Promise<void>;
  resolveJob: (id: string, note: string) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  /** 某地块移交后的养护对账台账 */
  ledgerOf: (plotId: string) => CarePlotLedger | null;
}

const EMPTY_FILTERS: CareFilters = { plotId: 'all', kind: 'all', status: 'all', keyword: '' };

export const useCareStore = create<CareStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  revision: 0,
  lastMessage: '',

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

  async createJob(draft) {
    const row = await createCareRecheck(draft);
    const held = row.status === 'mismatch' || row.status === 'overBaseline';
    set({
      revision: get().revision + 1,
      lastMessage: held
        ? `作业单已登记，但${row.status === 'overBaseline' ? '累计补苗超出基线缺株数' : '数据对不上'}，已挂起复核，挂起期间不出补植计划`
        : '管护作业单已登记，与基线对账一致',
    });
    return row;
  },

  async holdJob(id, note) {
    await holdCareRecheck(id, note);
    set({ revision: get().revision + 1, lastMessage: '作业单已挂起复核，挂起期间不出补植计划' });
  },

  async resolveJob(id, note) {
    await resolveCareRecheck(id, note);
    set({ revision: get().revision + 1, lastMessage: '复核通过，作业单已放行' });
  },

  async deleteJob(id) {
    await removeCareRecheck(id);
    set({ revision: get().revision + 1 });
  },

  ledgerOf(plotId) {
    const { careRechecks, careBaselineOf } = usePlotStore.getState();
    const baseline = careBaselineOf(plotId);
    if (!baseline) return null;
    return buildCareLedger(plotId, baseline.batch, baseline, careRechecks);
  },
}));

/** 直接读库供页面 liveQuery 使用（页面用 useIdbTable 订阅，本函数仅做类型收口） */
export const careTable = db.careRechecks;
