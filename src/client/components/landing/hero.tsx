import { Link } from 'react-router-dom';
import { Button } from '@client/components/ui/button';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const TITLES = ['OPEN SOURCE CODE REVIEW', 'PR INTELLIGENCE LAYER'];
const GLITCH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*<>[]{}|/\\';
const SCRAMBLE_DURATION = 900;
const SCRAMBLE_STEPS   = 18;

function useScrambleText(target: string) {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let step = 0;
    const interval = SCRAMBLE_DURATION / SCRAMBLE_STEPS;

    const tick = () => {
      const progress = step / SCRAMBLE_STEPS;
      const resolvedCount = Math.floor(progress * target.length);

      setDisplay(
        target
          .split('')
          .map((char, i) => {
            if (char === ' ') return ' ';
            if (i < resolvedCount) return char;
            return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
          })
          .join(''),
      );

      step++;
      if (step <= SCRAMBLE_STEPS) {
        frameRef.current = setTimeout(tick, interval);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = setTimeout(tick, 120);
    return () => { if (frameRef.current) clearTimeout(frameRef.current); };
  }, [target]);

  return display;
}

export function Hero() {
  const [titleIndex, setTitleIndex] = useState(0);
  const [isExiting, setIsExiting]   = useState(false);
  const [activeTitle, setActiveTitle] = useState(TITLES[0]);
  const [mounted, setMounted] = useState(false);
  const scrambled = useScrambleText(activeTitle);

  useEffect(() => {
    // Small delay so the entrance animation fires cleanly after nav
    const t = setTimeout(() => setMounted(true), 80);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const cycle = setInterval(() => {
      setIsExiting(true);

      setTimeout(() => {
        setTitleIndex(prev => {
          const next = (prev + 1) % TITLES.length;
          setActiveTitle(TITLES[next]);
          return next;
        });
        setIsExiting(false);
      }, 350);
    }, 3800);

    return () => clearInterval(cycle);
  }, []);

  const enterStyle = (delay: number): React.CSSProperties => ({
    opacity: mounted ? 1 : 0,
    transform: mounted ? 'translateY(0)' : 'translateY(20px)',
    transition: `opacity 0.7s var(--ease-out-expo) ${delay}ms, transform 0.7s var(--ease-out-expo) ${delay}ms`,
  });

  return (
    <section className="relative pt-24 pb-0 overflow-hidden">
      <div className="container mx-auto px-6 relative z-10">

        {/* Heading */}
        <h1
          className="text-4xl font-black leading-[0.85] tracking-tighter text-foreground mb-8"
          style={enterStyle(0)}
        >
          <span
            aria-label={activeTitle}
            style={{
              display: 'block',
              transition: 'opacity 0.35s cubic-bezier(0.16,1,0.3,1), transform 0.35s cubic-bezier(0.16,1,0.3,1), filter 0.35s cubic-bezier(0.16,1,0.3,1)',
              opacity: isExiting ? 0 : 1,
              transform: isExiting ? 'translateY(-6px) skewX(-2deg)' : 'translateY(0) skewX(0deg)',
              filter: isExiting ? 'blur(4px)' : 'blur(0px)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '-0.04em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {scrambled.split('').map((char, i) => (
              <span
                key={`${titleIndex}-${i}`}
                style={{
                  display: 'inline-block',
                  color: char !== TITLES[titleIndex][i] ? 'var(--primary)' : 'inherit',
                  transition: 'color 0.08s',
                }}
              >
                {char === ' ' ? '\u00A0' : char}
              </span>
            ))}
          </span>
          <span
            className="block text-muted-foreground/40 mt-1"
            style={enterStyle(80)}
          >
            FOR EVERYONE
          </span>
        </h1>

        {/* Description + CTAs */}
        <div
          className="flex flex-col lg:flex-row lg:items-end gap-8 lg:gap-16 mb-16"
          style={enterStyle(180)}
        >
          <p className="text-base lg:text-lg text-muted-foreground font-medium leading-relaxed max-w-lg">
            Codra is a self-hosted AI reviewer that understands your repository's structure, enforces your patterns, and flags bugs before they ship — on every pull request.
          </p>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <Link to="/login">
              <Button
                size="lg"
                className="h-12 gap-3 px-8 text-sm font-black whitespace-nowrap"
                style={{ transition: 'transform 0.15s var(--ease-out-quart), box-shadow 0.2s' }}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = 'scale(1.04)';
                  e.currentTarget.style.boxShadow = '0 8px 24px color-mix(in oklch, var(--primary) 30%, transparent)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'scale(1)';
                  e.currentTarget.style.boxShadow = '';
                }}
                onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
                onMouseUp={e => (e.currentTarget.style.transform = 'scale(1.04)')}
              >
                Deploy Core <ArrowRight size={16} strokeWidth={3} />
              </Button>
            </Link>
            <a href="https://github.com/devarshishimpi/codra" target="_blank" rel="noopener noreferrer">
              <Button
                variant="ghost"
                size="lg"
                className="h-12 px-6 text-[10px] font-bold tracking-[0.2em] uppercase whitespace-nowrap"
                style={{ transition: 'background-color 0.2s, transform 0.15s var(--ease-out-quart)' }}
                onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.03)')}
                onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
                onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.97)')}
                onMouseUp={e => (e.currentTarget.style.transform = 'scale(1.03)')}
              >
                GitHub Repository
              </Button>
            </a>
          </div>
        </div>

        {/* Feature Strip */}
        <div
          className="grid grid-cols-1 md:grid-cols-3 border-t border-border/60 divide-y md:divide-y-0 md:divide-x divide-border/60 uppercase tracking-widest text-[9px] lg:text-[10px] font-black text-muted-foreground/60"
          style={enterStyle(300)}
        >
          {[
            'Zero-latency deep graph analysis',
            'Architectural pattern matching',
            'Security-first AI suggestions',
          ].map((label, i) => (
            <div
              key={label}
              className="flex items-center gap-3 py-5 group"
              style={{ paddingLeft: i > 0 ? '2rem' : undefined, paddingRight: i < 2 ? '2rem' : undefined }}
            >
              <CheckCircle2
                size={13}
                className="text-primary shrink-0"
                style={{ transition: 'transform 0.2s var(--ease-out-quart)' }}
              />
              <span style={{ transition: 'color 0.2s' }} className="group-hover:text-muted-foreground/90">
                {label}
              </span>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
