import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, ArrowRight, ExternalLink } from 'lucide-react';
import { api } from '@client/lib/api';
import { useTheme } from '@client/lib/theme';
import { GithubMark } from '@client/components/shared/github-mark';
import { OpenCodraLogo } from '@client/components/shared/opencodra-logo';

const FEATURES = [
  {
    title: 'Understands your codebase',
    desc: 'Reviews diffs with full context from the surrounding code, not just the changed lines.',
  },
  {
    title: 'Flags real issues',
    desc: 'Security vulnerabilities, logic errors, and pattern violations — surfaced before merge.',
  },
  {
    title: 'Configurable per repo',
    desc: 'Set review depth, model chain, and strictness from the dashboard. No config files.',
  },
];

export function LandingPage() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  // Forward an already-authenticated visitor straight to the dashboard instead of
  // showing the marketing/Sign-In page. Uses a side-effect-free probe so anonymous
  // visitors are never bounced. See LoginPage for the post-OAuth KV-consistency
  // rationale this also guards against.
  useEffect(() => {
    let cancelled = false;
    api.probeSession().then((user) => {
      if (!cancelled && user) {
        navigate('/dashboard', { replace: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6 lg:px-8">
          <OpenCodraLogo className="text-lg sm:text-xl" />
          <div className="flex items-center gap-2 sm:gap-3">
            <a
              href="https://github.com/michnicki/opencodra"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-secondary dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_1px_2px_oklch(0%_0_0/0.4),inset_0_1px_0_oklch(100%_0_0/0.06)] dark:hover:bg-white/[0.1] sm:flex"
              aria-label="OpenCodra on GitHub"
            >
              <GithubMark size={14} />
            </a>
            <button
              onClick={toggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-secondary dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_1px_2px_oklch(0%_0_0/0.4),inset_0_1px_0_oklch(100%_0_0/0.06)] dark:hover:bg-white/[0.1]"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <a
              href="/auth/github"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3.5 text-xs font-semibold text-background transition-all hover:bg-foreground/90 active:scale-[0.98] sm:px-4"
            >
              Sign in
              <ArrowRight size={12} />
            </a>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <main className="grid flex-1 grid-cols-1 lg:grid-cols-[1fr_400px]">

        {/* Left — Hero */}
        <div className="flex flex-col justify-between border-b border-border bg-card px-8 py-12 sm:px-14 sm:py-16 lg:border-b-0 lg:border-r">

          <div className="max-w-xl space-y-7">
            <h1 className="font-mono text-4xl font-bold uppercase leading-[1.06] tracking-tight sm:text-5xl">
              AI code review<br />
              on every PR.
            </h1>

            <p className="max-w-md text-[0.95rem] leading-relaxed text-muted-foreground">
              OpenCodra reviews pull requests automatically, checking for bugs,
              security issues, and code patterns specific to your repository.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <a
                href="/auth/github"
                className="inline-flex h-11 items-center gap-2.5 rounded-lg bg-foreground px-5 text-sm font-semibold text-background shadow-md transition-all hover:bg-foreground/90 active:scale-[0.98]"
              >
                <GithubMark size={16} />
                Get started with GitHub
                <ArrowRight size={15} />
              </a>
              <a
                href="https://github.com/michnicki/opencodra#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-5 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-secondary dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_1px_2px_oklch(0%_0_0/0.4),inset_0_1px_0_oklch(100%_0_0/0.06)] dark:hover:bg-white/[0.1]"
              >
                Read the docs
              </a>
            </div>
          </div>

          {/* Footer links */}
          <div className="mt-12 flex items-center gap-5 border-t border-border pt-14 text-xs text-muted-foreground">
            <a
              href="https://github.com/michnicki/opencodra"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <ExternalLink size={11} />
              github.com/michnicki/opencodra
            </a>
          </div>
        </div>

        {/* Right — Features */}
        <div className="flex flex-col justify-center gap-6 border-t border-border px-8 py-12 sm:px-12 sm:py-16 lg:border-t-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground/60">
            What it does
          </p>

          <div className="space-y-7">
            {FEATURES.map((item, i) => (
              <div key={item.title} className="flex gap-4">
                <span className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[0.65rem] font-bold text-primary">
                  {i + 1}
                </span>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                  <p className="text-sm leading-relaxed text-foreground/65 dark:text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}
