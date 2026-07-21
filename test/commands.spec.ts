import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyComment,
  authorizeActor,
  executeCommand,
  buildHelpText,
  type CommentContext,
  type ClassifiedCommand,
} from '@server/core/commands';
import type { BotIdentityResolver } from '@server/core/bot-identity';
import { createBitbucketBotIdentityResolver } from '@server/core/bitbucket';
import type { VcsProvider } from '@server/vcs/types';
import { queryRows } from '@server/db/client';
import { getPrReviewState } from '@server/db/pr-review-state';
import { repoConfigSchema, type RepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

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
// `authorizeActor`/`executeCommand` tests inject `getUserRepoPermission`/`createPrComment`.
function makeProvider(
  name: 'github' | 'bitbucket' = 'github',
  overrides: Partial<VcsProvider> = {},
): VcsProvider {
  return { name, ...overrides } as unknown as VcsProvider;
}

function cfg(
  opts: {
    commands?: boolean;
    qa?: boolean;
    allow?: string[];
    mention?: string | false;
    botAccountId?: string | null;
  } = {},
): RepoConfig {
  return repoConfigSchema.parse({
    review: {
      mention_trigger: opts.mention ?? '@codra-app',
      interactive: {
        commands: {
          enabled: opts.commands ?? true,
          bitbucket_allowed_account_ids: opts.allow ?? [],
          bitbucket_bot_account_id: opts.botAccountId ?? null,
        },
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

describe('classifyComment — CMD-07 Layer 2: config-based Bitbucket bot identity', () => {
  it('self-filters the bot and dispatches a real user command without ever calling GET /2.0/user', async () => {
    const clientStub = {
      resolveBotUserIdentity: vi.fn(async () => ({ accountId: 'from-get-user' })),
    };
    const resolver = createBitbucketBotIdentityResolver(clientStub, 'configured-bot-acct');
    const provider = makeProvider('bitbucket');
    const config = cfg({ commands: true, botAccountId: 'configured-bot-acct' });

    // The bot's own comment is self-filtered on the configured immutable account_id.
    const selfFiltered = await classifyComment(
      createTestEnv(),
      provider,
      resolver,
      ctx({ authorId: 'configured-bot-acct', body: '@codra-app review' }),
      config,
    );
    expect(selfFiltered).toEqual({ kind: 'ignored', reason: 'self_filtered' });

    // A real user's @mention still dispatches a command. Fresh env so the per-repo KV cache is cold.
    const command = await classifyComment(
      createTestEnv(),
      provider,
      resolver,
      ctx({ authorId: 'human-author-id', body: '@codra-app review' }),
      config,
    );
    expect(command).toEqual({ kind: 'command', name: 'review', args: '' });

    // The Repository Access Token path (GET /2.0/user) is NEVER invoked when an id is configured.
    expect(clientStub.resolveBotUserIdentity).not.toHaveBeenCalled();
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

describe('classifyComment — bot-handle fallback (real @BOT_USERNAME triggers under the default trigger)', () => {
  it('(a) @codraapp review with the DEFAULT mention_trigger triggers the command (the bug fix)', async () => {
    const env = createTestEnv({ BOT_USERNAME: 'codraapp' });
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codraapp review' }),
      cfg(), // default mention_trigger '@codra-app'
    );
    expect(result).toMatchObject({ kind: 'command', name: 'review' });
  });

  it('(b) a custom mention_trigger still triggers, matched literally (the "." proves no regex)', async () => {
    const env = createTestEnv({ BOT_USERNAME: 'codraapp' });
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@my-bot.v2 review' }),
      cfg({ mention: '@my-bot.v2' }),
    );
    expect(result).toMatchObject({ kind: 'command', name: 'review' });
  });

  it('(c) mention_trigger:false fully disables mentions — the bot-handle fallback must NOT re-enable them', async () => {
    const env = createTestEnv({ BOT_USERNAME: 'codraapp' });
    const result = await classifyComment(
      env,
      makeProvider('github'),
      botResolver(),
      ctx({ body: '@codraapp review' }),
      cfg({ mention: false }),
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'not_mention' });
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

describe('authorizeActor — GitHub (id-verified permission read, fail-closed D-06/D-07)', () => {
  const perm = (value: 'admin' | 'write' | 'read' | 'none' | null) =>
    makeProvider('github', { getUserRepoPermission: vi.fn(async () => value) });

  it.each([
    ['admin', true],
    ['write', true],
    ['read', false],
    ['none', false],
    [null, false],
  ] as const)('permission %s -> authorized=%s', async (value, expected) => {
    const env = createTestEnv();
    const provider = perm(value);
    const authorized = await authorizeActor(env, provider, 'acme', 'widgets', 'gh-id-1', 'octocat', cfg());
    expect(authorized).toBe(expected);
    // authorization is decided on the immutable id; the login is only forwarded to form the URL.
    expect(provider.getUserRepoPermission).toHaveBeenCalledWith('acme', 'widgets', 'gh-id-1', 'octocat');
  });
});

describe('authorizeActor — Bitbucket (allow-list primary, A1)', () => {
  it('authorizes an allow-listed account_id WITHOUT any permission read', async () => {
    const env = createTestEnv();
    const getUserRepoPermission = vi.fn(async () => null);
    const provider = makeProvider('bitbucket', { getUserRepoPermission });
    const authorized = await authorizeActor(
      env,
      provider,
      'ws',
      'repo',
      'bb-acct-allowed',
      'nick',
      cfg({ allow: ['bb-acct-allowed'] }),
    );
    expect(authorized).toBe(true);
    // Allow-list is authoritative — the best-effort read is not needed.
    expect(getUserRepoPermission).not.toHaveBeenCalled();
  });

  it('a not-listed account_id with a null best-effort read is unauthorized (defer-to-allow-list, not deny-by-error)', async () => {
    const env = createTestEnv();
    const provider = makeProvider('bitbucket', { getUserRepoPermission: vi.fn(async () => null) });
    const authorized = await authorizeActor(env, provider, 'ws', 'repo', 'bb-acct-other', 'nick', cfg({ allow: ['someone-else'] }));
    expect(authorized).toBe(false);
  });

  it('a not-listed account_id may still authorize on a best-effort admin/write read (secondary)', async () => {
    const env = createTestEnv();
    const provider = makeProvider('bitbucket', { getUserRepoPermission: vi.fn(async () => 'write' as const) });
    const authorized = await authorizeActor(env, provider, 'ws', 'repo', 'bb-acct-other', 'nick', cfg({ allow: [] }));
    expect(authorized).toBe(true);
  });
});

describe('executeCommand — help (read-only discovery, D-11, no authorization)', () => {
  it('posts the full stable command list documenting reject as a reply-thread command, no auth read', async () => {
    const env = createTestEnv();
    const createPrComment = vi.fn(
      async (_owner: string, _repo: string, _prNumber: number, _body: string) => ({ ref: 'c-1' }),
    );
    const getUserRepoPermission = vi.fn(async () => null);
    const provider = makeProvider('github', { createPrComment, getUserRepoPermission });

    await executeCommand(
      env,
      provider,
      { kind: 'command', name: 'help', args: '' },
      ctx({ body: '@codra-app help' }),
      cfg(),
    );

    expect(getUserRepoPermission).not.toHaveBeenCalled();
    expect(createPrComment).toHaveBeenCalledOnce();
    const body = createPrComment.mock.calls[0][3];
    // cfg() leaves mention_trigger at the '@codra-app' default, so the advertised handle is the real
    // bot handle ('@' + env.BOT_USERNAME) — NOT the default trigger.
    const handle = `@${env.BOT_USERNAME}`;
    // Stable order: review, review rest, pause, resume, help, reject.
    const order = ['review', 'review rest', 'pause', 'resume', 'help', 'reject'].map((c) =>
      body.indexOf(`${handle} ${c}`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    expect(body).toContain(`${handle} reject [reason]`);
  });

  it('buildHelpText is byte-identical regardless of which help alias triggered it', () => {
    // help output is static (does not depend on the triggering alias), so ? / commands / help all
    // produce the same body.
    expect(buildHelpText(cfg(), 'codraapp')).toBe(buildHelpText(cfg(), 'codraapp'));
  });
});

describe('executeCommand — help threading (Phase 12, D-01 caller-decides)', () => {
  function threadingProvider() {
    const createPrComment = vi.fn(
      async (_owner: string, _repo: string, _prNumber: number, _body: string) => ({ ref: 'c-top' }),
    );
    const replyToPrComment = vi.fn(
      async (_owner: string, _repo: string, _prNumber: number, _body: string, _ref: string) => ({ ref: 'c-reply' }),
    );
    const getUserRepoPermission = vi.fn(async () => 'read' as const);
    const provider = makeProvider('github', { createPrComment, replyToPrComment, getUserRepoPermission });
    return { provider, createPrComment, replyToPrComment, getUserRepoPermission };
  }

  it('threads the help reply under the originating comment when threadable && commentRef (D-01)', async () => {
    const env = createTestEnv();
    const { provider, createPrComment, replyToPrComment } = threadingProvider();

    await executeCommand(
      env,
      provider,
      { kind: 'command', name: 'help', args: '' },
      ctx({ body: '@codra-app help', threadable: true, commentRef: '1997', owner: 'acme', repo: 'widgets', prNumber: 42 }),
      cfg(),
    );

    expect(replyToPrComment).toHaveBeenCalledTimes(1);
    const [owner, repo, prNumber, body, inReplyToRef] = replyToPrComment.mock.calls[0];
    expect([owner, repo, prNumber, inReplyToRef]).toEqual(['acme', 'widgets', 42, '1997']);
    expect(body).toBe(buildHelpText(cfg(), env.BOT_USERNAME));
    expect(createPrComment).not.toHaveBeenCalled();
  });

  it('falls back to a top-level createPrComment when threadable is falsy (GitHub asymmetry)', async () => {
    const env = createTestEnv();
    const { provider, createPrComment, replyToPrComment } = threadingProvider();

    await executeCommand(
      env,
      provider,
      { kind: 'command', name: 'help', args: '' },
      ctx({ body: '@codra-app help', commentRef: '1997', owner: 'acme', repo: 'widgets', prNumber: 42 }),
      cfg(),
    );

    expect(createPrComment).toHaveBeenCalledTimes(1);
    expect(createPrComment).toHaveBeenCalledWith('acme', 'widgets', 42, buildHelpText(cfg(), env.BOT_USERNAME));
    expect(replyToPrComment).not.toHaveBeenCalled();
  });

  it('falls back to top-level when threadable is true but commentRef is absent', async () => {
    const env = createTestEnv();
    const { provider, createPrComment, replyToPrComment } = threadingProvider();

    await executeCommand(
      env,
      provider,
      { kind: 'command', name: 'help', args: '' },
      ctx({ body: '@codra-app help', threadable: true, owner: 'acme', repo: 'widgets', prNumber: 42 }),
      cfg(),
    );

    expect(createPrComment).toHaveBeenCalledTimes(1);
    expect(replyToPrComment).not.toHaveBeenCalled();
  });

  it('pause / resume / reject stay silent — no createPrComment and no replyToPrComment (D-02)', async () => {
    const env = createTestEnv();
    // An unauthorized actor returns before any DB write; state-changing commands never post a reply
    // regardless of threadable, so this proves executeCommand emits no bot chatter for them (D-02).
    for (const name of ['pause', 'resume', 'reject'] as const) {
      const { provider, createPrComment, replyToPrComment } = threadingProvider();
      await executeCommand(
        env,
        provider,
        { kind: 'command', name, args: '' },
        ctx({ body: `@codra-app ${name}`, threadable: true, commentRef: '1997' }),
        cfg(),
      );
      expect(createPrComment).not.toHaveBeenCalled();
      expect(replyToPrComment).not.toHaveBeenCalled();
    }
  });
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('executeCommand — pause/resume/reject DB effects (authorization + scope)', () => {
  const env = createTestEnv();
  const authorized = () => makeProvider('github', { getUserRepoPermission: vi.fn(async () => 'write' as const) });
  const unauthorized = () => makeProvider('github', { getUserRepoPermission: vi.fn(async () => 'read' as const) });

  beforeEach(async () => {
    await queryRows(env, `TRUNCATE reject_feedback`);
  });

  it('an authorized actor pauses the PR (markPrPaused with the immutable id)', async () => {
    const suffix = `pause-${Date.now()}`;
    const c = ctx({ owner: 'acme', repo: `repo-${suffix}`, workspace: 'acme', authorId: 'gh-id-writer', prNumber: 7 });
    await executeCommand(env, authorized(), { kind: 'command', name: 'pause', args: '' }, c, cfg());

    const state = await getPrReviewState(env, {
      vcsProvider: 'github',
      workspace: 'acme',
      repoSlug: `repo-${suffix}`,
      prNumber: 7,
    });
    expect(state?.paused).toBe(true);
    expect(state?.paused_by).toBe('gh-id-writer');
  });

  it('an UNAUTHORIZED actor produces NO pause row and NO reply (silent ignore, D-07)', async () => {
    const suffix = `pause-noauth-${Date.now()}`;
    const c = ctx({ owner: 'acme', repo: `repo-${suffix}`, workspace: 'acme', authorId: 'gh-id-reader', prNumber: 7 });
    await executeCommand(env, unauthorized(), { kind: 'command', name: 'pause', args: '' }, c, cfg());

    const state = await getPrReviewState(env, {
      vcsProvider: 'github',
      workspace: 'acme',
      repoSlug: `repo-${suffix}`,
      prNumber: 7,
    });
    expect(state).toBeNull();
  });

  it('resume clears the pause flag in place and never enqueues', async () => {
    const suffix = `resume-${Date.now()}`;
    const key = { vcsProvider: 'github' as const, workspace: 'acme', repoSlug: `repo-${suffix}`, prNumber: 7 };
    const base = ctx({ owner: 'acme', repo: `repo-${suffix}`, workspace: 'acme', authorId: 'gh-id-writer', prNumber: 7 });

    await executeCommand(env, authorized(), { kind: 'command', name: 'pause', args: '' }, base, cfg());
    await executeCommand(env, authorized(), { kind: 'command', name: 'resume', args: '' }, base, cfg());

    const state = await getPrReviewState(env, key);
    expect(state?.paused).toBe(false);
    // paused_by preserves the pauser's id (markPrResumed does not clobber it).
    expect(state?.paused_by).toBe('gh-id-writer');
  });

  it('an authorized reject persists reason = the FULL reply body and sourceCommentRef = ctx.commentRef (D-09)', async () => {
    const suffix = `reject-${Date.now()}`;
    const c = ctx({
      owner: 'acme',
      repo: `repo-${suffix}`,
      workspace: 'acme',
      authorId: 'gh-id-writer',
      prNumber: 7,
      body: '@codra-app reject this is a false positive because X',
      commentRef: `7:src-${suffix}`,
      findingRef: `7:finding-${suffix}`,
    });
    const cmd: ClassifiedCommand = {
      kind: 'command',
      name: 'reject',
      args: 'this is a false positive because X',
      findingRef: `7:finding-${suffix}`,
    };

    await executeCommand(env, authorized(), cmd, c, cfg());

    const rows = await queryRows<{ reason: string; source_comment_ref: string; finding_ref: string; rejected_by: string }>(
      env,
      `SELECT reason, source_comment_ref, finding_ref, rejected_by FROM reject_feedback WHERE vcs_provider = 'github' AND source_comment_ref = $1`,
      [`7:src-${suffix}`],
    );
    expect(rows).toHaveLength(1);
    // reason EQUALS the full reply body, never the parsed args.
    expect(rows[0].reason).toBe('@codra-app reject this is a false positive because X');
    expect(rows[0].source_comment_ref).toBe(`7:src-${suffix}`);
    expect(rows[0].finding_ref).toBe(`7:finding-${suffix}`);
    expect(rows[0].rejected_by).toBe('gh-id-writer');
  });

  it('an UNAUTHORIZED reject writes no row (silent ignore, D-07)', async () => {
    const suffix = `reject-noauth-${Date.now()}`;
    const c = ctx({
      owner: 'acme',
      repo: `repo-${suffix}`,
      workspace: 'acme',
      authorId: 'gh-id-reader',
      prNumber: 7,
      body: '@codra-app reject nope',
      commentRef: `7:src-${suffix}`,
      findingRef: `7:finding-${suffix}`,
    });
    const cmd: ClassifiedCommand = { kind: 'command', name: 'reject', args: 'nope', findingRef: `7:finding-${suffix}` };

    await executeCommand(env, unauthorized(), cmd, c, cfg());

    const rows = await queryRows(
      env,
      `SELECT 1 FROM reject_feedback WHERE vcs_provider = 'github' AND source_comment_ref = $1`,
      [`7:src-${suffix}`],
    );
    expect(rows).toHaveLength(0);
  });

  it('an authorized reject with NO findingRef is a capture-skip (no row, no error, D-09)', async () => {
    const suffix = `reject-noref-${Date.now()}`;
    const c = ctx({
      owner: 'acme',
      repo: `repo-${suffix}`,
      workspace: 'acme',
      authorId: 'gh-id-writer',
      prNumber: 7,
      body: '@codra-app reject not under a finding',
      commentRef: `7:src-${suffix}`,
    });
    const cmd: ClassifiedCommand = { kind: 'command', name: 'reject', args: 'not under a finding' };

    await executeCommand(env, authorized(), cmd, c, cfg());

    const rows = await queryRows(
      env,
      `SELECT 1 FROM reject_feedback WHERE vcs_provider = 'github' AND source_comment_ref = $1`,
      [`7:src-${suffix}`],
    );
    expect(rows).toHaveLength(0);
  });
});
