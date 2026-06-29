import { useState } from 'react';
import { api } from '@client/lib/api';
import { JobsTable } from '@client/components/shared/jobs-table';
import { EmptyState } from '@client/components/shared/empty-state';
import { Button } from '@client/components/ui/button';
import { Select } from '@client/components/ui/select';
import { Alert } from '@client/components/ui/alert';
import { PageHeader } from '@client/components/layout/page-header';
import { usePolling } from '@client/hooks/use-polling';
import { GitPullRequest, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, RotateCcw, Trash2, Info, Search } from 'lucide-react';
import type { JobSummary } from '@shared/schema';
import type { DlqMessage } from '@shared/api';

export function JobsPage() {
  const [jobs, setJobs]   = useState<JobSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // System failures (DLQ) state
  const [dlqMessages, setDlqMessages] = useState<DlqMessage[]>([]);
  const [processingDlq, setProcessingDlq] = useState(false);

  const [filters, setFilters] = useState({
    status: '', verdict: '', search: '', page: 1,
  });

  const [itemsPerPage, setItemsPerPage] = useState(10);

  const load = async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [jobsRes, dlqRes] = await Promise.all([
        api.getJobs({
          status:  filters.status  || undefined,
          verdict: filters.verdict || undefined,
          search:  filters.search  || undefined,
          limit:   itemsPerPage,
          offset:  (filters.page - 1) * itemsPerPage,
        }),
        api.getDlqMessages(20).catch(() => ({ messages: [] }))
      ]);

      setJobs(jobsRes.jobs);
      setTotal(jobsRes.total);
      setDlqMessages(dlqRes.messages);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load jobs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleReplayDlq = async (leaseIds: string[]) => {
    if (processingDlq) return;
    setProcessingDlq(true);
    try {
      await api.replayDlqMessages(leaseIds);
      // Small delay to let the queue process a bit before refreshing
      setTimeout(() => load(true), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replay failed.');
    } finally {
      setProcessingDlq(false);
    }
  };

  const handlePurgeDlq = async (leaseIds: string[]) => {
    if (processingDlq || !confirm('Permanently discard these interrupted jobs?')) return;
    setProcessingDlq(true);
    try {
      await api.purgeDlqMessages(leaseIds);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Purge failed.');
    } finally {
      setProcessingDlq(false);
    }
  };

  usePolling(load, 15_000, [filters, itemsPerPage]);

  const totalPages = Math.ceil(total / itemsPerPage);

  return (
    <section className="page-enter flex flex-col gap-5">

      {/* ── Header ─────────────────────────────────── */}
      <PageHeader
        title="Jobs"
        actions={
          <div className="flex gap-2">
            {dlqMessages.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-warning border border-warning/20">
                <AlertTriangle size={10} />
                {dlqMessages.length} Action Required
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true)}
              disabled={refreshing}
              className="gap-2"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>
        }
      />

      {/* ── Search bar (Beetle-style below header) ─── */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          id="pr-search"
          placeholder="Search PRs, title, repo, number"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="h-9 w-full max-w-sm rounded-md border border-border bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* System Failures (DLQ) Section */}
      {dlqMessages.length > 0 && (
        <div className="surface min-w-0 overflow-hidden border-warning/30 bg-warning/[0.02]">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between px-5 py-3.5 border-b border-warning/20 gap-4 sm:gap-0">
            <div className="flex items-center gap-2.5">
              <div className="flex h-6 w-6 items-center justify-center rounded bg-warning text-warning-foreground">
                <AlertTriangle size={14} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">System failures detected</h3>
                <p className="text-[11px] text-muted-foreground">Jobs that were interrupted by system-level crashes or timeouts.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              <Button
                variant="outline" size="sm"
                onClick={() => handleReplayDlq(dlqMessages.map(m => m.lease_id))}
                disabled={processingDlq}
                className="h-8 gap-1.5 text-xs bg-background/50 hover:bg-background"
              >
                <RotateCcw size={12} /> Replay all
              </Button>
              <Button
                variant="outline" size="sm"
                onClick={() => handlePurgeDlq(dlqMessages.map(m => m.lease_id))}
                disabled={processingDlq}
                className="h-8 gap-1.5 text-xs bg-background/50 text-danger hover:bg-danger hover:text-danger-foreground border-danger/20"
              >
                <Trash2 size={12} /> Discard all
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-warning/5 border-b border-warning/10">
                  <th className="px-5 py-2 text-left font-bold uppercase tracking-wider text-warning/70">Time</th>
                  <th className="px-5 py-2 text-left font-bold uppercase tracking-wider text-warning/70">Retries</th>
                  <th className="px-5 py-2 text-left font-bold uppercase tracking-wider text-warning/70">Context</th>
                  <th className="px-5 py-2 text-right font-bold uppercase tracking-wider text-warning/70">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-warning/10">
                {dlqMessages.map((msg) => (
                  <tr key={msg.lease_id} className="group hover:bg-warning/[0.04] transition-colors">
                    <td className="px-5 py-3 font-mono text-muted-foreground whitespace-nowrap">
                      {msg.metadata.timestamp
                        ? new Date(msg.metadata.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center rounded-sm bg-warning/20 px-1 font-bold text-warning">
                        {msg.metadata.attempts}×
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 group-hover:text-foreground transition-colors">
                        <Info size={12} className="text-warning/60" />
                        <span className="truncate max-w-[300px] text-muted-foreground font-mono text-[10px]">
                          {typeof msg.body === 'object' ? JSON.stringify(msg.body) : String(msg.body)}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex justify-end gap-1">
                         <Button
                          variant="ghost" size="sm"
                          onClick={() => handleReplayDlq([msg.lease_id])}
                          disabled={processingDlq}
                          className="h-7 w-7 p-0"
                          title="Retry now"
                        >
                          <RotateCcw size={12} />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => handlePurgeDlq([msg.lease_id])}
                          disabled={processingDlq}
                          className="h-7 w-7 p-0 text-danger hover:text-danger hover:bg-danger/10"
                          title="Discard"
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive">{error}</Alert>
      )}

      {/* ── Table ─────────────────────────────────── */}
      <div className="surface min-w-0 overflow-hidden">
        <JobsTable jobs={jobs} loading={loading} />

        {!loading && jobs.length === 0 && (
          <EmptyState
            icon={<GitPullRequest />}
            title="No jobs yet"
            description="Your pull request analysis logs will appear here"
            hints={[
              'Once you open a PR in any of the connected repos, analysis triggers automatically',
              'To trigger manually, comment @codra on any PR',
            ]}
            linkAction={{
              label: 'See how to interact with Codra',
              href: 'https://github.com/devarshishimpi/codra#readme',
            }}
            className="rounded-none border-0"
          />
        )}

        {/* ── Pagination footer (Beetle-style) ─── */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          {/* Items per page */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Items per page:</span>
            <Select
              value={String(itemsPerPage)}
              onValueChange={(v) => {
                setItemsPerPage(Number(v));
                setFilters(f => ({ ...f, page: 1 }));
              }}
              options={[10, 20, 50, 100].map(n => ({ value: String(n), label: String(n) }))}
              variant="card"
              triggerClassName="h-8 w-20 px-2 py-1 text-xs"
            />
          </div>

          {/* Page navigation */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={filters.page === 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
              className="h-7 w-7 p-0"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {filters.page} of {Math.max(totalPages, 1)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={filters.page >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
              className="h-7 w-7 p-0"
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
