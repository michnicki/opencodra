import { Link } from 'react-router-dom';
import { StatusBadge } from '@client/components/shared/status-badge';
import { Skeleton } from '@client/components/shared/skeleton';
import type { JobSummary } from '@shared/schema';

type Column = 'repo' | 'pr' | 'trigger' | 'status' | 'verdict' | 'files' | 'tokens' | 'created';

interface JobsTableProps {
  jobs: JobSummary[];
  loading: boolean;
  /** Columns to show. Defaults to all. */
  columns?: Column[];
}

const DEFAULT_COLUMNS: Column[] = [
  'repo', 'pr', 'trigger', 'status', 'verdict', 'files', 'tokens', 'created',
];

const thCls = 'px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground select-none';

const COLUMN_HEADERS: Record<Column, string> = {
  repo: 'Repository',
  pr: 'Pull request',
  trigger: 'Trigger',
  status: 'Status',
  verdict: 'Verdict',
  files: 'Files',
  tokens: 'Tokens',
  created: 'Created',
};

const SKELETON_WIDTHS: Record<Column, number | string> = {
  repo: 100, pr: '75%', trigger: 55, status: 65, verdict: 65, files: 26, tokens: 54, created: 80,
};

export function JobsTable({ jobs, loading, columns }: JobsTableProps) {
  const cols: Column[] = columns ?? DEFAULT_COLUMNS;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {cols.map((col) => (
              <th
                key={col}
                className={col === 'files' || col === 'tokens' ? `${thCls} text-right` : thCls}
              >
                {COLUMN_HEADERS[col]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && jobs.length === 0 ? (
            Array.from({ length: 7 }).map((_, i) => (
              <tr key={i} className="border-b border-border/40">
                {cols.map((col) => (
                  <td key={col} className="px-4 py-3.5">
                    <Skeleton width={SKELETON_WIDTHS[col]} />
                  </td>
                ))}
              </tr>
            ))
          ) : (
            jobs.map((job) => (
              <tr
                key={job.id}
                className="border-b border-border/40 transition-colors hover:bg-primary/[0.03] cursor-default last:border-0"
              >
                {cols.includes('repo') && (
                  <td className="px-4 py-3.5">
                    <Link
                      to={`/jobs/${job.id}`}
                      className="font-semibold text-primary hover:underline underline-offset-2 text-sm"
                    >
                      {job.owner}/{job.repo}
                    </Link>
                  </td>
                )}

                {cols.includes('pr') && (
                  <td className="px-4 py-3.5 max-w-[260px]">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">
                        #{job.prNumber}
                      </span>
                      <span className="truncate text-foreground">
                        {job.prTitle ?? 'Untitled PR'}
                      </span>
                    </div>
                  </td>
                )}

                {cols.includes('trigger') && (
                  <td className="px-4 py-3.5">
                    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-secondary text-secondary-foreground">
                      {job.trigger}
                    </span>
                  </td>
                )}

                {cols.includes('status') && (
                  <td className="px-4 py-3.5">
                    <StatusBadge label={job.status} job={job} />
                  </td>
                )}

                {cols.includes('verdict') && (
                  <td className="px-4 py-3.5">
                    {job.verdict
                      ? <StatusBadge label={job.verdict} />
                      : <span className="text-muted-foreground/40">—</span>}
                  </td>
                )}

                {cols.includes('files') && (
                  <td className="px-4 py-3.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {job.fileCount}
                  </td>
                )}

                {cols.includes('tokens') && (
                  <td className="px-4 py-3.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {(job.totalInputTokens + job.totalOutputTokens).toLocaleString()}
                  </td>
                )}

                {cols.includes('created') && (
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm text-muted-foreground">
                        {new Date(job.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                      <span className="text-[11px] font-mono text-muted-foreground/60">
                        {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
