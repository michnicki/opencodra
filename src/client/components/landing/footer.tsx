import { GitBranch } from 'lucide-react';
import { useTheme } from '@client/lib/theme';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';

export function Footer() {
  const { theme } = useTheme();

  return (
    <footer className="border-t border-border/30 py-10">
      <div className="container mx-auto px-6 md:px-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">

          {/* Brand */}
          <div className="flex items-center gap-2">
            <img 
              src={theme === 'dark' ? codraDark : codraLight} 
              alt="Codra" 
              className="h-6 w-auto" 
            />
            {/* Brand icon only */}

          </div>

          {/* Links */}
          <div className="flex items-center gap-8">
            {[
              { label: 'GitHub', href: 'https://github.com/devarshishimpi/codra', external: true },
              { label: 'Documentation', href: '#', external: false },
              { label: 'Changelog', href: '#', external: false },
            ].map(link => (
              <a
                key={link.label}
                href={link.href}
                target={link.external ? '_blank' : undefined}
                rel={link.external ? 'noopener noreferrer' : undefined}
                className="text-xs text-muted-foreground/50 hover:text-foreground transition-colors font-medium"
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Credit */}
          <p className="text-xs text-muted-foreground/40">
            Built by{' '}
            <a
              href="https://devarshi.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary transition-colors font-semibold"
            >
              Devarshi Shimpi
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
