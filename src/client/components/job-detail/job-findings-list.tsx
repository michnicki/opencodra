import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@client/components/ui/card';
import { cn } from '@client/lib/utils';
import type { JobDetail } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';
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
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-bold text-foreground">Findings</h2>
          {job.status === 'running' && <span className="pulsing-dot" />}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">View by</span>
          <div className="flex rounded-xl bg-secondary p-1 gap-0.5">
            {(['files', 'severity'] as const).map((view) => (
              <button
                key={view}
                onClick={() => setViewBy(view)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-all',
                  viewBy === view
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {view}
              </button>
            ))}
          </div>
        </div>
      </div>

      {viewBy === 'files' ? (
        <div className="flex flex-col gap-3">
          {job.files.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/60 bg-card/30 p-12 text-center text-sm text-muted-foreground">
              No files reviewed yet.
            </div>
          ) : (
            job.files.map((file) => (
              <FileFinding key={file.id} file={file} />
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
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
              <Card key={groupName}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    {sev?.svg ? (
                      <img src={sev.svg} alt={groupName} className="w-[16px] h-[16px]" />
                    ) : (
                      <GroupIcon
                        size={15}
                        className={sev?.iconColor ?? 'text-muted-foreground'}
                      />
                    )}
                    <CardTitle className="uppercase font-mono text-sm">{groupName}</CardTitle>
                    <span className="ml-1 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                      {comments.length}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex flex-col gap-3">
                    {comments.map((comment, index) => (
                      <CommentCard
                        key={`${groupName}-${index}`}
                        comment={comment}
                        filePath={comment.filePath}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
