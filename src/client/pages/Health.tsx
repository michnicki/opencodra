import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@client/lib/api';
import { StatusBadge } from '@client/components/StatusBadge';
import { Button } from '@client/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@client/components/ui/card';
import { AlertTriangle, RefreshCw, RotateCcw, Trash2, CheckCircle } from 'lucide-react';
import type { JobSummary } from '@shared/schema';
import type { DlqMessage } from '@shared/api';

export function HealthPage() {
  const [failedJobs, setFailedJobs] = useState<JobSummary[]>([]);
  const [dlqMessages, setDlqMessages] = useState<DlqMessage[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingDlq, setLoadingDlq] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const loadData = async () => {
    setError(null);
    try {
      const [jobsRes, dlqRes] = await Promise.all([
        api.getJobs({ status: 'failed', limit: 50 }),
        api.getDlqMessages(50),
      ]);
      setFailedJobs(jobsRes.jobs);
      setDlqMessages(dlqRes.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health data.');
    } finally {
      setLoadingJobs(false);
      setLoadingDlq(false);
    }
  };

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 30_000);
    return () => clearInterval(timer);
  }, []);

  const handleReplayDlq = async (leaseIds: string[]) => {
    if (processing) return;
    setProcessing(true);
    try {
      const res = await api.replayDlqMessages(leaseIds);
      alert(`Successfully replayed ${res.replayedCount} messages.`);
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to replay messages.');
    } finally {
      setProcessing(false);
    }
  };

  const handlePurgeDlq = async (leaseIds: string[]) => {
    if (processing || !confirm('Are you sure you want to permanently discard these messages?')) return;
    setProcessing(true);
    try {
      const res = await api.purgeDlqMessages(leaseIds);
      alert(`Successfully purged ${res.purged} messages.`);
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to purge messages.');
    } finally {
      setProcessing(false);
    }
  };

  const thClass = 'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground';
  const tdClass = 'px-4 py-3 text-sm';

  return (
    <section className="flex flex-col gap-6">
      {/* Header */}
      <header className="flex items-end justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">System Monitoring</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
            System Health &amp; Observability
          </h1>
        </div>
        <Button
          variant="outline"
          onClick={loadData}
          disabled={loadingJobs || loadingDlq}
          className="gap-2"
        >
          <RefreshCw size={14} className={(loadingJobs || loadingDlq) ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* DLQ */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-500" />
            <CardTitle>Dead Letter Queue (DLQ)</CardTitle>
            {dlqMessages.length === 0 && !loadingDlq && (
              <span className="ml-1 flex items-center gap-1 text-xs text-emerald-600 font-medium">
                <CheckCircle size={12} /> All clear
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleReplayDlq(dlqMessages.map((m) => m.lease_id))}
              disabled={processing || dlqMessages.length === 0}
              className="gap-1.5"
            >
              <RotateCcw size={12} /> Replay All
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handlePurgeDlq(dlqMessages.map((m) => m.lease_id))}
              disabled={processing || dlqMessages.length === 0}
              className="gap-1.5"
            >
              <Trash2 size={12} /> Purge All
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="mb-4 text-sm text-muted-foreground">
            Messages that failed all retry attempts and are parked for manual intervention.
          </p>
          <div className="overflow-auto rounded-xl border border-border/50">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className={thClass}>Timestamp</th>
                  <th className={thClass}>Attempts</th>
                  <th className={thClass}>Payload</th>
                  <th className={thClass}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingDlq ? (
                  <tr>
                    <td colSpan={4} className={`${tdClass} text-center text-muted-foreground`}>Loading DLQ…</td>
                  </tr>
                ) : dlqMessages.length === 0 ? (
                  <tr>
                    <td colSpan={4} className={`${tdClass} text-center text-muted-foreground`}>
                      DLQ is empty — all systems normal.
                    </td>
                  </tr>
                ) : (
                  dlqMessages.map((msg) => (
                    <tr key={msg.lease_id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                      <td className={`${tdClass} whitespace-nowrap text-muted-foreground font-mono text-xs`}>
                        {new Date(msg.metadata.timestamp).toLocaleString()}
                      </td>
                      <td className={tdClass}>
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          {msg.metadata.attempts}
                        </span>
                      </td>
                      <td className={`${tdClass} max-w-sm`}>
                        <pre className="rounded-lg bg-muted/50 p-2 text-xs overflow-hidden text-muted-foreground">
                          {JSON.stringify(msg.body, null, 2)}
                        </pre>
                      </td>
                      <td className={tdClass}>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReplayDlq([msg.lease_id])}
                            disabled={processing}
                            className="h-7 px-2.5 text-xs gap-1"
                          >
                            <RotateCcw size={10} /> Replay
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handlePurgeDlq([msg.lease_id])}
                            disabled={processing}
                            className="h-7 px-2.5 text-xs gap-1"
                          >
                            <Trash2 size={10} /> Purge
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Failed Jobs */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-red-500" />
            <CardTitle>Failed Jobs</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="mb-4 text-sm text-muted-foreground">
            Review jobs that encountered errors during execution.
          </p>
          <div className="overflow-auto rounded-xl border border-border/50">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className={thClass}>Repo</th>
                  <th className={thClass}>PR</th>
                  <th className={thClass}>Error</th>
                  <th className={thClass}>Finished</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {loadingJobs ? (
                  <tr>
                    <td colSpan={5} className={`${tdClass} text-center text-muted-foreground`}>Loading failed jobs…</td>
                  </tr>
                ) : failedJobs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={`${tdClass} text-center text-muted-foreground`}>No failed jobs found.</td>
                  </tr>
                ) : (
                  failedJobs.map((job) => (
                    <tr key={job.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                      <td className={tdClass}>
                        <Link to={`/jobs/${job.id}`} className="font-medium text-accent hover:underline">
                          {job.owner}/{job.repo}
                        </Link>
                      </td>
                      <td className={`${tdClass} font-semibold`}>#{job.prNumber}</td>
                      <td className={`${tdClass} max-w-xs`}>
                        <div className="text-red-600 text-xs break-words">{job.errorMessage || 'Unknown error'}</div>
                      </td>
                      <td className={`${tdClass} whitespace-nowrap text-muted-foreground`}>
                        {job.finishedAt ? new Date(job.finishedAt).toLocaleString() : '—'}
                      </td>
                      <td className={tdClass}>
                        <Button variant="outline" size="sm" asChild className="h-7 px-2.5 text-xs">
                          <Link to={`/jobs/${job.id}`}>Details</Link>
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
