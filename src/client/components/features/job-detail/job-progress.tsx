import type { JobDetail } from '@shared/schema';

interface JobProgressProps {
  job: JobDetail;
}

export function JobProgress({ job }: JobProgressProps) {
  if (job.status !== 'running' && job.status !== 'queued') return null;

  const finishedFilesCount = job.files.filter((f) => f.fileStatus === 'done').length;
  const totalFilesCount = job.fileCount || 0;
  const progressPercent = totalFilesCount > 0 ? Math.round((finishedFilesCount / totalFilesCount) * 100) : 0;

  return (
    <div className="rounded-xl bg-primary p-4 text-primary-foreground">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium">
          {job.status === 'queued' ? 'Queued…' : 'Reviewing files…'}
        </span>
        <span className="opacity-80">{finishedFilesCount} / {totalFilesCount} files</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
        <div
          className="h-full rounded-full bg-white transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </div>
  );
}
