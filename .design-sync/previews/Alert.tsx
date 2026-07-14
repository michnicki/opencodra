import { Alert } from 'codra';

const title: React.CSSProperties = { margin: 0, fontWeight: 600 };
const body: React.CSSProperties = { margin: '2px 0 0', opacity: 0.85 };

export const Info = () => (
  <Alert>
    <p style={title}>Automatic reviews enabled</p>
    <p style={body}>Codra will review new pushes to this pull request as they arrive.</p>
  </Alert>
);

export const Success = () => (
  <Alert variant="success">
    <p style={title}>Review complete</p>
    <p style={body}>No blocking issues found across 14 changed files.</p>
  </Alert>
);

export const Warning = () => (
  <Alert variant="warning">
    <p style={title}>Rate limit approaching</p>
    <p style={body}>Model requests are near the hourly quota — reviews may be delayed.</p>
  </Alert>
);

export const Destructive = () => (
  <Alert variant="destructive">
    <p style={title}>Review failed</p>
    <p style={body}>The model provider returned an unrecoverable error. Check your API key.</p>
  </Alert>
);
