import { useEffect, useState } from 'react';
import { api } from '@client/lib/api';
import type { StatsPayload } from '@shared/schema';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts';
import {
  Activity, Cpu, MessageSquare, Terminal, TrendingUp,
  ArrowUpRight, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@client/components/ui/card';

const COLORS = ['#059669', '#2563eb', '#dc2626', '#d97706', '#7c3aed'];
const VERDICT_COLORS: Record<string, string> = {
  approve:         '#059669',
  comment:         '#2563eb',
  request_changes: '#dc2626',
  none:            '#94a3b8',
};

function formatNum(n: number) {
  return new Intl.NumberFormat().format(n);
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}

function StatCard({ icon, label, value, color }: StatCardProps) {
  return (
    <Card className="relative overflow-hidden">
      {/* Background blob */}
      <div
        className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-10 blur-2xl"
        style={{ background: color }}
      />
      <CardContent className="p-5 flex items-start gap-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm"
          style={{ background: color }}
        >
          {icon}
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-2xl font-bold tracking-tight text-foreground">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getStats()
      .then((response) => setStats(response.stats))
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : 'Failed to load stats.'),
      );
  }, []);

  if (!stats) {
    return (
      <section className="flex flex-col gap-6">
        <div className="rounded-2xl border border-border/60 bg-card/80 p-6 text-sm text-muted-foreground">
          {error ?? 'Loading stats…'}
        </div>
      </section>
    );
  }

  const verdictData = stats.verdicts
    .map((v) => ({
      name: v.verdict ?? 'none',
      value: v.count,
      color: VERDICT_COLORS[v.verdict ?? 'none'],
    }))
    .filter((v) => v.value > 0);

  const tooltipStyle = {
    border: 'none',
    borderRadius: '12px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
    fontSize: '12px',
  };

  return (
    <section className="flex flex-col gap-6">
      {/* Header */}
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Insights</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">System Analytics</h1>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard icon={<Activity size={18} />} label="Total reviews"   value={formatNum(stats.totals.jobs)}         color="#2563eb" />
        <StatCard icon={<ArrowUpRight size={18} />} label="Input tokens" value={formatNum(stats.totals.inputTokens)} color="#d97706" />
        <StatCard icon={<Cpu size={18} />}       label="Output tokens"  value={formatNum(stats.totals.outputTokens)} color="#059669" />
        <StatCard icon={<MessageSquare size={18} />} label="Comments"   value={formatNum(stats.totals.comments)}     color="#7c3aed" />
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp size={15} className="text-muted-foreground" />
              Review volume (last 30 days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.last30Days}>
                  <defs>
                    <linearGradient id="colorJobs" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#2563eb" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="day"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(val) => val.split('-').slice(1).join('/')}
                  />
                  <YAxis fontSize={10} tickLine={false} axisLine={false} tick={{ fill: 'hsl(var(--muted-foreground))' }} />
                  <Tooltip cursor={{ stroke: '#2563eb', strokeWidth: 1 }} contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="jobs" stroke="#2563eb" strokeWidth={2} fillOpacity={1} fill="url(#colorJobs)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={15} className="text-muted-foreground" />
              Decision mix
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6 h-[220px]">
              <ResponsiveContainer width="55%" height="100%">
                <PieChart>
                  <Pie data={verdictData} innerRadius={54} outerRadius={80} paddingAngle={4} dataKey="value">
                    {verdictData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} strokeWidth={0} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-2.5">
                {verdictData.map((v) => (
                  <div key={v.name} className="flex items-center gap-2.5 text-sm">
                    <div className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: v.color }} />
                    <span className="capitalize text-muted-foreground">{v.name.replace('_', ' ')}</span>
                    <strong className="ml-auto pl-3">{v.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cpu size={15} className="text-muted-foreground" />
              Language models
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {stats.models.map((model, idx) => {
                const maxCalls = Math.max(...stats.models.map((m) => m.calls));
                const pct = (model.calls / maxCalls) * 100;
                return (
                  <div key={model.modelUsed} className="grid grid-cols-[1fr_auto] items-center gap-3">
                    <div>
                      <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="truncate text-muted-foreground" title={model.modelUsed}>
                          {model.modelUsed.split('/').pop()}
                        </span>
                        <strong className="ml-2 shrink-0">{model.calls}</strong>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, background: COLORS[idx % COLORS.length] }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Terminal size={15} className="text-muted-foreground" />
              Active repositories
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {stats.topRepos.map((repo) => (
                <div
                  key={`${repo.owner}/${repo.repo}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Terminal size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{repo.owner}/{repo.repo}</span>
                  </div>
                  <span className="shrink-0 font-semibold">
                    {repo.jobs}{' '}
                    <span className="font-normal text-muted-foreground text-xs">jobs</span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
