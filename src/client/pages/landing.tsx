import { Sun, Moon, ArrowRight, ExternalLink } from 'lucide-react';
import { useTheme } from '@client/lib/theme';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';

export function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-svh bg-background text-foreground flex flex-col">

      {/* Header */}
      <header className="border-b border-border px-8 h-14 flex items-center justify-between shrink-0">
        <img
          src={theme === 'dark' ? codraDark : codraLight}
          className="h-8"
          alt="Codra"
        />
        <button
          onClick={toggleTheme}
          className="h-8 w-8 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </header>

      {/* Body */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_380px]">

        {/* Left — Identity & CTA */}
        <div className="flex flex-col justify-between p-10 md:p-20 lg:border-r border-border border-b lg:border-b-0">

          <div className="space-y-10 max-w-xl">
            <div className="space-y-5">
              <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] font-mono uppercase">
                AI code review<br />
                on every PR.
              </h1>
              <p className="text-base text-muted-foreground leading-relaxed max-w-sm">
                Codra reviews pull requests automatically — checking for bugs, security issues, 
                and code patterns specific to your repository.
              </p>
            </div>

            <a href="/auth/github">
              <button className="inline-flex items-center gap-3 h-11 px-6 bg-primary text-primary-foreground text-sm font-semibold rounded hover:brightness-110 active:scale-[0.98] transition-all">
                Sign in with GitHub
                <ArrowRight size={16} />
              </button>
            </a>
          </div>

          {/* Footer links */}
          <div className="flex items-center gap-6 pt-16 text-xs text-muted-foreground">
            <a
              href="https://codra.run"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-foreground transition-colors"
            >
              <ExternalLink size={12} />
              codra.run
            </a>
            <a
              href="https://github.com/devarshishimpi/codra"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-foreground transition-colors"
            >
              <ExternalLink size={12} />
              GitHub
            </a>
          </div>
        </div>

        {/* Right — What it does */}
        <div className="bg-secondary/30 p-10 flex flex-col justify-center gap-10">
          <div className="space-y-6">
            {[
              {
                title: 'Understands your codebase',
                desc: 'Reviews diffs with context from the surrounding code, not just the changed lines.',
              },
              {
                title: 'Flags real issues',
                desc: 'Security vulnerabilities, logic errors, and pattern violations — surfaced before merge.',
              },
              {
                title: 'Configurable per repo',
                desc: 'Set review depth, model chain, and strictness from the dashboard. No config files.',
              },
            ].map((item) => (
              <div key={item.title} className="space-y-1.5 border-l-2 border-primary pl-4">
                <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}
