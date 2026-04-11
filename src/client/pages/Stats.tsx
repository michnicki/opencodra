import { useEffect, useState } from 'react';
import { api } from '@client/lib/api';
import type { StatsPayload } from '@shared/schema';

export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getStats()
      .then((response) => setStats(response.stats))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Failed to load stats.'));
  }, []);

  if (!stats) {
    return (
      <section className="page">
        <div className="panel">{error ?? 'Loading stats...'}</div>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Usage</div>
          <h1>Review activity</h1>
        </div>
      </header>

      <div className="stats-grid">
        <article className="stat-card"><span>Total jobs</span><strong>{stats.totals.jobs}</strong></article>
        <article className="stat-card"><span>Input tokens</span><strong>{stats.totals.inputTokens}</strong></article>
        <article className="stat-card"><span>Output tokens</span><strong>{stats.totals.outputTokens}</strong></article>
        <article className="stat-card"><span>Comments posted</span><strong>{stats.totals.comments}</strong></article>
      </div>

      <div className="grid two">
        <div className="panel">
          <h2>Last 30 days</h2>
          <div className="chart-list">
            {stats.last30Days.map((day) => (
              <div key={day.day} className="bar-row">
                <span>{day.day}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(8, day.jobs * 10)}px` }} /></div>
                <strong>{day.jobs}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Verdicts</h2>
          <div className="list">
            {stats.verdicts.map((item) => (
              <div key={item.verdict ?? 'none'} className="split-row">
                <span>{item.verdict ?? 'none'}</span>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid two">
        <div className="panel">
          <h2>Model usage</h2>
          <div className="list">
            {stats.models.map((model) => (
              <div key={model.modelUsed} className="split-row">
                <span>{model.modelUsed}</span>
                <strong>{model.calls} calls</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Top repos</h2>
          <div className="list">
            {stats.topRepos.map((repo) => (
              <div key={`${repo.owner}/${repo.repo}`} className="split-row">
                <span>{repo.owner}/{repo.repo}</span>
                <strong>{repo.jobs}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
