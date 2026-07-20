import { z } from 'zod';

export const reviewTriggers = ['auto', 'mention', 'retry'] as const;
export const jobStatuses = ['queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped'] as const;
export const fileStatuses = ['pending', 'done', 'skipped', 'failed'] as const;
export const reviewVerdicts = ['approve', 'comment'] as const;
export const reviewSeverities = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;
export const reviewCategories = ['security', 'bugs', 'performance', 'correctness', 'quality'] as const; // Keeping for DB compatibility but will deprecate usage in prompts
export const llmApiFormats = ['openai', 'anthropic', 'gemini', 'cloudflare-workers-ai'] as const;
export const vcsProviders = ['github', 'bitbucket'] as const;
export type VcsProvider = typeof vcsProviders[number];

export const dateStringSchema = z.union([z.string(), z.date()]).transform((d) => (d instanceof Date ? d.toISOString() : d));
export const coerceNumberSchema = z.coerce.number();

export const jobStepSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  startedAt: dateStringSchema.nullable(),
  finishedAt: dateStringSchema.nullable(),
  error: z.string().nullable().optional(),
});

export const parsedReviewCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  position: z.number().int().positive().nullable().optional(),
  severity: z.enum(reviewSeverities),
  category: z.enum(reviewCategories).default('quality'),
  title: z.string().min(1),
  body: z.string().min(1),
  codeSuggestion: z.string().min(1).nullable().optional(),
  // Per-finding model confidence (0..1). Threaded parse -> persist -> reconstruct -> finalize.
  // nullable + optional so a provider that omits it is representable and treated fail-open.
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const fileReviewModelOutputSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string().max(100),
      body: z.string().min(1),
      confidence_score: z.number().min(0).max(1).optional(),
      priority: z.number().int().min(0).max(3).optional(),
      code_location: z.object({
        absolute_file_path: z.string(),
        line_range: z.object({
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        }).optional(),
        line: z.number().int().positive().optional(),
      }),
      code_suggestion: z.string().optional(),
    }),
  ),
  overall_correctness: z.string().optional().default('patch is correct'),
  overall_explanation: z.string().optional().default('Review completed (partial output).'),
  overall_confidence_score: z.number().min(0).max(1).optional(),
});

export const summaryModelOutputSchema = z.union([
  z.array(z.object({ summary: z.string().min(1) })),
  z.object({ summary: z.string().min(1) }),
]);

export const labelsSchema = z.union([
  z.literal(false),
  z.object({
    p1: z.string().min(1),
    p2: z.string().min(1),
    p3: z.string().min(1),
  }),
]);

export const reviewConfigSchema = z.object({
  on: z.array(z.enum(['opened', 'synchronize', 'ready_for_review', 'reopened', 'closed'])).default(['opened', 'synchronize', 'ready_for_review', 'reopened']),
  ignore_drafts: z.boolean().default(true),
  mention_trigger: z.union([z.literal(false), z.string().min(1)]).default('@codra-app'),
  skip_files: z
    .array(z.string().min(1))
    .default(['**/*.lock', 'dist/**', 'build/**', '.next/**', '*.generated.*', 'coverage/**']),
  max_files: z.number().int().min(1).max(150).default(150),
  large_file_threshold_lines: z.number().int().min(1).max(5_000).default(200),
  max_diff_lines_per_file: z.number().int().min(1).max(5_000).default(800),
  max_total_diff_chars: z.number().int().min(1).max(500_000).default(150_000),
  max_comments: z.number().int().min(1).max(150).default(10),
  min_severity: z.enum(reviewSeverities).default('nit'),
  // Finalize confidence floor: findings whose per-finding confidence is below this are dropped
  // (fail-open — a finding with null/undefined confidence is always kept). Default 0.7.
  min_confidence: z.number().min(0).max(1).default(0.7),
  focus: z.array(z.enum(reviewCategories)).default([...reviewCategories]),
  // Bounded at the config-write boundary so a malicious/oversized custom rule cannot
  // dominate the review prompt (prompt-injection hardening, Group D-1): each rule is
  // capped at 500 chars and the list at 50 entries. Field name/shape unchanged.
  custom_rules: z.array(z.string().min(1).max(500)).max(50).default([]),
  labels: labelsSchema.default({
    p1: 'review: needs-attention',
    p2: 'review: approved',
    p3: 'review: approved',
  }),
  exec: z
    .object({
      enabled: z.boolean().default(false),
      on_file_types: z.array(z.string().min(1)).default(['.ts', '.tsx', '.js']),
      command: z.string().min(1).default('npm run lint && npm run typecheck'),
    })
    .default({
      enabled: false,
      on_file_types: ['.ts', '.tsx', '.js'],
      command: 'npm run lint && npm run typecheck',
    }),
  // Phase 7 contract-first feature toggles (D-04/D-05/D-06). Every block and every `enabled`
  // carries an explicit `false` default so `repoConfigSchema.parse({})` yields all-off (NREG-01
  // inertness). Grouped (never a flat boolean namespace, never a single master switch) so later
  // phases (8-11) can wire each capability behind its own toggle without a breaking contract edit.
  // Uniform `{ enabled: boolean }` shape leaves room for per-toggle config fields later.
  // D-09: `sequence_diagram` defaults ON so that enabling the walkthrough gets a Mermaid diagram on
  // GitHub by default — it stays inert while `walkthrough.enabled` is false (the whole feature is off),
  // and is additionally hard-gated at render time by provider (Bitbucket never emits a Mermaid fence).
  // So the sub-toggle's `true` default cannot regress NREG-01: `repoConfigSchema.parse({})` still has
  // `walkthrough.enabled === false`, i.e. no walkthrough is produced at all.
  walkthrough: z
    .object({
      enabled: z.boolean().default(false),
      sequence_diagram: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    })
    .default({ enabled: false, sequence_diagram: { enabled: true } }),
  passes: z
    .object({
      security: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
      // `skip_threshold` / `input_char_budget` are OPTIONAL critic tuning knobs (review suggestion):
      // when unset, 10-06 falls back to its in-code constants, so absence is behavior-identical.
      // Additive optional fields keep `passes.critic` all-off by default (NREG-01 inertness).
      critic: z
        .object({
          enabled: z.boolean().default(false),
          skip_threshold: z.number().int().nonnegative().optional(),
          input_char_budget: z.number().int().positive().optional(),
        })
        .default({ enabled: false }),
    })
    .default({ security: { enabled: false }, critic: { enabled: false } }),
  interactive: z
    .object({
      commands: z
        .object({
          enabled: z.boolean().default(false),
          // REVIEW (A1 authorization redesign, D-06): the deterministic per-repo Bitbucket
          // authorization allow-list the Bitbucket authz path now depends on. Additive + defaulted
          // to [] so repoConfigSchema.parse({}) is byte-identical to today (NREG-01).
          bitbucket_allowed_account_ids: z.array(z.string()).default([]),
        })
        .default({ enabled: false, bitbucket_allowed_account_ids: [] }),
      qa: z
        .object({
          enabled: z.boolean().default(false),
          // REVIEW (OpenCode 11-04): the Q&A hourly cap as a config knob, not a hardcoded constant.
          // Additive + defaulted so an existing config parses byte-identically (NREG-01).
          rate_limit_per_hour: z.number().int().positive().default(10),
        })
        .default({ enabled: false, rate_limit_per_hour: 10 }),
    })
    .default({
      commands: { enabled: false, bitbucket_allowed_account_ids: [] },
      qa: { enabled: false, rate_limit_per_hour: 10 },
    }),
});

export const repoConfigSchema = z.object({
  review: reviewConfigSchema.default({
    on: ['opened', 'synchronize', 'ready_for_review', 'reopened'],
    ignore_drafts: true,
    mention_trigger: '@codra-app',
    skip_files: ['**/*.lock', 'dist/**', 'build/**', '.next/**', '*.generated.*', 'coverage/**'],
    max_files: 150,
    large_file_threshold_lines: 200,
    max_diff_lines_per_file: 800,
    max_total_diff_chars: 150_000,
    max_comments: 10,
    min_severity: 'nit',
    min_confidence: 0.7,
    focus: [...reviewCategories],
    custom_rules: [],
    labels: {
      p1: 'review: needs-attention',
      p2: 'review: approved',
      p3: 'review: approved',
    },
    exec: {
      enabled: false,
      on_file_types: ['.ts', '.tsx', '.js'],
      command: 'npm run lint && npm run typecheck',
    },
    // Mirror the Phase 7 toggle blocks all-off in the inline literal default too, so
    // `repoConfigSchema.parse({})` yields every toggle false regardless of Zod default
    // short-circuit semantics for the nested `review` object (RESEARCH Open Q2).
    walkthrough: { enabled: false, sequence_diagram: { enabled: true } },
    passes: { security: { enabled: false }, critic: { enabled: false } },
    interactive: {
      commands: { enabled: false, bitbucket_allowed_account_ids: [] },
      qa: { enabled: false, rate_limit_per_hour: 10 },
    },
  }),
  model: z
    .object({
      main: z.string().nullable().default(null),
      fallbacks: z.array(z.string()).nullable().default([]),
      size_overrides: z
        .array(
          z.object({
            max_lines: z.number().int().positive(),
            model: z.string(),
            fallbacks: z.array(z.string()).optional(),
          }),
        )
        .nullable()
        .optional(),
    })
    .default({
      main: null,
      fallbacks: [],
      size_overrides: [],
    }),
});

export const reviewJobMessageSchema = z.object({
  jobId: z.uuid().optional(),
  deliveryId: z.string().min(1),
  // WIRE contract widened with 'critic' (D-07). The INTERNAL ReviewJobRunResult.phase union
  // (review.ts:57) and the dispatch switch (review.ts:412-417) intentionally stay
  // prepare|review|finalize — Phase 10 owns critic dispatch. A stray phase:'critic' message is
  // REJECTED at the resolveQueuedJob boundary (return null → acked), never coerced/run.
  phase: z.enum(['prepare', 'review', 'finalize', 'critic']).optional(),
  // Optional multi-pass routing fields (D-07). Kept `.optional()` (no default) so every
  // pre-widening producer/fixture — and ReviewJobMessage = z.input<...> — keeps compiling.
  kind: z.enum(['review', 'qa', 'command']).optional(),
  reviewScope: z.enum(['all', 'rest', 'head']).optional(),
  eventName: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  installationId: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),
  commitSha: z.string().min(1).optional(),
  trigger: z.enum(reviewTriggers).optional(),
  requestId: z.string().optional(),
  // The actual Cloudflare Workflow instance id, injected by the workflow so runReviewJob can bind
  // it to the resolved job row (webhook jobs can't be bound at instance-create time).
  workflowInstanceId: z.string().optional(),
  // Set by lease recovery so the queue consumer creates a FRESH instance (keyed on deliveryId)
  // instead of colliding with the dead instance that is still keyed on jobId.
  forceFreshInstance: z.boolean().optional(),
  // Optional + defaulted so a queue message enqueued by code that predates this field (no
  // `provider` key at all) still validates and resolves to 'github' (NREG-03/Pitfall 10).
  provider: z.enum(vcsProviders).optional().default('github'),
  // Phase 11 (D-09/D-12): the classified command/Q&A context for kind='command'|'qa' messages. The
  // WHOLE object is `.optional()` (no default) so every pre-widening producer — and
  // ReviewJobMessage = z.input<typeof reviewJobMessageSchema> — keeps validating byte-identically
  // (NREG-01). Within it, authorId + body + workspace are REQUIRED so a consumer can reconstruct a
  // full CommentContext downstream (a reject persists reason=body, D-09). The superRefine below
  // tightens ONLY the kind ∈ {command, qa} branch to require this object + those identity fields.
  interactive: z
    .object({
      commandName: z.enum(['review', 'review-rest', 'pause', 'resume', 'help', 'reject']).optional(),
      question: z.string().optional(),
      authorId: z.string().min(1),
      authorLogin: z.string().optional(),
      body: z.string(),
      workspace: z.string().min(1),
      commentRef: z.string().optional(),
      parentRef: z.string().optional(),
      findingRef: z.string().optional(),
      sourceCommentRef: z.string().optional(),
      // Phase 11 (WR-01): the PROVIDER-SAFE per-repo config the webhook route already resolved at
      // classification time (GitHub via loadRepoConfig; Bitbucket via getRepoConfigByRepositoryId +
      // global-model overlay). Carried on the message so the INLINE consumer
      // (index.ts::dispatchInteractiveMessage) uses it directly instead of re-deriving via the
      // owner/repo path — which for Bitbucket collides across providers (getRepoConfigRecord has no
      // vcs_provider filter) and also triggers loadRepoConfig's GitHub-shaped getOrCreateRepository
      // side effect. Optional so pre-Phase-11 producers and in-flight messages still validate
      // (NREG-01); the consumer falls back to the legacy load only when it is absent.
      configSnapshot: repoConfigSchema.optional(),
    })
    .optional(),
}).superRefine((message, ctx) => {
  // Phase 11 (REVIEW: Codex 11-01 MED — weak interactive validation): an INTERNAL command/qa message
  // MUST carry a full interactive identity payload so a malformed message fails fast at parse rather
  // than deep in the consumer. This branch is checked FIRST and returns, so the no-kind path below is
  // never reached for these kinds (a command/qa message legitimately has no jobId/eventName).
  if (message.kind === 'command' || message.kind === 'qa') {
    const interactive = message.interactive;
    if (!interactive || !interactive.authorId || !interactive.body || !interactive.workspace) {
      ctx.addIssue({
        code: 'custom',
        message:
          "Interactive messages (kind 'command'|'qa') require interactive.authorId, interactive.body, and interactive.workspace.",
        path: ['interactive'],
      });
    }
    return;
  }

  // Unchanged no-kind path (NREG-01 byte-identity — do NOT touch).
  if (message.jobId || message.eventName) {
    return;
  }

  ctx.addIssue({
    code: 'custom',
    message: 'Queue message must include either jobId or eventName.',
    path: ['jobId'],
  });
});

// Critic-pass result (D-08). The critic re-judges main-review findings, keeping some and pruning
// others (each pruned finding carries a human-readable reason). `.passthrough()` so Phase 10 can
// add prune/audit metadata fields WITHOUT a breaking contract edit (the D-08 additive guardrail).
// Metadata scalars are optional/tolerant for the same reason. Reuses parsedReviewCommentSchema for
// kept/pruned findings so the critic speaks the same finding vocabulary as the main review.
export const criticResultSchema = z
  .object({
    kept: z.array(parsedReviewCommentSchema),
    pruned: z.array(
      z.object({
        finding: parsedReviewCommentSchema,
        reason: z.string(),
      }),
    ),
    model: z.string().optional(),
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    // D-08 additive-only refinement (never touch the locked fields above). `skipped` is true when
    // 10-06 bypasses the critic model call (skip-threshold / input-char-budget / fail-open), so the
    // stored critic-result blob records that no pruning ran rather than looking like an empty prune.
    // `dedupedCount` records the deduped candidate-set size the critic was shown. Both optional so
    // every existing critic-result blob (and `criticResultSchema.parse({ kept: [], pruned: [] })`)
    // still parses unchanged.
    skipped: z.boolean().optional(),
    dedupedCount: z.number().int().optional(),
  })
  .passthrough();
export type CriticResult = z.infer<typeof criticResultSchema>;

// D-05 ID-based critic MODEL-OUTPUT contract (distinct from the DB-persisted criticResultSchema
// above). The critic returns ONLY opaque numeric ids to DROP plus a reason per id — never full
// findings, never a keep-list — which 10-06 reconciles back to findings in code (the index-assigned
// ids close the gap that parsedReviewCommentSchema has no stable id). `.passthrough()` so a critic
// that emits extra metadata still parses fail-soft.
export const criticPruneOutputSchema = z
  .object({
    prune: z.array(
      z.object({
        id: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
  })
  .passthrough();
export type CriticPruneOutput = z.infer<typeof criticPruneOutputSchema>;

export const jobSummarySchema = z.object({
  id: z.uuid(),
  workflowInstanceId: z.string().nullable().optional(),
  owner: z.string(),
  repo: z.string(),
  // REV-C-3: nullable for Bitbucket rows (which carry no installation_id after migration 005).
  // GitHub rows continue to carry a non-null string. `.nullable().optional()` so existing
  // pre-widening fixtures (which never supply it) still parse and the GitHub call chain in
  // test/webhook-handling.spec.ts stays byte-identical.
  installationId: z.string().nullable().optional(),
  prNumber: z.number().int(),
  prTitle: z.string().nullable(),
  prAuthor: z.string().nullable(),
  commitSha: z.string(),
  trigger: z.enum(reviewTriggers),
  status: z.enum(jobStatuses),
  verdict: z.enum(reviewVerdicts).nullable(),
  fileCount: z.number().int(),
  commentCount: z.number().int(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
  nextRetryAt: dateStringSchema.nullable().optional(),
  startedAt: dateStringSchema.nullable(),
  finishedAt: dateStringSchema.nullable(),
  errorMessage: z.string().nullable(),
  overallConfidenceScore: z.number().nullable().optional(),
  overallCorrectness: z.string().nullable().optional(),
  steps: z.array(jobStepSchema).default([]),
  checkRunId: coerceNumberSchema.nullable().optional(),
  configSnapshot: repoConfigSchema.nullable().optional(),
  retryOfJobId: z.uuid().nullable().optional(),
  // R-01: expose the parent repository's provider + workspace so VcsService.forRepo can branch
  // without a separate query. Optional so pre-widening fixtures still parse.
  repositoryVcsProvider: z.enum(vcsProviders).optional(),
  repositoryWorkspace: z.string().nullable().optional(),
  // REV-R-E: pass-through for the new jobs.status_check_ref column (Bitbucket Code Insights
  // report key / generic status reference). Used by Plan 03's runPreparePhase writer and the
  // runFinalizePhase gate widening. Optional so pre-widening fixtures still parse.
  statusCheckRef: z.string().nullable().optional(),
  // Phase 7 pass-through for the new jobs.walkthrough_comment_ref / jobs.critic_result columns
  // (Plan 04 adds the accessors; Phase 8/10 wire the writers). Optional so pre-widening fixtures
  // still parse; `.nullable()` because the DB columns are nullable and unset until a later phase.
  walkthroughCommentRef: z.string().nullable().optional(),
  criticResult: criticResultSchema.nullable().optional(),
  // Phase 11 (REVIEW: Codex 11-05 HIGH): pass-through for the migration-009 jobs.review_scope /
  // jobs.scope_source_job_id columns so the review-rest scope lives on the PERSISTED job row and
  // survives fresh-instance handoff + lease recovery (not the transient queue message). Both are
  // null on every existing insert (no writer wired this plan) — additive, behaviorally inert
  // (NREG-01). `.nullable().optional()` so pre-widening fixtures still parse.
  reviewScope: z.enum(['all', 'rest', 'head']).nullable().optional(),
  scopeSourceJobId: z.uuid().nullable().optional(),
});

export const jobsQuerySchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  status: z.enum(jobStatuses).optional(),
  verdict: z.enum(reviewVerdicts).optional(),
  search: z.string().optional(),
  limit: z.preprocess((v) => Number(v), z.number().int().min(1).max(100)).default(20),
  offset: z.preprocess((v) => Number(v), z.number().int().min(0)).default(0),
});

export type JobsQuery = z.infer<typeof jobsQuerySchema>;
export type JobStep = z.infer<typeof jobStepSchema>;

// D-07 pass value-set, locked contract-first (closes the file_reviews.pass gap so Phase 10 needs
// no cross-layer contract edit). 'main' is today's single review pass; 'security' is Phase 10's
// dedicated pass. Widen this enum when a new pass is introduced.
export const fileReviewPassSchema = z.enum(['main', 'security']);
export type FileReviewPass = z.infer<typeof fileReviewPassSchema>;

// Canonical (file_path, pass) tuple identity for the multi-pass engine. The review-consensus HIGH
// finding was that the engine introduced a second `pass` dimension while keeping identity path-only,
// which conflates a file's main and security units. This helper is the single source of truth the
// review maps / completion / inheritance in 10-05/10-06 key on. The separator is NUL ('\0'), which
// cannot occur in a POSIX file path, so the key is injective over (file_path, pass).
export type ReviewUnitKey = string;
export function reviewUnitKey(filePath: string, pass: FileReviewPass): ReviewUnitKey {
  // Separator is NUL, written as the readable `\0` escape (an invisible literal NUL byte here is
  // easily misread as a space). NUL cannot occur in a POSIX file path, so the key is injective
  // over (file_path, pass) for ANY future pass value. Used purely as an opaque in-memory Map/Set
  // key — never persisted, split, or serialized.
  return `${filePath}\0${pass}`;
}

export const fileReviewRecordSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  filePath: z.string(),
  // `.default('main')` is REQUIRED for inertness: jobDetailSchema.parse (jobs.ts) builds `files`
  // from a JSON_BUILD_OBJECT that omits `pass`, so a required-no-default field would break that
  // parse — with the default it resolves to 'main' and the job-detail read path stays byte-identical
  // (Plan 02 surfaces the real value via getFileReviewsForJobs; Phase 10 may then emit `pass`).
  pass: fileReviewPassSchema.default('main'),
  fileStatus: z.enum(fileStatuses),
  modelUsed: z.string(),
  modelProvider: z.string().optional(),
  diffLineCount: z.number().int().nullable(),
  diffInput: z.string().nullable(),
  rawAiOutput: z.string().nullable(),
  parsedComments: z.array(parsedReviewCommentSchema),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  verdict: z.enum(reviewVerdicts).nullable(),
  fileSummary: z.string().nullable(),
  overallCorrectness: z.string().nullable().optional(),
  confidenceScore: z.number().nullable().optional(),
  errorMessage: z.string().nullable(),
  createdAt: dateStringSchema,
});

export const jobDetailSchema = jobSummarySchema.extend({
  baseSha: z.string(),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  summaryMarkdown: z.string().nullable(),
  configSnapshot: repoConfigSchema.nullable(),
  reviewId: coerceNumberSchema.nullable(),
  retryOfJobId: z.uuid().nullable(),
  summaryModel: z.string().nullable(),
  files: z.array(fileReviewRecordSchema),
});

export const repoConfigRecordSchema = z.object({
  installationId: z.string(),
  owner: z.string(),
  repo: z.string(),
  vcsProvider: z.enum(vcsProviders),
  parsedJson: repoConfigSchema,
  updatedAt: dateStringSchema,
  lastJobCreatedAt: dateStringSchema.nullable(),
  lastJobVerdict: z.enum(reviewVerdicts).nullable(),
  mainModel: z.string().nullable(),
  fallbackModels: z.array(z.string()).nullable(),
  sizeOverrides: z.any().nullable(),
  enabled: z.boolean(),
});

export const statsSchema = z.object({
  totals: z.object({
    jobs: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    comments: z.number().int(),
  }),
  trend: z.array(
    z.object({
      day: z.string(),
      jobs: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      comments: z.number().int(),
    }),
  ),
  verdicts: z.array(
    z.object({
      verdict: z.enum(reviewVerdicts).nullable(),
      count: z.number().int(),
    }),
  ),
  models: z.array(
    z.object({
      modelUsed: z.string(),
      provider: z.string().optional(),
      calls: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
    }),
  ),
  topRepos: z.array(
    z.object({
      owner: z.string(),
      repo: z.string(),
      vcsProvider: z.enum(vcsProviders),
      jobs: z.number().int(),
    }),
  ),
  statuses: z.array(
    z.object({
      status: z.enum(jobStatuses),
      count: z.number().int(),
    }),
  ),
  triggers: z.array(
    z.object({
      trigger: z.enum(reviewTriggers),
      count: z.number().int(),
    }),
  ),
  severities: z.array(
    z.object({
      severity: z.enum(reviewSeverities),
      count: z.number().int(),
    }),
  ),
  categories: z.array(
    z.object({
      category: z.enum(reviewCategories),
      count: z.number().int(),
    }),
  ),
  performance: z.object({
    avgDurationMs: z.number().nullable(),
    p95DurationMs: z.number().nullable(),
    avgConfidence: z.number().nullable(),
  }),
});

export type ParsedReviewComment = z.infer<typeof parsedReviewCommentSchema>;
export type FileReviewModelOutput = z.infer<typeof fileReviewModelOutputSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export const KIMI_K2_5_MODEL = '@cf/moonshotai/kimi-k2.5';
export const KIMI_K2_6_MODEL = '@cf/moonshotai/kimi-k2.6';
export const DEPRECATED_MODEL_ALIASES: Record<string, string> = {
  [KIMI_K2_5_MODEL]: KIMI_K2_6_MODEL,
};

export function normalizeModelId(model: string) {
  return DEPRECATED_MODEL_ALIASES[model] ?? model;
}

export function normalizeRepoModelConfig(model: RepoConfig['model']): RepoConfig['model'] {
  return {
    ...model,
    main: model.main ? normalizeModelId(model.main) : null,
    fallbacks: model.fallbacks === null
      ? null
      : Array.isArray(model.fallbacks)
        ? model.fallbacks.map(normalizeModelId)
        : [],
    size_overrides: model.size_overrides === null || model.size_overrides === undefined
      ? model.size_overrides
      : model.size_overrides.map((tier) => ({
          ...tier,
          model: normalizeModelId(tier.model),
          fallbacks: tier.fallbacks?.map(normalizeModelId),
        })),
  };
}

export function normalizeRepoConfig(config: RepoConfig): RepoConfig {
  return {
    ...config,
    model: normalizeRepoModelConfig(config.model),
  };
}

// z.input (not z.output/z.infer) -- reviewJobMessageSchema's new `provider` field carries a
// `.default('github')`, which zod's output type treats as always-present/non-optional. Every
// consumer of ReviewJobMessage (queue producers constructing a message pre-validation, and the
// large existing test suite's hand-built fixtures) predates the `provider` field and must keep
// compiling without supplying it -- z.input models the pre-default shape (`provider` optional),
// matching how these call sites are actually used (NREG-03/Pitfall 10).
export type ReviewJobMessage = z.input<typeof reviewJobMessageSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type FileReviewRecord = z.infer<typeof fileReviewRecordSchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type RepoConfigRecord = z.infer<typeof repoConfigRecordSchema>;
export const llmProviderSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  apiFormat: z.enum(llmApiFormats),
  baseUrl: z.url().nullable(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
});

export const modelConfigSchema = z.object({
  modelId: z.string(),
  providerId: z.uuid(),
  providerName: z.string(),
  apiFormat: z.enum(llmApiFormats),
  modelName: z.string(),
  updatedAt: dateStringSchema,
});

export type LlmApiFormat = z.infer<typeof llmProviderSchema>['apiFormat'];
export type LlmProvider = z.infer<typeof llmProviderSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;

// --- VCS bot-credential contracts (Phase 4, contract-first D-05/D-10) ---
// Four-state credential status computed server-side from token_expires_at (D-05).
export const credentialStatusSchema = z.enum(['missing', 'expired', 'expiring-soon', 'valid']);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

// Redacted READ DTO — never carries secrets/ciphertext (D-10 / T-04-01). Only presence
// booleans, expiry, label, and computed status. `dateStringSchema` is correct here: these
// are DB-generated OUTPUT values being serialized, so the loose shape is intentional.
export const vcsCredentialStatusSchema = z.object({
  vcsProvider: z.enum(vcsProviders),
  workspace: z.string(),
  repoSlug: z.string(),
  hasToken: z.boolean(),
  hasWebhookSecret: z.boolean(),
  tokenExpiresAt: dateStringSchema.nullable(),
  label: z.string().nullable(),
  status: credentialStatusSchema,
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
});
export type VcsCredentialStatus = z.infer<typeof vcsCredentialStatusSchema>;

// WRITE/upsert request. `.strict()` rejects unknown keys at the boundary.
export const vcsCredentialStoreSchema = z
  .object({
    // Phase 4 stores only Bitbucket bot credentials; accepting `github` here is needless
    // write surface (review finding 6). Narrow to a literal with a default.
    vcsProvider: z.literal('bitbucket').default('bitbucket'),
    // Normalize workspace/repo slugs to lowercase at the storage boundary (review finding 11).
    // RATIONALE: Bitbucket canonicalizes workspace and repo slugs to lowercase in API paths
    // and webhook payloads. Normalizing here guarantees the Phase 5 webhook lookup — which
    // keys on the lowercase payload values — matches the stored
    // (vcs_provider, workspace, repo_slug) key. Chosen over deferring to Phase 5 because the
    // storage key must equal the lookup key, and doing it once at the single write boundary is
    // the cheapest place. Forward note for Phase 5: its webhook-route lookup must also
    // lowercase before querying.
    // Length caps (IN-03): defense-in-depth against an authenticated user storing arbitrarily
    // large values in the TEXT columns. Bounds are generous relative to real Bitbucket slugs and
    // bot tokens, so they never reject legitimate input while keeping row size predictable.
    workspace: z.string().trim().toLowerCase().min(1).max(100),
    repoSlug: z.string().trim().toLowerCase().min(1).max(100),
    accessToken: z.string().max(4096).optional(),
    webhookSecret: z.string().max(4096).optional(),
    // STRICT ISO INPUT (review finding 5 / IN-02): a malformed string like `not-a-date` or a
    // non-ISO locale format (`2026/07/13`, `March 5 2099`) MUST be rejected here so it never
    // reaches the TIMESTAMPTZ insert. The prior `Date.parse` refine was permissive despite this
    // comment. We accept exactly two strict shapes: a bare `YYYY-MM-DD` date (what the dashboard's
    // `type="date"` input actually sends, via `toDateInputValue`) and a full RFC3339 datetime with
    // optional offset. The serialized OUTPUT DTO (vcsCredentialStatusSchema) keeps the loose
    // `dateStringSchema` shape.
    tokenExpiresAt: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .nullable()
      .optional(),
    label: z.string().max(200).nullable().optional(),
    // Rotate-in-place semantics (D-11): omit a secret to leave it untouched, or set the
    // corresponding clear flag to null it out.
    clearToken: z.boolean().optional(),
    clearWebhookSecret: z.boolean().optional(),
  })
  .strict();
export type VcsCredentialStoreInput = z.infer<typeof vcsCredentialStoreSchema>;
export type StatsPayload = z.infer<typeof statsSchema>;

export const defaultRepoConfig = repoConfigSchema.parse({});

export const reviewConcurrencyLevels = ['low', 'medium', 'high', 'max'] as const;
export type ReviewConcurrencyLevel = typeof reviewConcurrencyLevels[number];
export const REVIEW_CONCURRENCY_LIMITS: Record<ReviewConcurrencyLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

export const reviewMaxCommentsOptions = [5, 10, 15, 20] as const;

export const reviewSettingsSchema = z.object({
  concurrencyLevel: z.enum(reviewConcurrencyLevels).default('medium'),
  maxComments: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(10),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
