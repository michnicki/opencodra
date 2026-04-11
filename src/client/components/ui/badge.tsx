import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@client/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:    'bg-primary/10 text-primary border border-primary/20',
        secondary:  'bg-secondary text-secondary-foreground',
        neutral:    'bg-secondary text-secondary-foreground border border-border/60',
        info:       'bg-blue-100 text-blue-700 border border-blue-200',
        success:    'bg-emerald-100 text-emerald-700 border border-emerald-200',
        warning:    'bg-amber-100 text-amber-700 border border-amber-200',
        danger:     'bg-red-100 text-red-700 border border-red-200',
        outline:    'text-foreground border border-border',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
