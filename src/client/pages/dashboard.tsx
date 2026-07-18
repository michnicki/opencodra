import { useState } from 'react';
import { api } from '@client/lib/api';
import type { StatsPayload } from '@shared/schema';
import type { JobSummary } from '@shared/schema';
import { ArrowRight, CheckCircle2, GitPullRequest, Radio, ShieldCheck } from 'lucide-react';
import { JobsTable } from '@client/components/shared/jobs-table';
import { EmptyState } from '@client/components/shared/empty-state';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { Link } from 'react-router-dom';

import { Button } from '@client/components/ui/button';
import { PageHeader } from '@client/components/layout/page-header';
import { OverviewStats } from '@client/components/features/stats/overview-stats';
import { usePolling } from '@client/hooks/use-polling';
import { Alert } from '@client/components/ui/alert';

export function DashboardPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [days, setDays] = useState(30);

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [statsRes, jobsRes] = await Promise.all([
        api.getStats(days),
        api.getJobs({ limit: 10 }),
      ]);
      setStats(statsRes.stats);
      setRecentJobs(jobsRes.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  usePolling(load, 15_000, [days]);


  return (
    <section className="page-enter flex flex-col gap-6">

      <PageHeader
        category="Dashboard"
        title="Review operations"
        description="Monitor review throughput, model activity, and pull request outcomes from one workspace."
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

      <OverviewStats stats={stats} days={days} />

      <div className="utility-pipeline-strip grid overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-sm)] lg:grid-cols-[1.35fr_1fr_1fr]">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5 lg:border-b-0 lg:border-r sm:px-5">
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Radio size={15} />
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
          </span>
          <div>
            <p className="text-xs font-semibold text-foreground">Automated review pipeline</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Listening for pull request events</p>
          </div>
        </div>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5 lg:border-b-0 lg:border-r sm:px-5">
          <ShieldCheck size={15} className="text-muted-foreground" />
          <div>
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Policy</p>
            <p className="mt-0.5 text-xs font-medium text-foreground">Repository aware</p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <CheckCircle2 size={15} className="text-primary" />
          <div>
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Service</p>
            <p className="mt-0.5 text-xs font-medium text-foreground">All systems operational</p>
          </div>
        </div>
      </div>

      {/* ── Activity Stream ── */}
      <div className="flex flex-col gap-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold text-foreground">Review queue</h2>
            <span className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground">
              LIVE
            </span>
          </div>
          <Link to="/jobs">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              View all <ArrowRight size={13} />
            </Button>
          </Link>
        </div>

        <div className="surface surface-static-shadow min-w-0 overflow-hidden">
          {(loading || recentJobs.length > 0) && (
            <JobsTable jobs={recentJobs} loading={loading} />
          )}

          {!loading && recentJobs.length === 0 && (
            <EmptyState
              icon={<GitPullRequest />}
              title="No jobs yet"
              description="Your pull request analysis logs will appear here"
              hints={[
                'Once you open a PR in any of the connected repos, analysis triggers automatically',
                'To trigger manually, comment @codra on any PR',
              ]}
              linkAction={{
                label: 'See how to interact with OpenCodra',
                href: 'https://github.com/michnicki/opencodra#readme',
              }}
              className="rounded-none border-0"
            />
          )}

          {!loading && recentJobs.length > 0 && (
            <div className="px-5 py-2.5 bg-muted/20 border-t border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40 text-center">
                {recentJobs.length} review jobs · refreshes every 15s
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
