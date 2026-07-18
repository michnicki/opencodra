import * as React from 'react';
import { cn } from '@client/lib/utils';

interface PageHeaderProps extends React.HTMLAttributes<HTMLElement> {
  category?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  versionBadge?: string;
}

export function PageHeader({ 
  category, 
  title, 
  description, 
  actions, 
  versionBadge,
  className, 
  ...props 
}: PageHeaderProps) {
  return (
    <>
      <header
        className={cn('flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between', className)}
        {...props}
      >
        <div className="max-w-2xl">
          {category && (
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_12%,transparent)]" />
              {category}
            </div>
          )}
          <h1
            className="flex items-center gap-3 text-2xl font-semibold leading-tight text-foreground sm:text-[2rem]"
            style={{ letterSpacing: '-0.045em' }}
          >
            {title}
            {versionBadge && (
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-semibold tracking-normal text-primary">
                v{versionBadge}
              </span>
            )}
          </h1>
          {description && (
            <div className="mt-2 text-sm leading-6 text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
            {actions}
          </div>
        )}
      </header>
    </>
  );
}
