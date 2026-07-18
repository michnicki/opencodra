import { BitbucketMark } from '@client/components/shared/bitbucket-mark';
import { GithubMark } from '@client/components/shared/github-mark';
import { cn } from '@client/lib/utils';
import { resolveVcsProvider, vcsProviderLabel } from '@client/lib/vcs';
import type { VcsProvider } from '@shared/schema';

export function VcsProviderMark({
  provider,
  size = 16,
  className,
}: {
  provider?: VcsProvider | null;
  size?: number;
  className?: string;
}) {
  const resolvedProvider = resolveVcsProvider(provider);
  const label = vcsProviderLabel(resolvedProvider);
  const Mark = resolvedProvider === 'bitbucket' ? BitbucketMark : GithubMark;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
    >
      <Mark size={size} />
    </span>
  );
}
