/**
 * 地块状态管理（Zustand）
 * 维护地块列表、当前选中地块、筛选条件与地块级派生统计；
 * 已移交地块的成活率冻结在移交当天那版（项目部口径），建议补植株数按基线剩余缺株派生；
 * 所有写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Plot, PlotDraft, Substrate, TideZone } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, RateLevel } from '../types/survey';
import type { Handover } from '../types/handover';
import { baselineRemaining } from '../types/handover';
import type { CareTask } from '../types/care';
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  fileMaintenanceSide,
  handoverPlot,
  initDatabase,
  putPlot,
  removePlot,
} from '../utils/db';
import { buildSurvivalSummary, type SurvivalSummary } from '../hooks/useSurvivalRate';
import { rateLevel } from '../utils/rate';
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
  /** 验收测次数 */
  surveyCount: number;
  /** 最新成活率（%） */
  latestRate: number;
  /** 最新等级 */
  level: RateLevel;
  /** 成活率环比变化（百分点） */
  trend: number;
  /** 建议补植株数 */
  suggestReplant: number;
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
  handovers: Handover[];
  careTasks: CareTask[];
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
  deletePlot: (plotId: string) => Promise<void>;
  /** 一键移交：项目部侧冻结 + 养护队侧建档；养护队侧失败时返回 false 供补跑 */
  handover: (plotId: string) => Promise<{ ok: boolean; maintenanceOk: boolean; message: string }>;
  /** 只补跑养护队侧（项目部侧已冻结不动） */
  retryMaintenanceSide: (handoverId: string) => Promise<boolean>;
  handoverOf: (plotId: string) => Handover | null;
  /** 该地块是否有挂起复核的管护作业单（挂起期间不出补植计划） */
  hasSuspendedCare: (plotId: string) => boolean;
  /** 已确认（正常状态）补苗累计 */
  confirmedReplantOf: (plotId: string) => number;
  setFilters: (patch: Partial<PlotFilters>) => void;
  resetFilters: () => void;
  visiblePlots: () => Plot[];
  statOf: (plotId: string) => PlotStat;
  summaryOf: (plotId: string | null) => SurvivalSummary;
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
};

let subscribed = false;

export const usePlotStore = create<PlotStoreState>((set, get) => ({
  plots: [],
  seedlings: [],
  plantings: [],
  surveys: [],
  handovers: [],
  careTasks: [],
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
          const [plots, seedlings, plantings, surveys, handovers, careTasks] = await Promise.all([
            db.plots.toArray(),
            db.seedlings.toArray(),
            db.plantings.toArray(),
            db.surveys.toArray(),
            db.handovers.toArray(),
            db.careTasks.toArray(),
          ]);
          return { plots, seedlings, plantings, surveys, handovers, careTasks };
        }).subscribe({
          next: ({ plots, seedlings, plantings, surveys, handovers, careTasks }) => {
            const stats: Record<string, PlotStat> = {};
            const summaries: Record<string, SurvivalSummary> = {};
            plots.forEach((plot) => {
              const plotSeedlings = seedlings.filter((row) => row.plotId === plot.id);
              const summary = buildSurvivalSummary(plot.id, surveys, plantings);
              summaries[plot.id] = summary;
              const handover = handovers.find((row) => row.plotId === plot.id) ?? null;
              const confirmedReplant = careTasks
                .filter((row) => row.plotId === plot.id && row.kind === '补苗' && row.state === '正常')
                .reduce((acc, row) => acc + row.replantCount, 0);
              const frozen = handover !== null && handover.projectFrozen;
              stats[plot.id] = {
                plotId: plot.id,
                seedlingCount: plotSeedlings.length,
                seedlingQuantity: plotSeedlings.reduce((acc, row) => acc + row.quantity, 0),
                plantTotal: summary.totalCount,
                surveyCount: summary.points.length,
                // 已移交：项目部那份成活率停在移交当天那版（基线留底），不随后续录入变化
                latestRate: frozen ? handover.projectCopy.survivalRate : summary.latestRate,
                level: frozen ? rateLevel(handover.projectCopy.survivalRate) : summary.level,
                trend: summary.trend,
                // 已移交：建议补植按基线剩余缺株（基线缺株 - 已确认补苗累计）
                suggestReplant: frozen
                  ? baselineRemaining(handover.maintenanceCopy, confirmedReplant)
                  : summary.suggestReplant,
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
              handovers,
              careTasks,
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
      state: draft.state,
      handoverState: '未移交',
      handoverId: '',
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
    await putPlot({
      ...existing,
      name: draft.name.trim() || existing.name,
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
    });
  },

  async deletePlot(plotId) {
    await removePlot(plotId);
    if (get().currentPlotId === plotId) {
      get().selectPlot(null);
    }
    await get().refreshCounts();
  },

  async handover(plotId) {
    const plot = get().plots.find((row) => row.id === plotId);
    if (!plot) return { ok: false, maintenanceOk: false, message: '地块不存在，无法移交' };
    if (plot.handoverState === '已移交') return { ok: false, maintenanceOk: true, message: '该地块已移交，无需重复操作' };
    if (plot.state !== '已验收') return { ok: false, maintenanceOk: false, message: '仅「已验收」地块可移交养护队' };
    const stat = get().stats[plotId];
    if (!stat || stat.plantTotal <= 0 || stat.surveyCount === 0) {
      return { ok: false, maintenanceOk: false, message: '栽植或验收数据不齐，基线抄不出来，无法移交' };
    }
    const { handover, maintenanceOk } = await handoverPlot(plotId);
    if (handover === null) return { ok: false, maintenanceOk: false, message: '基线生成失败，未移交' };
    await get().refreshCounts();
    if (!maintenanceOk) {
      return {
        ok: true,
        maintenanceOk: false,
        message: '项目部侧已冻结；养护队侧写不进去，请在养护作业单页补跑本侧',
      };
    }
    return { ok: true, maintenanceOk: true, message: '已移交养护队，基线两边各自留底' };
  },

  async retryMaintenanceSide(handoverId) {
    const ok = await fileMaintenanceSide(handoverId);
    await get().refreshCounts();
    return ok;
  },

  handoverOf(plotId) {
    return get().handovers.find((row) => row.plotId === plotId) ?? null;
  },

  hasSuspendedCare(plotId) {
    return get().careTasks.some((row) => row.plotId === plotId && row.state === '挂起复核');
  },

  confirmedReplantOf(plotId) {
    return get()
      .careTasks.filter((row) => row.plotId === plotId && row.kind === '补苗' && row.state === '正常')
      .reduce((acc, row) => acc + row.replantCount, 0);
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

  async refreshCounts() {
    const counts = await countAll();
    set({ counts: { ...counts, schemaVersion: DB_SCHEMA_VERSION } });
  },
}));
