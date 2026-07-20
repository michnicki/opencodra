import { describe, it, expect, vi } from 'vitest';
import { classifyComment, type CommentContext } from '@server/core/commands';
import type { BotIdentityResolver } from '@server/core/bot-identity';
import type { VcsProvider } from '@server/vcs/types';
import { repoConfigSchema, type RepoConfig } from '@shared/schema';
import { createTestEnv } from './helpers';

// Phase 11 Plan 03 — core/commands.ts classifyComment (self-filter-first, prefix-only mention,
// complete-alias grammar). These are UNIT tests (no DB, no Postgres) running in the `node` vitest
// project against the mocked MemoryKV APP_KV binding from test/helpers.ts.
//
// CMD-01..05/CMD-07: the self-filter on the resolved NON-NULL immutable accountId is line one of
// classification (echo-loop defense, D-03); the mention is matched PREFIX-ONLY; a command requires a
// COMPLETE normalized alias; a non-command mention falls through to Q&A only when qa is enabled.

const BOT_ACCOUNT_ID = 'bot-account-immutable-id';

function botResolver(accountId = BOT_ACCOUNT_ID): BotIdentityResolver {
  return { resolveIdentity: vi.fn(async () => ({ accountId, login: 'codra-app' })) };
}

// A minimal provider stub — classifyComment only reads `provider.name` (it delegates identity
// resolution to the resolver + getBotIdentity, and never calls a network method during classify).
function makeProvider(name: 'github' | 'bitbucket' = 'github'): VcsProvider {
  return { name } as unknown as VcsProvider;
}

function cfg(
  opts: { commands?: boolean; qa?: boolean; allow?: string[]; mention?: string | false } = {},
): RepoConfig {
  return repoConfigSchema.parse({
    review: {
      mention_trigger: opts.mention ?? '@codra-app',
      interactive: {
        commands: { enabled: opts.commands ?? true, bitbucket_allowed_account_ids: opts.allow ?? [] },
        qa: { enabled: opts.qa ?? true },
      },
    },
  });
}

function ctx(overrides: Partial<CommentContext> = {}): CommentContext {
  return {
    authorId: 'human-author-id',
    authorLogin: 'octocat',
    body: '',
    prNumber: 42,
    owner: 'acme',
    repo: 'widgets',
    workspace: 'acme',
    ...overrides,
  };
}

describe('classifyComment — self-filter first (D-03, echo-loop defense)', () => {
  it('returns ignored/self_filtered when the author IS the bot (immutable accountId match)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ authorId: BOT_ACCOUNT_ID, body: '@codra-app review' }),
      cfg(),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'self_filtered' });
  });

  it('returns ignored/identity_unresolved when the bot accountId cannot be resolved (null)', async () => {
    const env = createTestEnv();
    // No resolver + cold cache => getBotIdentity returns accountId null (seed-only). The self-filter
    // cannot be guaranteed, so classification must NOT proceed to a command/qa parse.
    const result = await classifyComment(
      env,
      makeProvider('github'),
      undefined,
      ctx({ body: '@codra-app review' }),
      cfg(),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'identity_unresolved' });
  });

  it('self-filter is checked BEFORE the feature toggle (bot comment with features off is still self_filtered)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ authorId: BOT_ACCOUNT_ID, body: '@codra-app review' }),
      cfg({ commands: false, qa: false }),
    );
    // identity_unresolved / self_filtered take precedence over feature_disabled.
    expect(result).toEqual({ kind: 'ignored', reason: 'self_filtered' });
  });
});

describe('classifyComment — feature gating', () => {
  it('returns ignored/feature_disabled when neither commands nor qa is enabled', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app review' }),
      cfg({ commands: false, qa: false }),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'feature_disabled' });
  });

  it('a non-command mention with commands ON but qa OFF is feature_disabled', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app why is this slow?' }),
      cfg({ commands: true, qa: false }),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'feature_disabled' });
  });

  it('a command alias with commands OFF but qa ON is treated as a question (commands feature off)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app pause' }),
      cfg({ commands: false, qa: true }),
    );
    expect(result).toEqual({ kind: 'qa', question: 'pause' });
  });
});

describe('classifyComment — prefix-only mention (D-01)', () => {
  it('rejects prose-before-mention as ignored/not_mention (NOT body.includes)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: 'hey please @codra-app review this' }),
      cfg(),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'not_mention' });
  });

  it('accepts leading whitespace before the mention', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '   @codra-app help' }),
      cfg(),
    );
    expect(result).toMatchObject({ kind: 'command', name: 'help' });
  });

  it('rejects a mention with no boundary (glued token) as not_mention', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-appreview' }),
      cfg(),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'not_mention' });
  });

  it('an empty body is not_mention', async () => {
    const env = createTestEnv();
    const result = await classifyComment(env, makeProvider('github'), botResolver(), ctx({ body: '' }), cfg());
    expect(result).toEqual({ kind: 'ignored', reason: 'not_mention' });
  });

  it('a bare mention with no following token is not_mention', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app   ' }),
      cfg(),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'not_mention' });
  });

  it('a false mention_trigger disables mention-triggered commands (not_mention)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app review' }),
      cfg({ mention: false }),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'not_mention' });
  });

  it('honors a custom mention_trigger literally (no regex interpretation)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@my-bot.v2 review' }),
      cfg({ mention: '@my-bot.v2' }),
    );
    expect(result).toMatchObject({ kind: 'command', name: 'review' });
  });
});

describe('classifyComment — D-02 alias table (complete alias required)', () => {
  const env = () => createTestEnv();
  const run = async (body: string, options?: Parameters<typeof cfg>[0]) =>
    classifyComment(env(), makeProvider('github'), botResolver(), ctx({ body }), cfg(options));

  it.each([
    ['@codra-app review', 'review'],
    ['@codra-app review this', 'review'],
    ['@codra-app review this pr', 'review'],
    ['@codra-app review rest', 'review-rest'],
    ['@codra-app rest', 'review-rest'],
    ['@codra-app continue', 'review-rest'],
    ['@codra-app pause', 'pause'],
    ['@codra-app resume', 'resume'],
    ['@codra-app help', 'help'],
    ['@codra-app ?', 'help'],
    ['@codra-app commands', 'help'],
  ])('%s -> command %s', async (body, name) => {
    const result = await run(body);
    expect(result).toMatchObject({ kind: 'command', name });
  });

  it('is case-insensitive', async () => {
    expect(await run('@codra-app REVIEW THIS PR')).toMatchObject({ kind: 'command', name: 'review' });
  });

  it('is tolerant of trailing punctuation', async () => {
    expect(await run('@codra-app review.')).toMatchObject({ kind: 'command', name: 'review' });
    expect(await run('@codra-app review this pr!')).toMatchObject({ kind: 'command', name: 'review' });
  });

  it('collapses internal whitespace', async () => {
    expect(await run('@codra-app   review    this   pr')).toMatchObject({ kind: 'command', name: 'review' });
  });

  it("a partial-alias-plus-extra ('review this code?') is NOT a command — it becomes qa", async () => {
    expect(await run('@codra-app review this code?')).toEqual({
      kind: 'qa',
      question: 'review this code?',
    });
  });

  it("'pause please' is NOT the pause command (pause takes no arg) — it becomes qa", async () => {
    expect(await run('@codra-app pause please')).toEqual({ kind: 'qa', question: 'pause please' });
  });
});

describe('classifyComment — reject grammar (D-09, reply thread)', () => {
  it('reject carries findingRef from the reply thread (parentRef) and the token remainder as args', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app reject this is a false positive', parentRef: '42:1001' }),
      cfg(),
    );
    expect(result).toEqual({
      kind: 'command',
      name: 'reject',
      args: 'this is a false positive',
      findingRef: '42:1001',
    });
  });

  it('dismiss is an alias of reject and prefers an explicit findingRef over parentRef', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app dismiss', findingRef: '42:2002', parentRef: '42:9999' }),
      cfg(),
    );
    expect(result).toMatchObject({ kind: 'command', name: 'reject', findingRef: '42:2002' });
  });

  it('top-level single-token ref is a documented fallback findingRef when no reply context exists', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app reject 42:3003' }),
      cfg(),
    );
    expect(result).toMatchObject({ kind: 'command', name: 'reject', findingRef: '42:3003' });
  });

  it('reject with a multi-word reason and no reply context has no findingRef (capture-skip later)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app reject not actually a bug' }),
      cfg(),
    );
    expect(result).toMatchObject({ kind: 'command', name: 'reject' });
    expect((result as { findingRef?: string }).findingRef).toBeUndefined();
  });
});

describe('classifyComment — qa fallthrough', () => {
  it('a non-command mention becomes qa with the trimmed question (original case preserved)', async () => {
    const env = createTestEnv();
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codra-app Why is this O(n^2)?' }),
      cfg(),
    );
    expect(result).toEqual({ kind: 'qa', question: 'Why is this O(n^2)?' });
  });
});
