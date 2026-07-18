import { useMemo } from 'react';
import { Activity, ArrowUpRight, Cpu, MessageSquare } from 'lucide-react';
import { StatsGrid } from './stats-grid';
import { fmtNumber } from '@client/lib/utils';
import type { StatsPayload } from '@shared/schema';

interface OverviewStatsProps {
  stats: StatsPayload | null;
  days: number;
}

/**
 * Common component for the 4 overview KPI cards used on Dashboard and Stats pages.
 * Handles loading states (skeletons) and renders sparklines from the real
 * server-computed per-day `stats.trend` series — never fabricated metrics.
 */
export function OverviewStats({ stats, days }: OverviewStatsProps) {
  // Real per-day series from the server (`StatsPayload.trend`). While `stats` is
  // still loading we render a flat baseline so the card keeps its shape without
  // implying any data.
  const trends = useMemo(() => {
    if (!stats) {
      const empty = Array(days).fill(0);
      return { jobs: empty, inputTokens: empty, outputTokens: empty, comments: empty };
    }
    return {
      jobs: stats.trend.map((d) => d.jobs),
      inputTokens: stats.trend.map((d) => d.inputTokens),
      outputTokens: stats.trend.map((d) => d.outputTokens),
      comments: stats.trend.map((d) => d.comments),
    };
  }, [stats, days]);

  const items = [
    {
      icon: Activity,
      label: 'Total reviews',
      value: stats ? fmtNumber(stats.totals.jobs) : null,
      trend: trends.jobs,
    },
    {
      icon: ArrowUpRight,
      label: 'Input tokens',
      value: stats ? fmtNumber(stats.totals.inputTokens) : null,
      trend: trends.inputTokens,
    },
    {
      icon: Cpu,
      label: 'Output tokens',
      value: stats ? fmtNumber(stats.totals.outputTokens) : null,
      trend: trends.outputTokens,
    },
    {
      icon: MessageSquare,
      label: 'Comments posted',
      value: stats ? fmtNumber(stats.totals.comments) : null,
      trend: trends.comments,
    },
  ];

  return <StatsGrid items={items} />;
}
