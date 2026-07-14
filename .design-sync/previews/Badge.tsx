import { Badge } from 'codra';

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };

export const Variants = () => (
  <div style={row}>
    <Badge>Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="info">Info</Badge>
    <Badge variant="success">Success</Badge>
    <Badge variant="warning">Warning</Badge>
    <Badge variant="danger">Danger</Badge>
    <Badge variant="outline">Outline</Badge>
  </div>
);

export const ReviewStatuses = () => (
  <div style={row}>
    <Badge variant="success">Approved</Badge>
    <Badge variant="info">Running</Badge>
    <Badge variant="warning">Comment</Badge>
    <Badge variant="danger">Changes requested</Badge>
    <Badge variant="neutral">Queued</Badge>
  </div>
);
