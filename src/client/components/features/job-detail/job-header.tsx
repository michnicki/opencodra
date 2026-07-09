import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  CircleStop,
  ExternalLink,
  Loader2,
  RotateCcw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { Button } from '@client/components/ui/button';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import { UpdatesEmailPrompt } from '@client/components/features/dashboard/updates-email-prompt';
import type { JobDetail } from '@shared/schema';

interface JobHeaderProps {
  job: JobDetail;
  isRerunning: boolean;
  isStopping: boolean;
  isDeleting: boolean;
  onRerun: () => void;
  onStop: () => void;
  onDelete: () => void;
}

export function JobHeader({
  job,
  isRerunning,
  isStopping,
  isDeleting,
  onRerun,
  onStop,
  onDelete,
}: JobHeaderProps) {
  const [stopOpen, setStopOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const canStop = job.status === 'running' || job.status === 'queued';

  return (
    <>
      <header className="flex flex-col sm:flex-row items-start justify-between gap-4">
      <div className="min-w-0 w-full">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          <Link to="/jobs" className="hover:text-foreground transition-colors">Jobs</Link>
          <ChevronRight size={12} className="opacity-40" />
          <span className="text-foreground/60">{job.owner}/{job.repo}</span>
          <ChevronRight size={12} className="opacity-40" />
          <span
            className="font-mono text-[10px] font-medium lowercase tracking-normal text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-default"
            title={job.id}
          >
            {job.id.slice(0, 8)}…
          </span>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
          <a
            href={`https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:text-primary transition-colors"
          >
            {job.prTitle ?? 'Untitled pull request'}
            <ExternalLink size={16} className="text-muted-foreground/50" />
          </a>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground leading-snug max-w-[480px] truncate">
          PR #{job.prNumber}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
        <Button variant="outline" asChild className="gap-2">
          <Link to={`/jobs/${job.id}/logs`}>
            <Terminal size={14} />
            Raw Logs
          </Link>
        </Button>

        {/* A single re-run control. It always restarts the review from the beginning (a fresh
            review of every file) and works whether the job is finished, failed, or still running. */}
        <Button
          variant="default"
          disabled={isRerunning}
          onClick={onRerun}
          className="gap-2 shrink-0"
        >
          {isRerunning ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          {isRerunning ? 'Starting…' : job.status === 'failed' ? 'Retry job' : 'Re-run job'}
        </Button>

        <Button
          variant="warning-outline"
          size="icon"
          disabled={!canStop || isStopping}
          onClick={() => setStopOpen(true)}
          title="Stop review"
          aria-label="Stop review"
        >
          {isStopping ? <Loader2 size={14} className="animate-spin" /> : <CircleStop size={14} />}
        </Button>

        <Button
          variant="destructive-outline"
          size="icon"
          disabled={isDeleting}
          onClick={() => setDeleteOpen(true)}
          title="Delete job"
          aria-label="Delete job"
        >
          {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </Button>
      </div>
      </header>

      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop this review?"
        description="This cancels the ongoing review for this pull request. Any files not yet reviewed will be left unreviewed."
        confirmLabel="Stop review"
        confirmVariant="destructive"
        onConfirm={onStop}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this job?"
        description="This permanently removes the job and its review history. This action cannot be undone."
        confirmLabel="Delete job"
        confirmVariant="destructive"
        onConfirm={onDelete}
      />

      <UpdatesEmailPrompt />
    </>
  );
}
