import React from 'react';
import { cn } from '@client/lib/utils';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** Bullet-point hints shown with green dot prefix (Beetle-style) */
  hints?: string[];
  /** Renders an outlined link button below the hints */
  linkAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  /** Legacy single action button */
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({ icon, title, description, hints, linkAction, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-8 py-16 text-center',
        className,
      )}
    >
      {icon && (
        <div className="flex h-14 w-14 items-center justify-center text-muted-foreground/40 [&_svg]:h-9 [&_svg]:w-9 [&_svg]:stroke-[1.35]">
          {icon}
        </div>
      )}
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>

      {hints && hints.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1.5 text-left">
          {hints.map((hint, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary opacity-80" />
              <span>{hint}</span>
            </li>
          ))}
        </ul>
      )}

      {linkAction && (
        <div className="mt-3">
          {linkAction.href ? (
            <a
              href={linkAction.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-md border border-border bg-card px-4 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-secondary hover:border-border/80"
            >
              {linkAction.label}
            </a>
          ) : (
            <button
              type="button"
              onClick={linkAction.onClick}
              className="inline-flex items-center rounded-md border border-border bg-card px-4 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-secondary hover:border-border/80"
            >
              {linkAction.label}
            </button>
          )}
        </div>
      )}

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 inline-flex items-center rounded border border-border/60 bg-transparent px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
