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

export function pullRequestUrl(repository: RepositoryLocation, prNumber: number) {
  const { provider, owner, repo } = repositoryParts(repository);
  return provider === 'bitbucket'
    ? `https://bitbucket.org/${owner}/${repo}/pull-requests/${prNumber}`
    : `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

export function commitUrl(repository: RepositoryLocation, commitSha: string) {
  const { provider, owner, repo } = repositoryParts(repository);
  const encodedSha = encodeURIComponent(commitSha);
  return provider === 'bitbucket'
    ? `https://bitbucket.org/${owner}/${repo}/commits/${encodedSha}`
    : `https://github.com/${owner}/${repo}/commit/${encodedSha}`;
}

export function reviewUrl(
  repository: RepositoryLocation,
  prNumber: number,
  reviewId: number | null | undefined,
) {
  const provider: VcsProvider = resolveVcsProvider(repository.repositoryVcsProvider);
  if (provider !== 'github' || !reviewId) return null;
  return `${pullRequestUrl(repository, prNumber)}#pullrequestreview-${reviewId}`;
}
