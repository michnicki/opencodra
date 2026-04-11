import { FormEvent, useState } from 'react';
import { api } from '@client/lib/api';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Bot } from 'lucide-react';

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
    <div className="min-h-svh flex items-center justify-center bg-background p-6">
      {/* Background gradient blobs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 h-[600px] w-[600px] rounded-full bg-accent/8 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-[500px] w-[500px] rounded-full bg-primary/6 blur-3xl" />
      </div>

      <form
        onSubmit={onSubmit}
        className="relative z-10 w-full max-w-sm flex flex-col gap-6 rounded-2xl border border-border/60 bg-card/80 p-8 shadow-xl backdrop-blur-xl"
      >
        {/* Brand */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
            <Bot size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Codra</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              PR review control room
            </p>
          </div>
        </div>

        <p className="text-center text-sm text-muted-foreground -mt-2 leading-relaxed">
          Use the shared dashboard password to inspect jobs, repo config, and review history.
        </p>

        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Password
          </label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter dashboard password"
            autoFocus
            className="h-11 text-base"
          />
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <Button type="submit" disabled={pending} size="lg" className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
