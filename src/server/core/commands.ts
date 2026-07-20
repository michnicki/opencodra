import type { AppBindings } from '@server/env';
import type { VcsProvider } from '@server/vcs/types';
import type { RepoConfig } from '@shared/schema';
import { getBotIdentity, type BotIdentityResolver } from '@server/core/bot-identity';

/**
 * Phase 11 Plan 03 — core/commands.ts: the webhook-layer command parser + dispatcher that is the
 * heart of Phase 11 (CMD-01..05, CMD-07, CMD-08). Provider-agnostic (D-03): one module serves both
 * GitHub and Bitbucket.
 *
 * `classifyComment` is the load-bearing echo-loop defense (D-03): line one resolves the bot's OWN
 * immutable accountId and self-filters the bot's own comments BEFORE any command/Q&A parse — the
 * summary footer embeds `@codra-app review`, so without this the bot would re-trigger itself forever
 * (T-11-03-1). It then parses a minimal, injection-safe `@mention`-PREFIX grammar into the D-02
 * command set, or falls through to Q&A (Plan 04) when a mention is not a recognized complete command.
 *
 * `classifyComment` returns an EXCLUSIVE, feature-aware result: every non-command / non-qa outcome is
 * an explicit `kind='ignored'` with a `reason`. A caller (Plan 06 webhook-ingest) maps every
 * `ignored` reason to an ignored ingest outcome — an `ignored` result can NEVER fall through to any
 * legacy `issue_comment`→review resolution (REVIEW: Codex 11-03/11-06 HIGH, T-11-03-6).
 */

export type CommandName = 'review' | 'review-rest' | 'pause' | 'resume' | 'help' | 'reject';

/**
 * The untrusted comment + its immutable author id, flattened from the provider webhook by Plan 06.
 *
 * - `authorId` is the IMMUTABLE provider id (GitHub numeric user id as a string / Bitbucket
 *   `account_id`) — the ONLY value the self-filter and authorization key on (NREG-02).
 * - `authorLogin` is the renameable @mention handle, used ONLY to form a GitHub permission URL.
 * - `workspace` is the canonical per-provider pause-key workspace (GitHub owner/login, Bitbucket
 *   workspace slug), matching the `pr_review_state`/`reject_feedback` NOT NULL workspace column.
 * - `commentRef` is this comment's opaque provider ref — used as `reject_feedback.source_comment_ref`
 *   for replay idempotency.
 * - `parentRef` / `findingRef` are the reply-thread parent (Bitbucket `comment.parent.id`, GitHub
 *   `pull_request_review_comment.in_reply_to_id`) resolved to the finding the reject dismisses.
 */
export type CommentContext = {
  authorId: string;
  authorLogin?: string;
  body: string;
  prNumber: number;
  commentRef?: string;
  parentRef?: string;
  findingRef?: string;
  owner: string;
  repo: string;
  workspace: string;
};

/**
 * Exclusive classification result. `ignored` replaces the ambiguous `kind='none'` with an explicit
 * reason so Plan 06 never routes a self-filtered / unresolved / non-mention / feature-off comment
 * into legacy resolution (REVIEW: Codex 11-03/11-06 HIGH).
 */
export type ClassifiedComment =
  | { kind: 'command'; name: CommandName; args: string; findingRef?: string }
  | { kind: 'qa'; question: string }
  | { kind: 'ignored'; reason: 'self_filtered' | 'identity_unresolved' | 'not_mention' | 'feature_disabled' };

/**
 * Command variant of `ClassifiedComment` — the input to `executeCommand`.
 */
export type ClassifiedCommand = Extract<ClassifiedComment, { kind: 'command' }>;

/**
 * D-02 alias table for commands that take NO argument. The ENTIRE normalized remainder (after
 * mention, whitespace-collapsed, trailing-punctuation-stripped, lowercased) must EXACTLY equal one of
 * these keys — a partial-alias-plus-extra ('review this code?') is NOT a command, it is Q&A
 * (REVIEW: Codex/OpenCode 11-03 MED — require a complete normalized command).
 */
const NO_ARG_ALIASES: Readonly<Record<string, CommandName>> = {
  review: 'review',
  'review this': 'review',
  'review this pr': 'review',
  'review rest': 'review-rest',
  rest: 'review-rest',
  continue: 'review-rest',
  pause: 'pause',
  resume: 'resume',
  '?': 'help',
  commands: 'help',
  help: 'help',
};

/**
 * D-02/D-09 alias table for commands that DO take a trailing argument: only the FIRST token must
 * match. `reject`/`dismiss` are invoked as `@mention reject [reason]` in a reply thread; the reason
 * is captured from the FULL reply body (ctx.body) at execute time, not from these parsed args.
 */
const ARG_COMMAND_ALIASES: Readonly<Record<string, CommandName>> = {
  reject: 'reject',
  dismiss: 'reject',
};

// Trailing punctuation we tolerate on an otherwise-complete alias (CMD-03 encoding edge). Applied to
// the WHOLE remainder for no-arg aliases and to the first token for arg-commands.
const TRAILING_PUNCT = /[?.!,;:]+$/;

function stripTrailingPunct(s: string): string {
  return s.replace(TRAILING_PUNCT, '');
}

/**
 * Classify an untrusted comment. Self-filter FIRST (D-03), then feature-gate, then prefix-mention,
 * then a bounded alias match. No `eval`, no regex over untrusted content beyond a bounded token
 * match; the mention is compared with `String.startsWith` (never a constructed RegExp), so a custom
 * `mention_trigger` cannot inject regex behavior (T-11-03-4).
 *
 * `provider` + `resolver` are constructed by Plan 06 (VcsService.forProvider + the Plan 02 bot
 * identity resolver factory). `resolver` may be `undefined` when identity cannot be resolved — that
 * yields a null accountId and an `identity_unresolved` outcome (the defense cannot be guaranteed, so
 * classification must not proceed).
 */
export async function classifyComment(
  env: Pick<AppBindings, 'APP_KV' | 'BOT_USERNAME'>,
  provider: VcsProvider,
  resolver: BotIdentityResolver | undefined,
  ctx: CommentContext,
  config: RepoConfig,
): Promise<ClassifiedComment> {
  // ── Line one: self-filter on the resolved NON-NULL immutable accountId (D-03, echo-loop defense).
  const scope = provider.name === 'bitbucket' ? { workspace: ctx.workspace, repo: ctx.repo } : undefined;
  const identity = await getBotIdentity(env, provider.name, resolver, scope);
  if (!identity.accountId) {
    // Cannot guarantee the self-filter without a non-null immutable id — do NOT parse (NREG-02).
    return { kind: 'ignored', reason: 'identity_unresolved' };
  }
  if (ctx.authorId === identity.accountId) {
    return { kind: 'ignored', reason: 'self_filtered' };
  }

  // ── Feature gate: if neither interactive capability is on, this comment is inert.
  const commandsEnabled = config.review.interactive.commands.enabled;
  const qaEnabled = config.review.interactive.qa.enabled;
  if (!commandsEnabled && !qaEnabled) {
    return { kind: 'ignored', reason: 'feature_disabled' };
  }

  // ── Mention must be a PREFIX (D-01), anchored after optional leading whitespace — NOT body.includes.
  const mentionTrigger = config.review.mention_trigger;
  if (typeof mentionTrigger !== 'string') {
    // mention_trigger === false: mention-triggered commands are disabled.
    return { kind: 'ignored', reason: 'not_mention' };
  }
  const leading = ctx.body.replace(/^\s+/, '');
  if (!leading.startsWith(mentionTrigger)) {
    return { kind: 'ignored', reason: 'not_mention' };
  }
  const after = leading.slice(mentionTrigger.length);
  // Require a boundary after the mention so '@codra-appreview' is NOT a mention.
  if (after !== '' && !/^\s/.test(after)) {
    return { kind: 'ignored', reason: 'not_mention' };
  }
  const remainder = after.trim().replace(/\s+/g, ' ');
  if (remainder === '') {
    return { kind: 'ignored', reason: 'not_mention' };
  }

  // ── Command parse (only when the commands capability is enabled).
  if (commandsEnabled) {
    const command = matchCommand(remainder, ctx);
    if (command) {
      return command;
    }
  }

  // ── Fall through: a mention that is not a recognized complete command is Q&A when enabled (D-04).
  if (qaEnabled) {
    return { kind: 'qa', question: remainder };
  }
  return { kind: 'ignored', reason: 'feature_disabled' };
}

/**
 * Match the post-mention remainder against the D-02 alias tables. Returns a command result or null
 * (null => fall through to Q&A). `remainder` is whitespace-collapsed, original-case.
 */
function matchCommand(remainder: string, ctx: CommentContext): ClassifiedCommand | null {
  const lower = remainder.toLowerCase();

  // No-arg aliases: the WHOLE normalized remainder must equal an alias (check the exact form first so
  // the bare '?' help alias is not stripped to empty, then the trailing-punctuation-tolerant form).
  const noArg = NO_ARG_ALIASES[lower] ?? NO_ARG_ALIASES[stripTrailingPunct(lower)];
  if (noArg) {
    return { kind: 'command', name: noArg, args: '' };
  }

  // Arg-commands (reject/dismiss): only the FIRST token must match; the rest is the arg remainder.
  const firstSpace = lower.indexOf(' ');
  const firstToken = stripTrailingPunct(firstSpace === -1 ? lower : lower.slice(0, firstSpace));
  const argCommand = ARG_COMMAND_ALIASES[firstToken];
  if (argCommand === 'reject') {
    const args = firstSpace === -1 ? '' : remainder.slice(firstSpace + 1).trim();
    // Reply-thread refs (findingRef/parentRef) win; a top-level single-token ref is a documented
    // fallback (D-09). A multi-word remainder is a reason, never a ref, so no findingRef is inferred.
    const fallbackRef = args && !args.includes(' ') ? args : undefined;
    const findingRef = ctx.findingRef ?? ctx.parentRef ?? fallbackRef;
    return { kind: 'command', name: 'reject', args, findingRef };
  }

  return null;
}
