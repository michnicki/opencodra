import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@client/lib/api';
import { StatusBadge } from '@client/components/StatusBadge';
import type { JobDetail } from '@shared/schema';

export function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getJob(id)
      .then((response) => {
        setJob(response.job);
        setError(null);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load job.');
      });
  }, [id]);

  if (!job) {
    return (
      <section className="page">
        <div className="panel">{error ?? 'Loading job...'}</div>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header split">
        <div>
          <div className="eyebrow">{job.owner}/{job.repo}</div>
          <h1>PR #{job.prNumber}</h1>
          <p className="muted">{job.prTitle ?? 'Untitled pull request'}</p>
        </div>

        <button
          className="primary-button"
          type="button"
          onClick={async () => {
            const response = await api.retryJob(job.id);
            navigate(`/jobs/${response.job.id}`);
          }}
        >
          Retry job
        </button>
      </header>

      {error ? <div className="error-box">{error}</div> : null}

      <div className="grid two">
        <div className="panel">
          <h2>Job details</h2>
          <dl className="meta-grid">
            <div><dt>Status</dt><dd><StatusBadge label={job.status} /></dd></div>
            <div><dt>Verdict</dt><dd>{job.verdict ? <StatusBadge label={job.verdict} /> : '—'}</dd></div>
            <div><dt>Trigger</dt><dd>{job.trigger}</dd></div>
            <div><dt>Commit</dt><dd><code>{job.commitSha}</code></dd></div>
            <div><dt>Base</dt><dd><code>{job.baseSha}</code></dd></div>
            <div><dt>Tokens</dt><dd>{job.totalInputTokens + job.totalOutputTokens}</dd></div>
          </dl>
        </div>

        <div className="panel">
          <h2>Summary</h2>
          <pre className="code-block">{job.summaryMarkdown ?? 'No summary yet.'}</pre>
        </div>
      </div>

      <div className="panel">
        <h2>Config snapshot</h2>
        <pre className="code-block">{JSON.stringify(job.configSnapshot, null, 2)}</pre>
      </div>

      <div className="stack">
        {job.files.map((file) => (
          <details key={file.id} className="panel">
            <summary className="summary-row">
              <span>{file.filePath}</span>
              <span className="summary-meta">
                <StatusBadge label={file.fileStatus} /> <StatusBadge label={file.verdict ?? 'comment'} />
              </span>
            </summary>
            <div className="grid two">
              <div>
                <h3>Prompt / diff</h3>
                <pre className="code-block">{file.diffInput ?? 'No prompt saved.'}</pre>
              </div>
              <div>
                <h3>Raw model output</h3>
                <pre className="code-block">{file.rawAiOutput ?? 'No raw output saved.'}</pre>
              </div>
            </div>

            <div className="comments-list">
              {file.parsedComments.map((comment, index) => (
                <article key={`${file.id}-${index}`} className="comment-card">
                  <div className="comment-title">{comment.title}</div>
                  <div className="muted">{comment.category} • line {comment.line ?? 'n/a'} • position {comment.position ?? 'n/a'}</div>
                  <pre className="code-block">{comment.body}</pre>
                </article>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
