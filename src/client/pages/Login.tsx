import { FormEvent, useState } from 'react';
import { api } from '@client/lib/api';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await api.login({ password });
      location.href = '/';
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Login failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div>
          <div className="eyebrow">Codra</div>
          <h1>PR review control room</h1>
          <p className="muted">Use the shared dashboard password to inspect jobs, repo config, and review history.</p>
        </div>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter dashboard password"
            autoFocus
          />
        </label>

        {error ? <div className="error-box">{error}</div> : null}

        <button className="primary-button" disabled={pending} type="submit">
          {pending ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
