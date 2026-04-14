import { Link } from 'react-router-dom';
import { ChevronRight, ExternalLink, RotateCcw } from 'lucide-react';
import { Button } from '@client/components/ui/button';
import type { JobDetail } from '@shared/schema';

interface JobHeaderProps {
  job: JobDetail;
  isRetrying: boolean;
  onRetry: () => void;
}

export function JobHeader({ job, isRetrying, onRetry }: JobHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          <Link to="/jobs" className="hover:text-accent transition-colors">Jobs</Link>
          <ChevronRight size={12} />
          <span>{job.owner}/{job.repo}</span>
        </div>
        <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">
          <a
            href={`https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:text-accent transition-colors"
          >
            PR #{job.prNumber}
            <ExternalLink size={18} className="text-muted-foreground" />
          </a>
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{job.prTitle ?? 'Untitled pull request'}</p>
      </div>

      <Button
        variant={job.status === 'failed' ? 'destructive' : 'default'}
        disabled={isRetrying || job.status === 'running' || job.status === 'queued'}
        onClick={onRetry}
        className="shrink-0 gap-2"
      >
        <RotateCcw size={14} />
        {isRetrying ? 'Starting…' : job.status === 'failed' ? 'Retry job' : 'Re-run job'}
      </Button>
    </header>
  );
}
