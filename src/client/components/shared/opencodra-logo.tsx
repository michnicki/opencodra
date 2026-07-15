import { cn } from '@client/lib/utils';

/**
 * OpenCodra brand lockup: the open-ring "O" glyph (transparent background, lime brand
 * ring) followed by a two-tone wordmark — "Open" in the theme's lime primary token and
 * "Codra" in the surrounding foreground color. Rendered as live text (not baked SVG
 * paths) so it stays crisp and theme-aware. The glyph is sized to the wordmark via `em`
 * units, so the overall lockup scales with font-size; pass a `text-*` class in
 * `className` to control the size (defaults to `text-lg`).
 */
export function OpenCodraLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[0.35em] font-extrabold leading-none tracking-[-0.03em] text-foreground text-lg',
        className,
      )}
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-[1.15em] w-[1.15em] shrink-0"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r="27"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray="132 38"
          transform="rotate(-16 50 50)"
        />
      </svg>
      <span>
        <span className="text-primary">Open</span>Codra
      </span>
    </span>
  );
}
