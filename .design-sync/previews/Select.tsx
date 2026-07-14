import { Select } from 'codra';

const noop = () => {};

const ranges = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

const models = [
  { value: 'sonnet', label: 'Claude Sonnet 4.5' },
  { value: 'opus', label: 'Claude Opus 4.1' },
  { value: 'gpt', label: 'GPT-4o' },
];

// The listbox opens on click (portaled + always mounted), so the card shows the
// closed triggers with their selected values; the live card opens on click.
// Pinned to cardMode "single" so the always-mounted portal panel doesn't escape
// a grid cell. Both variants shown stacked.
export const Variants = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: 240 }}>
    <Select label="Time range" value="30d" onValueChange={noop} options={ranges} variant="page" />
    <Select label="Review model" value="sonnet" onValueChange={noop} options={models} variant="card" />
  </div>
);
