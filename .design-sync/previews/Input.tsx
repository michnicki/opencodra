import { Input } from 'codra';

const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 320 };
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const label: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--muted-foreground)',
};

export const Fields = () => (
  <div style={col}>
    <div style={field}>
      <span style={label}>Repository</span>
      <Input placeholder="owner/name" />
    </div>
    <div style={field}>
      <span style={label}>Webhook URL</span>
      <Input defaultValue="https://codra.run/webhook" />
    </div>
    <div style={field}>
      <span style={label}>Read only</span>
      <Input placeholder="Managed by admin" disabled />
    </div>
  </div>
);

export const Types = () => (
  <div style={col}>
    <Input type="email" placeholder="you@example.com" />
    <Input type="password" defaultValue="hunter2hunter2" />
    <Input type="number" defaultValue={42} />
  </div>
);
