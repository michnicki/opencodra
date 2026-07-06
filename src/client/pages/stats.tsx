import { useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TimeRangeSelect } from '@client/components/features/stats/time-range-select';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { PageHeader } from '@client/components/layout/page-header';
import { Skeleton } from '@client/components/shared/skeleton';
import { Alert } from '@client/components/ui/alert';
import { Button } from '@client/components/ui/button';
import { useIsDarkMode } from '@client/hooks/use-is-dark-mode';
import { usePolling } from '@client/hooks/use-polling';
import { api } from '@client/lib/api';
import { fmtNumber } from '@client/lib/utils';
import type { StatsPayload } from '@shared/schema';

const CHART = {
  primary: '#84cc16',
  primaryDark: '#e0fe56',
  comments: '#0ea5e9',
  warning: '#f59e0b',
  danger: '#ef4444',
  quiet: '#64748b',
};

const axisProps = {
  fontSize: 11,
  tickLine: false,
  tickMargin: 10,
  axisLine: false,
  tick: { fontFamily: 'var(--font-sans)', fill: 'var(--muted-foreground)' } as const,
};

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatCompact(value: number) {
  return value >= 1000 ? fmtNumber(value) : value.toLocaleString();
}

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function modelName(model: string) {
  return model.split('/').pop()?.replace(/-/g, ' ') ?? model;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5 text-xs shadow-lg">
      {label && (
        <p className="mb-2 font-semibold text-foreground">
          {typeof label === 'string' && label.includes('-') ? formatDay(label) : label}
        </p>
      )}
      <div className="space-y-1.5">
        {payload.map((item: any) => (
          <div key={item.dataKey ?? item.name} className="flex min-w-32 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="flex-1 capitalize text-muted-foreground">{item.name}</span>
            <span className="font-semibold tabular-nums text-foreground">
              {typeof item.value === 'number' ? formatCompact(item.value) : item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphSectionTitle() {
  return <div className="pt-2" aria-hidden="true" />;
}

function GraphShell({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-md)] ${className}`}>
      <div className="px-5 pt-5">
        <h3 className="text-base font-bold text-foreground">{title}</h3>
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
    </article>
  );
}

function MetricsGrid({ stats, days, isDark }: { stats: StatsPayload; days: number; isDark: boolean }) {
  const color = isDark ? CHART.primaryDark : CHART.primary;
  const repoMax = Math.max(...stats.topRepos.map((repo) => repo.jobs), 1);
  const modelMax = Math.max(...stats.models.map((model) => model.calls), 1);

  const STATUS_COLOR: Record<string, string> = {
    done: color,
    running: CHART.comments,
    queued: CHART.quiet,
    failed: CHART.danger,
    superseded: CHART.quiet,
  };
  const statusTotal = Math.max(stats.statuses.reduce((sum, s) => sum + s.count, 0), 1);

  return (
    <div className="flex flex-col gap-6">
      <GraphSectionTitle />

      <div className="grid gap-5 sm:grid-cols-2">
        <GraphShell title="Review flow">
          <div className="h-80 px-3 pb-5 pt-4">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={stats.trend} margin={{ left: -18, right: 12, top: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="reviewFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="commentFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.comments} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={CHART.comments} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" {...axisProps} tickFormatter={formatDay} interval={Math.max(Math.floor(days / 4), 0)} />
                <YAxis {...axisProps} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: color, strokeDasharray: '4 4' }} />
                <Area
                  type="monotone"
                  dataKey="jobs"
                  name="reviews"
                  stroke={color}
                  strokeWidth={2.5}
                  fill="url(#reviewFill)"
                  dot={false}
                  activeDot={{ r: 4, fill: color, stroke: 'var(--card)', strokeWidth: 2 }}
                />
                <Area
                  type="monotone"
                  dataKey="comments"
                  name="comments"
                  stroke={CHART.comments}
                  strokeWidth={2}
                  fill="url(#commentFill)"
                  dot={false}
                  activeDot={{ r: 4, fill: CHART.comments, stroke: 'var(--card)', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </GraphShell>

        <GraphShell title="Input vs output tokens">
          <div className="h-80 px-3 pb-5 pt-4">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart data={stats.trend} margin={{ left: -18, right: 12, top: 10, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" {...axisProps} tickFormatter={formatDay} interval={Math.max(Math.floor(days / 4), 0)} />
                <YAxis {...axisProps} tickFormatter={formatCompact} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--muted)' }} />
                <Bar dataKey="inputTokens" name="input" fill={CHART.comments} radius={[3, 3, 0, 0]} />
                <Bar dataKey="outputTokens" name="output" fill={CHART.warning} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </GraphShell>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphShell title="Job health">
          <div className="flex flex-1 flex-col justify-center space-y-5 px-5 pb-6 pt-5">
            <div className="flex h-3.5 overflow-hidden rounded-full bg-secondary">
              {stats.statuses.map((s) => (
                <div
                  key={s.status}
                  style={{ width: `${(s.count / statusTotal) * 100}%`, backgroundColor: STATUS_COLOR[s.status] ?? CHART.quiet }}
                />
              ))}
            </div>
            <div className="space-y-3.5">
              {stats.statuses.map((s) => (
                <div key={s.status} className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLOR[s.status] ?? CHART.quiet }} />
                    <span className="capitalize font-medium text-muted-foreground">{s.status}</span>
                  </div>
                  <span className="font-bold tabular-nums text-foreground">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </GraphShell>

        <GraphShell title="Repository bars">
          <div className="space-y-4 px-5 pb-6 pt-5">
            {stats.topRepos.slice(0, 8).map((repo) => (
              <div key={`${repo.owner}/${repo.repo}`} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-semibold text-foreground">{repo.owner}/{repo.repo}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent(repo.jobs, repoMax)}%` }} />
                  </div>
                </div>
                <span className="text-right text-xs font-bold tabular-nums text-foreground">{repo.jobs}</span>
              </div>
            ))}
          </div>
        </GraphShell>

        <GraphShell title="Model calls">
          <div className="space-y-4 px-5 pb-6 pt-5">
            {stats.models.slice(0, 8).map((model) => (
              <div key={model.modelUsed} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-semibold text-foreground">{modelName(model.modelUsed)}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-info" style={{ width: `${percent(model.calls, modelMax)}%` }} />
                  </div>
                </div>
                <span className="text-right text-xs font-bold tabular-nums text-foreground">{model.calls}</span>
              </div>
            ))}
          </div>
        </GraphShell>
      </div>
    </div>
  );
}

function GraphCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <article className={`overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-md)] ${className}`}>
      <div className="px-5 pt-5">
        <Skeleton height={16} width={140} />
      </div>
      <div className="h-80 px-5 pb-5 pt-4">
        <Skeleton height="100%" width="100%" borderRadius={6} />
      </div>
    </article>
  );
}

function GraphBarCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <article className={`overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-md)] ${className}`}>
      <div className="px-5 pt-5">
        <Skeleton height={16} width={140} />
      </div>
      <div className="space-y-4 px-5 pb-6 pt-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
            <div className="space-y-2">
              <Skeleton height={10} width={`${70 + (i % 3) * 10}%`} />
              <Skeleton height={8} width={`${40 + ((i * 17) % 50)}%`} />
            </div>
            <Skeleton height={12} width={28} />
          </div>
        ))}
      </div>
    </article>
  );
}

function MetricsGridSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="pt-2" aria-hidden="true" />
      <div className="grid gap-5 sm:grid-cols-2">
        <GraphCardSkeleton />
        <GraphCardSkeleton />
      </div>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphBarCardSkeleton />
        <GraphBarCardSkeleton />
        <GraphBarCardSkeleton />
      </div>
    </div>
  );
}

export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const isDark = useIsDarkMode();

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await api.getStats(days);
      setStats(res.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stats.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  usePolling(load, 30_000, [days]);

  return (
    <section className="page-enter flex flex-col gap-6">
      <PageHeader
        category="Reports"
        title="Review metrics"
        description="Daily review and comment activity for the selected range."
        actions={
          <PageHeaderActions
            days={days}
            onDaysChange={setDays}
            onRefresh={() => load(true)}
            refreshing={refreshing}
          />
        }
      />

      {error && <Alert variant="destructive">{error}</Alert>}

      {stats ? (
        <MetricsGrid stats={stats} days={days} isDark={isDark} />
      ) : (
        <MetricsGridSkeleton />
      )}
    </section>
  );
}
