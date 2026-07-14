import { z } from 'zod';
import {
  BUILD_STATUS_STATE,
  LINE_TYPES,
  REPORT_RESULT,
  REPORT_TYPE_VALUES,
} from '@server/bitbucket/constants';

// These schemas lock the Bitbucket fields Codra consumes or emits. Inbound webhook objects preserve
// documented provider fields Codra does not consume, while outbound request objects stay strict so
// malformed API writes fail at the boundary. REV-M-1 keeps eventName outside the raw body: the route
// injects X-Event-Key after capturing and parsing the raw body. REV-M-2 keeps comments
// Bitbucket-native, while REV-M-4 imports every emitted API enum from the server constants module.
// Any upstream contract change requires updating this versioned seam.
const workspaceSchema = z.object({
  slug: z.string().min(1),
}).passthrough();

const repositorySchema = z.object({
  full_name: z.string().min(1),
  workspace: workspaceSchema,
  uuid: z.string().min(1),
}).passthrough();

const branchSchema = z.object({
  name: z.string().min(1),
}).passthrough();

const commitSchema = z.object({
  hash: z.string().min(1),
}).passthrough();

const pullRequestSideSchema = z.object({
  branch: branchSchema,
  commit: commitSchema,
}).passthrough();

const pullRequestSchema = z.object({
  id: z.number().int().positive(),
  source: pullRequestSideSchema,
  destination: pullRequestSideSchema,
  title: z.string(),
  state: z.string().min(1),
}).passthrough();

export const bitbucketPullRequestWebhookBaseSchema = z.object({
  repository: repositorySchema,
  pullrequest: pullRequestSchema,
}).passthrough();

export const pullRequestCreatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:created'),
}).passthrough();

export const pullRequestUpdatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:updated'),
}).passthrough();

export const pullRequestWebhookPayloadSchema = z.discriminatedUnion('eventName', [
  pullRequestCreatedPayloadSchema,
  pullRequestUpdatedPayloadSchema,
]);

const commentContentSchema = z.object({
  raw: z.string(),
}).strict();

const topLevelPrCommentSchema = z.object({
  content: commentContentSchema,
}).strict();

const inlinePrCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  line_type: z.enum(LINE_TYPES),
  content: commentContentSchema,
}).strict();

export const prCommentSchema = z.union([
  topLevelPrCommentSchema,
  inlinePrCommentSchema,
]);

const reportDataTypeSchema = z.enum([
  'BOOLEAN',
  'DATE',
  'DURATION',
  'LINK',
  'NUMBER',
  'PERCENTAGE',
  'TEXT',
]);

const reportDataSchema = z.object({
  title: z.string().min(1),
  type: reportDataTypeSchema,
  value: z.union([z.boolean(), z.number(), z.string()]),
}).strict();

export const codeInsightsReportSchema = z.object({
  title: z.string().min(1),
  details: z.string(),
  report_type: z.enum(REPORT_TYPE_VALUES),
  result: z.enum(REPORT_RESULT),
  link: z.url().optional(),
  data: z.array(reportDataSchema).max(10).optional(),
}).strict();

export const commitBuildStatusSchema = z.object({
  key: z.string().min(1),
  state: z.enum(BUILD_STATUS_STATE),
  description: z.string(),
  url: z.url(),
}).strict();

export type BitbucketPullRequestWebhookBase = z.infer<typeof bitbucketPullRequestWebhookBaseSchema>;
export type PullRequestCreatedPayload = z.infer<typeof pullRequestCreatedPayloadSchema>;
export type PullRequestUpdatedPayload = z.infer<typeof pullRequestUpdatedPayloadSchema>;
export type PullRequestWebhookPayload = z.infer<typeof pullRequestWebhookPayloadSchema>;
export type PrComment = z.infer<typeof prCommentSchema>;
export type CodeInsightsReport = z.infer<typeof codeInsightsReportSchema>;
export type CommitBuildStatus = z.infer<typeof commitBuildStatusSchema>;

// Phase 6 (D-33/D-34): inbound Bitbucket OAuth /2.0/user profile response. `.passthrough()`
// preserves documented provider fields Codra does not consume, mirroring the webhook-inbound
// convention above.
export const bitbucketOAuthProfileSchema = z.object({
  account_id: z.string().min(1),
  uuid: z.string().min(1),
  username: z.string().min(1),
  display_name: z.string().nullable(),
  avatar: z.string().nullable().optional(),
  links: z.object({
    avatar: z.object({ href: z.string().url() }).optional(),
  }).passthrough().optional(),
  email: z.string().nullable().optional(),
}).passthrough();

// Phase 6 (D-32): outbound add-repo form input. `.strict()` rejects unknown keys so malformed
// API writes fail at the boundary, mirroring vcsCredentialStoreSchema (src/shared/schema.ts).
export const addBitbucketRepoInputSchema = z.object({
  workspace: z.string().trim().toLowerCase().min(1).max(100),
  repoSlug: z.string().trim().toLowerCase().min(1).max(100),
  accessToken: z.string().trim().min(1).max(4096),
  webhookSecret: z.string().trim().min(1).max(4096),
  tokenExpiresAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable().optional(),
}).strict();

export type BitbucketOAuthProfile = z.infer<typeof bitbucketOAuthProfileSchema>;
export type AddBitbucketRepoInput = z.infer<typeof addBitbucketRepoInputSchema>;
