/**
 * 地块状态管理（Zustand）
 * 维护地块列表、当前选中地块、筛选条件与地块级派生统计；
 * 所有写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Plot, PlotDraft, Substrate, TideZone } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, RateLevel } from '../types/survey';
import type { HandoverBaseline } from '../types/handover';
import type { CareRecheck } from '../types/care';
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  backfillCareBaseline,
  countAll,
  db,
  initDatabase,
  performHandover,
  putPlot,
  removePlot,
} from '../utils/db';
import { buildSurvivalSummary, type SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, uuid } from '../utils/id';

/** 地块筛选条件（关键字 + 潮位带 + 底质），由 <FilterBar> 同步到 URL query */
export interface PlotFilters {
  keyword: string;
  tideZone: TideZone | 'all';
  substrate: Substrate | 'all';
}

/** 单个地块的派生统计，供地块台账与补植计划页复用 */
export interface PlotStat {
  plotId: string;
  /** 苗木批次数 */
  seedlingCount: number;
  /** 进场苗木合计（株） */
  seedlingQuantity: number;
  /** 栽植总株数（株） */
  plantTotal: number;
  /** 验收测次数（项目部口径，移交后停在移交当天那版） */
  surveyCount: number;
  /** 最新成活率（%）；已移交地块为移交当天冻结值 */
  latestRate: number;
  /** 最新等级 */
  level: RateLevel;
  /** 成活率环比变化（百分点） */
  trend: number;
  /** 建议补植株数；已移交地块归养护队对账，恒为 0 */
  suggestReplant: number;
  /** 是否已移交养护队 */
  handedOver: boolean;
  /** 是否为升级补不齐基线的只读留底 */
  readOnly: boolean;
  /** 养护侧基线留底是否缺失（可只补跑本侧） */
  careBaselineMissing: boolean;
  /** 移交日期 YYYY-MM-DD */
  handoverDate: string;
  /** 该地块是否有挂起中的养护作业单（挂起期间不出补植计划） */
  careBlocked: boolean;
}

const EMPTY_FILTERS: PlotFilters = { keyword: '', tideZone: 'all', substrate: 'all' };
const CURRENT_PLOT_KEY = 'gbmangrove:currentPlotId';

function readCurrentPlotId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PLOT_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function writeCurrentPlotId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PLOT_KEY, id ?? '');
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

interface PlotStoreState {
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  /** 全部移交基线留底（项目部 + 养护队两侧） */
  baselines: HandoverBaseline[];
  /** 养护队管护作业单，用于派生各地块的挂起状态 */
  careRechecks: CareRecheck[];
  currentPlotId: string | null;
  loading: boolean;
  ready: boolean;
  error: string;
  filters: PlotFilters;
  counts: Record<string, number>;
  stats: Record<string, PlotStat>;
  summaries: Record<string, SurvivalSummary>;
  /** 订阅 Dexie 并载入全部派生数据（幂等，可重复调用） */
  loadAll: () => Promise<void>;
  selectPlot: (plotId: string | null) => void;
  createPlot: (draft: PlotDraft) => Promise<Plot>;
  updatePlot: (plotId: string, draft: PlotDraft) => Promise<void>;
  /** 移交地块给养护队：抄基线、两侧留底；返回养护侧是否写入成功 */
  handoverPlot: (plotId: string, handoverDate: string, note: string) => Promise<{ careWritten: boolean; reason?: string }>;
  /** 养护侧留底写不进去时，只补跑养护队本侧 */
  backfillCare: (plotId: string) => Promise<void>;
  deletePlot: (plotId: string) => Promise<void>;
  setFilters: (patch: Partial<PlotFilters>) => void;
  resetFilters: () => void;
  visiblePlots: () => Plot[];
  statOf: (plotId: string) => PlotStat;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  projectBaselineOf: (plotId: string) => HandoverBaseline | undefined;
  careBaselineOf: (plotId: string) => HandoverBaseline | undefined;
  refreshCounts: () => Promise<void>;
}

const EMPTY_STAT: Omit<PlotStat, 'plotId'> = {
  seedlingCount: 0,
  seedlingQuantity: 0,
  plantTotal: 0,
  surveyCount: 0,
  latestRate: 0,
  level: 'poor',
  trend: 0,
  suggestReplant: 0,
  handedOver: false,
  readOnly: false,
  careBaselineMissing: false,
  handoverDate: '',
  careBlocked: false,
};

let subscribed = false;

export const usePlotStore = create<PlotStoreState>((set, get) => ({
  plots: [],
  seedlings: [],
  plantings: [],
  surveys: [],
  baselines: [],
  careRechecks: [],
  currentPlotId: readCurrentPlotId(),
  loading: true,
  ready: false,
  error: '',
  filters: { ...EMPTY_FILTERS },
  counts: {},
  stats: {},
  summaries: {},

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [plots, seedlings, plantings, surveys, baselines, careRechecks] = await Promise.all([
            db.plots.toArray(),
            db.seedlings.toArray(),
            db.plantings.toArray(),
            db.surveys.toArray(),
            db.handoverBaselines.toArray(),
            db.careRechecks.toArray(),
          ]);
          return { plots, seedlings, plantings, surveys, baselines, careRechecks };
        }).subscribe({
          next: ({ plots, seedlings, plantings, surveys, baselines, careRechecks }) => {
            const stats: Record<string, PlotStat> = {};
            const summaries: Record<string, SurvivalSummary> = {};
            plots.forEach((plot) => {
              const plotSeedlings = seedlings.filter((row) => row.plotId === plot.id);
              const projectBaseline = baselines.find((row) => row.plotId === plot.id && row.side === '项目部');
              const careBaseline = baselines.find((row) => row.plotId === plot.id && row.side === '养护队');
              // 项目部那份成活率：已移交地块套用基线，停在移交当天那版
              const summary = buildSurvivalSummary(plot.id, surveys, plantings, undefined, projectBaseline);
              summaries[plot.id] = summary;
              const heldStatuses = new Set<CareRecheck['status']>(['held', 'mismatch', 'overBaseline']);
              const careBlocked = careRechecks.some(
                (row) => row.plotId === plot.id && heldStatuses.has(row.status),
              );
              stats[plot.id] = {
                plotId: plot.id,
                seedlingCount: plotSeedlings.length,
                seedlingQuantity: plotSeedlings.reduce((acc, row) => acc + row.quantity, 0),
                plantTotal: summary.totalCount,
                surveyCount: summary.points.length,
                latestRate: summary.latestRate,
                level: summary.level,
                trend: summary.trend,
                suggestReplant: summary.suggestReplant,
                handedOver: summary.handedOver,
                readOnly: plot.readOnly === true,
                careBaselineMissing: projectBaseline !== undefined && careBaseline === undefined,
                handoverDate: plot.handoverDate ?? '',
                careBlocked,
              };
            });
            const sorted = [...plots].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
            const current = get().currentPlotId;
            const stillExists = current !== null && plots.some((plot) => plot.id === current);
            set({
              plots: sorted,
              seedlings,
              plantings,
              surveys,
              baselines,
              careRechecks,
              stats,
              summaries,
              loading: false,
              ready: true,
              error: '',
            });
            if (!stillExists) {
              const nextId = sorted.length > 0 ? sorted[0].id : null;
              set({ currentPlotId: nextId });
              writeCurrentPlotId(nextId);
            }
          },
          error: (err: unknown) => {
            set({ loading: false, error: err instanceof Error ? err.message : '读取地块数据失败' });
          },
        });
      }
      await get().refreshCounts();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '初始化本地数据库失败' });
    }
  },

  selectPlot(plotId) {
    set({ currentPlotId: plotId });
    writeCurrentPlotId(plotId);
  },

  async createPlot(draft) {
    const stamp = nowIso();
    const row: Plot = {
      id: uuid('plot'),
      name: draft.name.trim() || '未命名地块',
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      // 「已移交」只能通过移交动作进入，新建时一律回到跟踪中
      state: draft.state === '已移交' ? '跟踪中' : draft.state,
      handoverBatch: '',
      handoverDate: '',
      readOnly: false,
      missingCount: 0,
      lastReplantDate: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putPlot(row);
    get().selectPlot(row.id);
    return row;
  },

  async updatePlot(plotId, draft) {
    const existing = await db.plots.get(plotId);
    if (!existing) return;
    // 已移交地块：项目部侧只允许改地块名，栽植/验收口径与移交状态一律冻结
    if (existing.state === '已移交') {
      await putPlot({
        ...existing,
        name: draft.name.trim() || existing.name,
        state: '已移交',
      });
      return;
    }
    // 只读留底地块（升级补不齐基线）：同样只允许核对地块名，其余档案与只读标记原样保留
    if (existing.readOnly) {
      await putPlot({
        ...existing,
        name: draft.name.trim() || existing.name,
      });
      return;
    }
    await putPlot({
      ...existing,
      name: draft.name.trim() || existing.name,
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state === '已移交' ? existing.state : draft.state,
    });
  },

  async handoverPlot(plotId, handoverDate, note) {
    const result = await performHandover(plotId, handoverDate, note);
    await get().refreshCounts();
    return { careWritten: result.careWritten, reason: result.reason };
  },

  async backfillCare(plotId) {
    await backfillCareBaseline(plotId);
    await get().refreshCounts();
  },

  async deletePlot(plotId) {
    const existing = get().plots.find((plot) => plot.id === plotId);
    // 已移交地块两侧均在管护留底，不允许在地块台账直接级联删除；只读留底地块也要保留待补基线
    if (existing && (existing.state === '已移交' || existing.readOnly)) {
      throw new Error(
        existing.state === '已移交'
          ? '地块已移交养护队，不能删除；如需清理请先联系养护队核账'
          : '该地块为升级补不齐基线的只读留底，暂不可删除',
      );
    }
    await removePlot(plotId);
    if (get().currentPlotId === plotId) {
      get().selectPlot(null);
    }
    await get().refreshCounts();
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  visiblePlots() {
    const { plots, filters } = get();
    const keyword = filters.keyword.trim().toLowerCase();
    return plots.filter((plot) => {
      if (filters.tideZone !== 'all' && plot.tideZone !== filters.tideZone) return false;
      if (filters.substrate !== 'all' && plot.substrate !== filters.substrate) return false;
      if (keyword === '') return true;
      return (
        plot.name.toLowerCase().includes(keyword) ||
        plot.restoreMode.toLowerCase().includes(keyword) ||
        plot.state.toLowerCase().includes(keyword)
      );
    });
  },

  statOf(plotId) {
    return get().stats[plotId] ?? { plotId, ...EMPTY_STAT };
  },

  summaryOf(plotId) {
    if (plotId === null) return buildSurvivalSummary('', [], []);
    return get().summaries[plotId] ?? buildSurvivalSummary(plotId, [], []);
  },

  projectBaselineOf(plotId) {
    return get().baselines.find((row) => row.plotId === plotId && row.side === '项目部');
  },

  careBaselineOf(plotId) {
    return get().baselines.find((row) => row.plotId === plotId && row.side === '养护队');
  },

  async refreshCounts() {
    const counts = await countAll();
    set({ counts: { ...counts, schemaVersion: DB_SCHEMA_VERSION } });
  },
}));
