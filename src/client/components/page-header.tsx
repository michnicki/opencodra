import * as React from 'react';
import { cn } from '@client/lib/utils';

interface PageHeaderProps extends React.HTMLAttributes<HTMLElement> {
  category: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ 
  category, 
  title, 
  description, 
  actions, 
  className, 
  ...props 
}: PageHeaderProps) {
  return (
    <header 
      className={cn('flex items-end justify-between', className)} 
      {...props}
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-primary/70 mb-1">
          {category}
        </p>
        <h1 
          className="text-2xl font-bold text-foreground" 
          style={{ letterSpacing: '-0.025em' }}
        >
          {title}
        </h1>
        {description && (
          <div className="mt-1 text-sm text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-3">
          {actions}
        </div>
      )}
    </header>
  );
}
