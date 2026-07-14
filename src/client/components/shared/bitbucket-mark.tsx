/** Bitbucket brand mark — mirrors GithubMark's API. Uses currentColor only (D-23 — no Bitbucket brand blue). */
export function BitbucketMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M1.5 3.6a.6.6 0 0 1 .6-.7h19.8a.6.6 0 0 1 .6.7L19.7 20.3a.75.75 0 0 1-.74.63H5.04a.75.75 0 0 1-.74-.63L1.5 3.6Zm12.87 12.28h-4.7l-1.27-6.6h7.13l-1.16 6.6Z" />
    </svg>
  );
}
