import * as React from 'react';
import { cn } from '@client/lib/utils';
import { LucideIcon } from 'lucide-react';
import { Skeleton } from '@client/components/shared/skeleton';
import { Sparkline } from '@client/components/shared/sparkline';

interface StatsItem {
  label: string;
  value: string | number | null;
  icon: LucideIcon;
  trend?: number[];
}

interface StatsGridProps extends React.HTMLAttributes<HTMLDivElement> {
  items: StatsItem[];
  columns?: number;
}

export function StatsGrid({ items, columns = 4, className, ...props }: StatsGridProps) {
  const gridCols = {
    2: 'grid-cols-2',
    4: 'grid-cols-2 sm:grid-cols-4',
  }[columns as 2 | 4] || 'grid-cols-2 sm:grid-cols-4';

  return (
    <div 
      className={cn(
        'grid gap-3',
        gridCols,
        className
      )}
      {...props}
    >
      {items.map(({ label, value, icon: Icon, trend }, i) => (
        <article
          key={i} 
          className="utility-stat-card group relative flex min-h-[148px] flex-col overflow-hidden rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-sm)] sm:p-5"
        >
          {trend && <Sparkline data={trend} />}

          <div className="relative z-10 flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5 text-muted-foreground">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-sm">
                <Icon size={13} strokeWidth={2} />
              </span>
              <span className="stat-label">{label}</span>
            </div>
            <span className="font-mono text-[9px] font-medium tracking-[0.08em] text-muted-foreground/55">
              0{i + 1}
            </span>
          </div>

          <div className="relative z-10 mt-auto flex items-end justify-between gap-2 pt-6">
            {value !== null ? (
              <p className="stat-number">{value}</p>
            ) : (
              <Skeleton height={36} width={60} />
            )}
            <span className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/50">
              selected range
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}
