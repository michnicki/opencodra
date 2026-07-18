import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@server/core/logger';

// DB-free unit test for the structured logger's redaction policy. The logger emits a single
// JSON string to console.log/warn/error; we spy on those, parse the emitted JSON, and assert
// on the redacted fields. These tests guard that:
//   - ambient store + logger context values are redacted (not just `data`)
//   - secrets embedded inside otherwise-ordinary strings (error messages/stacks) are scrubbed
//   - existing key-based and whole-string redaction is NOT weakened
//   - ordinary log text is left untouched

type Captured = Record<string, any>;

function captureConsole() {
  const outputs: Captured[] = [];
  const record = (args: any[]) => {
    const first = args[0];
    if (typeof first === 'string') {
      try {
        outputs.push(JSON.parse(first));
      } catch {
        // Not a JSON log line — ignore.
      }
    }
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => record(args)),
    vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => record(args)),
    vi.spyOn(console, 'error').mockImplementation((...args: any[]) => record(args)),
  ];
  return {
    outputs,
    restore: () => spies.forEach((s) => s.mockRestore()),
    last: () => outputs[outputs.length - 1],
  };
}

describe('logger redaction', () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
  });

  it('redacts a Bearer token carried in logger context', () => {
    new Logger().withContext({ authorization: 'Bearer abc123def456ghi' }).info('request');
    expect(cap.last().authorization).toBe('[REDACTED]');
    expect(cap.last().message).toBe('request');
  });

  it('scrubs a secret embedded inside an error stack/message', () => {
    const err = new Error('upstream rejected key sk-ABCD1234EFGH5678IJKL for provider');
    new Logger().error('provider failed', err);
    const serialized = JSON.stringify(cap.last());
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('sk-ABCD1234EFGH5678IJKL');
  });

  it('scrubs a GitHub token embedded in an ambient store value via runWithContext', () => {
    new Logger().runWithContext(
      { detail: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected' },
      () => {
        new Logger().info('webhook');
      },
    );
    expect(cap.last().detail).toContain('[REDACTED]');
    expect(cap.last().detail).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    // Surrounding words are preserved — only the token is replaced.
    expect(cap.last().detail).toContain('token');
    expect(cap.last().detail).toContain('rejected');
  });

  it('still redacts values under sensitive keys (existing behavior preserved)', () => {
    new Logger().info('config', { api_key: 'super-secret-value', note: 'ok' });
    expect(cap.last().data.api_key).toBe('[REDACTED]');
    expect(cap.last().data.note).toBe('ok');
  });

  it('still redacts a whole JWT-shaped string (existing behavior preserved)', () => {
    new Logger().info('auth', { probe: 'aaaa.bbbb.cccc' });
    expect(cap.last().data.probe).toBe('[REDACTED]');
  });

  it('leaves ordinary log messages and values untouched', () => {
    new Logger().withContext({ repo: 'acme/widgets' }).info('review started', { count: 3 });
    expect(cap.last().message).toBe('review started');
    expect(cap.last().repo).toBe('acme/widgets');
    expect(cap.last().data.count).toBe(3);
  });
});
