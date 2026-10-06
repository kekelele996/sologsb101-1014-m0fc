/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Survey, RateLevel } from '../types/survey';
import type { Planting } from '../types/planting';
import type { HandoverBaseline } from '../types/handover';
import { db, initDatabase } from '../utils/db';
import {
  SURVIVAL_WARN_RATE,
  calcSurvivalRate,
  heightGrowth,
  rateLevel,
  round1,
  suggestReplantCount,
} from '../utils/rate';

/** 单个测次的成活率数据点 */
export interface SurvivalPoint {
  surveyId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  /** 该测次的成活率（%） */
  rate: number;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 栽植总株数；已移交地块冻结为基线值 */
  totalCount: number;
  /** 按测次排序的数据点（已移交地块只含移交当天及之前的测次） */
  points: SurvivalPoint[];
  /** 最新测次 */
  latest: SurvivalPoint | null;
  /** 上一次测次 */
  previous: SurvivalPoint | null;
  /** 最新成活率（%）；已移交地块停在移交当天那版 */
  latestRate: number;
  /** 与上一测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数；已移交地块归养护队对账，项目部侧不再建议补植 */
  suggestReplant: number;
  /** 最新等级 */
  level: RateLevel;
  /** 是否低于告警阈值 */
  warn: boolean;
  /** 是否已移交：移交后项目部那份成活率冻结，养护复查单独记 */
  handedOver: boolean;
  /** 移交批次号（未移交为空串） */
  handoverBatch: string;
}

/**
 * 纯函数：由验收记录与栽植记录派生地块成活率汇总。
 * 传入项目部侧移交基线时，总株数 / 成活率停在移交当天那版，
 * 移交后的测次不进入项目部口径（养护复查在管护作业单里单独记）。
 */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  threshold: number = SURVIVAL_WARN_RATE,
  baseline?: HandoverBaseline,
): SurvivalSummary {
  const rawTotal = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);

  const handedOver = baseline !== undefined;
  // 移交切开后：项目部那份只认移交基线之前（含当天测次）的验收记录
  const scopedSurveys = handedOver
    ? surveys.filter((row) => row.plotId === plotId && row.round <= baseline.surveyRound)
    : surveys.filter((row) => row.plotId === plotId);
  // 总株数冻结为基线值，避免移交后再改栽植记录影响项目部成活率
  const totalCount = handedOver ? baseline.totalCount : rawTotal;

  const points: SurvivalPoint[] = scopedSurveys
    .sort((a, b) => a.round - b.round)
    .map((row) => {
      const rate = totalCount > 0 ? calcSurvivalRate(row.aliveCount, totalCount) : row.survivalRate;
      return {
        surveyId: row.id,
        round: row.round,
        date: row.date,
        aliveCount: row.aliveCount,
        avgHeightCm: row.avgHeightCm,
        rate,
        gradeManual: row.gradeManual,
        level: row.gradeManual ? row.grade : rateLevel(rate),
      };
    });

  let latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;

  // 已移交但验收记录里查不到基线测次（如升级补建）时，用基线本身兜成一个冻结数据点
  if (handedOver && (latest === null || latest.round < baseline.surveyRound)) {
    latest = {
      surveyId: `baseline-${baseline.batch}`,
      round: baseline.surveyRound,
      date: baseline.handoverDate,
      aliveCount: baseline.aliveCount,
      avgHeightCm: 0,
      rate: baseline.survivalRate,
      gradeManual: false,
      level: rateLevel(baseline.survivalRate),
    };
  }

  const growth = latest && previous ? heightGrowth(previous.avgHeightCm, latest.avgHeightCm) : { delta: 0, pct: 0 };

  return {
    plotId,
    totalCount,
    points,
    latest,
    previous,
    latestRate: latest ? latest.rate : 0,
    trend: latest && previous ? round1(latest.rate - previous.rate) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant: handedOver ? 0 : latest ? suggestReplantCount(totalCount, latest.aliveCount) : totalCount,
    level: latest ? latest.level : 'poor',
    warn: !handedOver && latest !== null && latest.rate < threshold,
    handedOver,
    handoverBatch: handedOver ? baseline.batch : '',
  };
}

export interface UseSurvivalRateResult {
  summary: SurvivalSummary;
  loading: boolean;
  error: string;
}

/** 空汇总，用于地块不存在或尚无数据时兜底，避免页面白屏 */
export function emptySummary(plotId: string): SurvivalSummary {
  return buildSurvivalSummary(plotId, [], []);
}

/**
 * 订阅某地块的验收与栽植记录，实时派生成活率、株高增幅与补植建议。
 * 已移交地块自动套用项目部侧基线，成活率停在移交当天那版。
 */
export function useSurvivalRate(plotId: string | null, threshold: number = SURVIVAL_WARN_RATE): UseSurvivalRateResult {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const [baselines, setBaselines] = useState<HandoverBaseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows, baselineRows] = await Promise.all([
        db.surveys.toArray(),
        db.plantings.toArray(),
        db.handoverBaselines.toArray(),
      ]);
      return { surveyRows, plantingRows, baselineRows };
    }).subscribe({
      next: ({ surveyRows, plantingRows, baselineRows }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setBaselines(baselineRows);
        setError('');
        setLoading(false);
      },
      error: (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取成活率数据失败');
        setLoading(false);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const summary = useMemo(() => {
    if (plotId === null) return emptySummary('');
    const projectBaseline = baselines.find((row) => row.plotId === plotId && row.side === '项目部');
    return buildSurvivalSummary(plotId, surveys, plantings, threshold, projectBaseline);
  }, [plotId, surveys, plantings, baselines, threshold]);

  return { summary, loading, error };
}
