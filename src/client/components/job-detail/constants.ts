import { AlertCircle, AlertTriangle, Lightbulb, Code2, Sparkles } from 'lucide-react';
import type { ElementType } from 'react';

export const severityConfig: Record<string, { svg?: string; icon: ElementType; bg: string; border: string; text: string; iconColor: string }> = {
  P0:   { svg: '/icons/p0-icon.svg', icon: AlertCircle, bg: 'bg-red-50',    border: 'border-red-200',   text: 'text-red-700',   iconColor: 'text-red-500' },
  P1:   { svg: '/icons/p1-icon.svg', icon: AlertTriangle, bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', iconColor: 'text-orange-500' },
  P2:   { svg: '/icons/p2-icon.svg', icon: Lightbulb,  bg: 'bg-amber-50',   border: 'border-amber-200',  text: 'text-amber-700',  iconColor: 'text-amber-500' },
  P3:   { svg: '/icons/p3-icon.svg', icon: Code2,   bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', iconColor: 'text-blue-500' },
  nit:  { svg: '/icons/nit-icon.svg', icon: Sparkles,   bg: 'bg-muted/60',  border: 'border-border/60', text: 'text-muted-foreground', iconColor: 'text-muted-foreground' },
};
