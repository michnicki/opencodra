import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { JobDetail } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';
import { Tabs, TabsList, TabsTrigger } from '@client/components/motion/tabs';
import { FileFinding } from './file-finding';
import { CommentCard } from './comment-card';
import { severityConfig } from './constants';

interface JobFindingsListProps {
  job: JobDetail;
}

export function JobFindingsList({ job }: JobFindingsListProps) {
  const [viewBy, setViewBy] = useState<'files' | 'severity'>('files');

  return (
    <div>
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <FileText size={14} strokeWidth={1.75} className="text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Findings</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">View by</span>
          <Tabs value={viewBy} onValueChange={(v) => setViewBy(v as 'files' | 'severity')} variant="segment">
            <TabsList className="bg-secondary">
              <TabsTrigger value="files" className="text-xs">
                Files
              </TabsTrigger>
              <TabsTrigger value="severity" className="text-xs">
                Severity
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {viewBy === 'files' ? (
        <div className="flex flex-col gap-3">
          {job.files.length === 0 ? (
            <div className="surface surface-static-shadow flex flex-col items-center justify-center py-16 text-center">
              <FileText size={32} className="text-muted-foreground/20 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No files reviewed yet.</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Results will appear here as the review progresses.</p>
            </div>
          ) : (
            job.files.map((file) => (
              <FileFinding key={file.id} file={file} />
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {job.files.some((f) => f.fileStatus === 'failed') && (
            <div className="surface surface-static-shadow overflow-hidden">
              {/* Group header */}
              <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
                <FileText size={14} strokeWidth={1.75} className="text-danger" />
                <span className="text-sm font-semibold text-foreground uppercase tracking-wide font-mono">
                  Failed Files
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                  style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}
                >
                  {job.files.filter((f) => f.fileStatus === 'failed').length}
                </span>
              </div>
              {/* Failed files list */}
              <div className="flex flex-col gap-3 p-5">
                {job.files.filter((f) => f.fileStatus === 'failed').map((file) => (
                  <FileFinding key={file.id} file={file} />
                ))}
              </div>
            </div>
          )}

          {reviewSeverities.map((groupName) => {
            const comments = job.files.flatMap((f) =>
              f.parsedComments
                .filter((c) => c.severity === groupName)
                .map((c) => ({ ...c, filePath: f.filePath })),
            );
            if (comments.length === 0) return null;

            const sev = severityConfig[groupName];
            const GroupIcon = sev?.icon ?? FileText;

            return (
              <div key={groupName} className="surface surface-static-shadow overflow-hidden">
                {/* Group header */}
                <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
                  {sev?.svg ? (
                    <img src={sev.svg} alt={groupName} className="w-[15px] h-[15px]" />
                  ) : (
                    <GroupIcon size={14} strokeWidth={1.75} className={sev?.iconColor ?? 'text-muted-foreground'} />
                  )}
                  <span className="text-sm font-semibold text-foreground uppercase tracking-wide font-mono">
                    {groupName}
                  </span>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                    style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
                  >
                    {comments.length}
                  </span>
                </div>
                {/* Comment list */}
                <div className="flex flex-col gap-3 p-5">
                  {comments.map((comment, index) => (
                    <CommentCard
                      key={`${groupName}-${index}`}
                      comment={comment}
                      filePath={comment.filePath}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
