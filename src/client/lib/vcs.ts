import type { JobSummary, VcsProvider } from '@shared/schema';

export function resolveVcsProvider(provider?: VcsProvider | null): VcsProvider {
  return provider === 'bitbucket' ? 'bitbucket' : 'github';
}

export function vcsProviderLabel(provider?: VcsProvider | null) {
  return resolveVcsProvider(provider) === 'bitbucket' ? 'Bitbucket' : 'GitHub';
}

type RepositoryLocation = Pick<
  JobSummary,
  'owner' | 'repo' | 'repositoryVcsProvider' | 'repositoryWorkspace'
>;

function repositoryParts(repository: RepositoryLocation) {
  const provider = resolveVcsProvider(repository.repositoryVcsProvider);
  const owner = provider === 'bitbucket'
    ? repository.repositoryWorkspace ?? repository.owner
    : repository.owner;

  return {
    provider,
    owner: encodeURIComponent(owner),
    repo: encodeURIComponent(repository.repo),
  };
}

/**
 * Defense-in-depth for anything bound straight into an <a href>. The VCS URLs
 * here are built from a hardcoded https base plus encodeURIComponent'd parts, so
 * a dangerous scheme should be impossible — but if a malformed repository shape
 * or future refactor ever produced a `javascript:`, `data:`, or otherwise
 * non-http(s) URL, we drop the link entirely rather than render a hostile
 * anchor. Returns the original string only when it parses as http(s).
 */
function safeHttpUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined;
}

export function pullRequestUrl(repository: RepositoryLocation, prNumber: number) {
  const { provider, owner, repo } = repositoryParts(repository);
  return provider === 'bitbucket'
    ? `https://bitbucket.org/${owner}/${repo}/pull-requests/${prNumber}`
    : `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

export function commitUrl(
  repository: RepositoryLocation,
  commitSha: string,
): string | undefined {
  const { provider, owner, repo } = repositoryParts(repository);
  const encodedSha = encodeURIComponent(commitSha);
  const url = provider === 'bitbucket'
    ? `https://bitbucket.org/${owner}/${repo}/commits/${encodedSha}`
    : `https://github.com/${owner}/${repo}/commit/${encodedSha}`;
  return safeHttpUrl(url);
}

export function reviewUrl(
  repository: RepositoryLocation,
  prNumber: number,
  reviewId: number | null | undefined,
): string | null {
  const provider: VcsProvider = resolveVcsProvider(repository.repositoryVcsProvider);
  if (provider !== 'github' || !reviewId) return null;
  return safeHttpUrl(`${pullRequestUrl(repository, prNumber)}#pullrequestreview-${reviewId}`) ?? null;
}
