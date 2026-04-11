type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

function getTone(value: string): BadgeTone {
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
    default:
      return 'neutral';
  }
}

export function StatusBadge({ label }: { label: string }) {
  return <span className={`badge ${getTone(label)}`}>{label.replace(/_/g, ' ')}</span>;
}
