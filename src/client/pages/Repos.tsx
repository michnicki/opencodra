import { useEffect, useState } from 'react';
import { api } from '@client/lib/api';
import { Skeleton } from '@client/components/Skeleton';
import { EmptyState } from '@client/components/EmptyState';
import { Button } from '@client/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@client/components/ui/card';
import { REPO_CONFIG_FILENAME } from '@shared/config';
import { GitBranch, Settings, RefreshCw } from 'lucide-react';
import { cn } from '@client/lib/utils';
import type { RepoConfigRecord } from '@shared/schema';

export function ReposPage() {
  const [repos, setRepos] = useState<RepoConfigRecord[]>([]);
  const [selected, setSelected] = useState<RepoConfigRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadRepos = () => {
    api
      .getRepos()
      .then((response) => {
        setRepos(response.repos);
        if (!selected && response.repos.length > 0) {
          setSelected(response.repos[0]);
        }
        setLoading(false);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load repositories.');
        setLoading(false);
      });
  };

  useEffect(() => {
    loadRepos();
  }, []);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      await api.syncRepos();
      loadRepos();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Manual sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="flex flex-col gap-6">
      {/* Header */}
      <header className="flex items-end justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Configuration</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">Installed repositories</h1>
        </div>
        <Button onClick={handleSync} disabled={syncing} className="gap-2">
          <RefreshCw size={14} className={cn(syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync Now'}
        </Button>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-[280px_1fr] gap-5">
        {/* Repo list */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitBranch size={14} className="text-muted-foreground" />
              Repositories
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-col gap-1">
              {loading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="rounded-xl px-3 py-2.5 space-y-1.5">
                      <Skeleton width="60%" height="1.1rem" />
                      <Skeleton width="40%" height="0.75rem" />
                    </div>
                  ))
                : repos.length === 0
                ? (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <GitBranch size={36} className="text-muted-foreground opacity-30" />
                    <p className="text-sm text-muted-foreground">No repositories found.</p>
                  </div>
                )
                : repos.map((repo) => (
                    <button
                      key={`${repo.owner}/${repo.repo}`}
                      type="button"
                      onClick={() => setSelected(repo)}
                      className={cn(
                        'group w-full rounded-xl px-3 py-2.5 text-left transition-colors',
                        selected?.owner === repo.owner && selected?.repo === repo.repo
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-secondary',
                      )}
                    >
                      <div className="font-medium text-sm leading-none">{repo.owner}/{repo.repo}</div>
                      <div
                        className={cn(
                          'mt-1 text-xs',
                          selected?.owner === repo.owner && selected?.repo === repo.repo
                            ? 'text-primary-foreground/70'
                            : 'text-muted-foreground',
                        )}
                      >
                        {repo.configMissing ? 'Defaults only' : `Custom ${REPO_CONFIG_FILENAME}`}
                      </div>
                    </button>
                  ))}
            </div>
          </CardContent>
        </Card>

        {/* Config detail */}
        <Card>
          <CardContent className="p-5">
            {loading ? (
              <div className="space-y-4">
                <Skeleton width="40%" height="2rem" />
                <Skeleton height="150px" />
                <Skeleton width="30%" height="1.5rem" />
                <Skeleton height="150px" />
              </div>
            ) : selected ? (
              <div className="flex flex-col gap-5">
                <h2 className="text-lg font-bold text-foreground">{selected.owner}/{selected.repo}</h2>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {REPO_CONFIG_FILENAME}
                  </p>
                  <pre className="code-block text-xs max-h-64 overflow-auto">
                    {selected.rawYaml ?? `# ${REPO_CONFIG_FILENAME} not found\n${JSON.stringify(selected.parsedJson, null, 2)}`}
                  </pre>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Merged config (JSON)
                  </p>
                  <pre className="code-block text-xs max-h-64 overflow-auto">
                    {JSON.stringify(selected.parsedJson, null, 2)}
                  </pre>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<Settings />}
                title="Select a repository"
                description="Choose a repository from the list to view its configuration and custom rules."
                className="border-0"
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
