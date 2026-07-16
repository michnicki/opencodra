import { Button } from 'opencodra';

const row: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  alignItems: 'center',
};

export const Variants = () => (
  <div style={row}>
    <Button>Run review</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="accent">Accent</Button>
    <Button variant="link">Learn more</Button>
  </div>
);

export const Destructive = () => (
  <div style={row}>
    <Button variant="destructive">Delete</Button>
    <Button variant="destructive-outline">Cancel job</Button>
    <Button variant="warning-outline">Retry</Button>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
  </div>
);

export const States = () => (
  <div style={row}>
    <Button>Enabled</Button>
    <Button disabled>Disabled</Button>
    <Button variant="secondary" disabled>
      Disabled
    </Button>
  </div>
);
