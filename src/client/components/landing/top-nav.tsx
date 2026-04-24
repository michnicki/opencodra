import { Link } from 'react-router-dom';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@client/components/ui/button';
import { useTheme } from '@client/lib/theme';
import { useEffect, useState } from 'react';
import codraDark from '@/assets/codra-fullicon-dark.svg';
import codraLight from '@/assets/codra-fullicon-light.svg';

export function TopNav() {
  const { theme, toggleTheme } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const NAV_LINKS = [
    { label: 'How it works', href: '#how' },
    { label: 'Features', href: '#features' },
    { label: 'Open source', href: '#oss' },
  ];

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 h-14 flex items-center justify-between px-6 md:px-10 border-b"
      style={{
        borderColor: scrolled ? 'var(--border)' : 'transparent',
        backgroundColor: scrolled
          ? 'color-mix(in oklch, var(--background) 92%, transparent)'
          : 'transparent',
        backdropFilter: scrolled ? 'blur(20px) saturate(1.6)' : 'none',
        boxShadow: scrolled
          ? '0 1px 24px oklch(0% 0 0 / 0.06)'
          : 'none',
        transition:
          'background-color 0.35s var(--ease-out-expo), border-color 0.35s var(--ease-out-expo), box-shadow 0.35s var(--ease-out-expo), backdrop-filter 0.35s var(--ease-out-expo)',
        /* entrance */
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(-8px)',
      }}
    >
      {/* Logo */}
      <Link
        to="/"
        className="flex items-center gap-2 group"
        style={{
          transition: 'opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo)',
          transitionDelay: '0ms',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(-6px)',
        }}
      >
        <img
          src={theme === 'dark' ? codraDark : codraLight}
          alt="Codra"
          className="h-8 w-auto"
          style={{ transition: 'transform 0.25s var(--ease-out-quart)' }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.06)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
        />
      </Link>

      {/* Center nav */}
      <div
        className="hidden md:flex items-center gap-8"
        style={{
          transition: 'opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo)',
          transitionDelay: '80ms',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(-6px)',
        }}
      >
        {NAV_LINKS.map(item => (
          <a
            key={item.label}
            href={item.href}
            className="relative text-sm text-muted-foreground hover:text-foreground font-medium group"
            style={{ transition: 'color 0.2s' }}
          >
            {item.label}
            {/* animated underline */}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                bottom: '-2px',
                left: 0,
                height: '1.5px',
                width: '100%',
                borderRadius: '999px',
                backgroundColor: 'var(--primary)',
                transform: 'scaleX(0)',
                transformOrigin: 'left',
                transition: 'transform 0.25s var(--ease-out-quart)',
              }}
              className="group-hover:[transform:scaleX(1)]"
            />
          </a>
        ))}
      </div>

      {/* Right actions */}
      <div
        className="flex items-center gap-3"
        style={{
          transition: 'opacity 0.5s var(--ease-out-expo), transform 0.5s var(--ease-out-expo)',
          transitionDelay: '160ms',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(-6px)',
        }}
      >
        <button
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
          aria-label="Toggle theme"
          style={{ transition: 'color 0.2s, background-color 0.2s, transform 0.15s' }}
          onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.9)')}
          onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          <span
            style={{
              display: 'inline-flex',
              transition: 'transform 0.3s var(--ease-out-expo), opacity 0.2s',
            }}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </span>
        </button>
        <Link to="/login">
          <Button
            size="sm"
            className="h-8 px-4 text-xs font-semibold transition-all hover:scale-[1.04] active:scale-95"
          >
            Sign in
          </Button>
        </Link>
      </div>
    </nav>
  );
}
