import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@client/lib/api';
import { StatusBadge } from '@client/components/StatusBadge';
import type { JobSummary } from '@shared/schema';

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;

    const load = async () => {
      try {
        const response = await api.getJobs();
        if (!stopped) {
          setJobs(response.jobs);
          setError(null);
        }
      } catch (loadError) {
        if (!stopped) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load jobs.');
        }
      }
    };

    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Overview</div>
          <h1>Recent review jobs</h1>
        </div>
      </header>

      {error ? <div className="error-box">{error}</div> : null}

      <div className="panel table-panel">
        <table className="data-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th>PR</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Verdict</th>
              <th>Files</th>
              <th>Comments</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <Link to={`/jobs/${job.id}`}>{job.owner}/{job.repo}</Link>
                </td>
                <td>
                  <strong>#{job.prNumber}</strong> {job.prTitle ?? 'Untitled PR'}
                </td>
                <td>{job.trigger}</td>
                <td><StatusBadge label={job.status} /></td>
                <td>{job.verdict ? <StatusBadge label={job.verdict} /> : '—'}</td>
                <td>{job.fileCount}</td>
                <td>{job.commentCount}</td>
                <td>{job.totalInputTokens + job.totalOutputTokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
