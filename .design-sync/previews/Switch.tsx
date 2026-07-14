import { Switch } from 'codra';

const rowItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const text: React.CSSProperties = { fontSize: 14, color: 'var(--foreground)' };

export const Settings = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={rowItem}>
      <Switch defaultChecked />
      <span style={text}>Auto-review new pull requests</span>
    </div>
    <div style={rowItem}>
      <Switch />
      <span style={text}>Notify me when a review fails</span>
    </div>
    <div style={rowItem}>
      <Switch disabled />
      <span style={text}>Enterprise SSO</span>
    </div>
  </div>
);
