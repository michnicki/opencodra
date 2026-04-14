import { Badge, type BadgeProps } from '@client/components/ui/badge';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

function getTone(value: string): BadgeVariant {
  switch (value) {
    case 'done':
    case 'approve':
      return 'success';
    case 'running':
      return 'info';
    case 'comment':
      return 'warning';
    case 'failed':
    case 'request_changes':
      return 'danger';
    case 'queued':
    case 'superseded':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function StatusBadge({ label }: { label: string }) {
  return (
    <Badge variant={getTone(label)} className="capitalize">
      {label.replace(/_/g, ' ')}
    </Badge>
  );
}
