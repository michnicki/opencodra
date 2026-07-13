import { z } from 'zod';
import {
  BUILD_STATUS_STATE,
  LINE_TYPES,
  REPORT_RESULT,
  REPORT_TYPE_VALUES,
} from '@server/bitbucket/constants';

// These schemas lock the Bitbucket fields Codra consumes or emits. Objects are strict by design so
// API drift fails at the boundary instead of silently producing a malformed review. REV-M-1 keeps
// eventName outside the raw body: the route injects X-Event-Key after capturing and parsing the raw
// body. REV-M-2 keeps comments Bitbucket-native, while REV-M-4 imports every emitted API enum from
// the server constants module. Any upstream contract change requires updating this versioned seam.
const workspaceSchema = z.object({
  slug: z.string().min(1),
}).strict();

const repositorySchema = z.object({
  full_name: z.string().min(1),
  workspace: workspaceSchema,
  uuid: z.string().min(1),
}).strict();

const branchSchema = z.object({
  name: z.string().min(1),
}).strict();

const commitSchema = z.object({
  hash: z.string().min(1),
}).strict();

const pullRequestSideSchema = z.object({
  branch: branchSchema,
  commit: commitSchema,
}).strict();

const pullRequestSchema = z.object({
  id: z.number().int().positive(),
  source: pullRequestSideSchema,
  destination: pullRequestSideSchema,
  title: z.string(),
  state: z.string().min(1),
}).strict();

export const bitbucketPullRequestWebhookBaseSchema = z.object({
  repository: repositorySchema,
  pullrequest: pullRequestSchema,
}).strict();

export const pullRequestCreatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:created'),
}).strict();

export const pullRequestUpdatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:updated'),
}).strict();

export const pullRequestWebhookPayloadSchema = z.discriminatedUnion('eventName', [
  pullRequestCreatedPayloadSchema,
  pullRequestUpdatedPayloadSchema,
]);

export const prCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  line_type: z.enum(LINE_TYPES),
  content: z.object({
    raw: z.string(),
  }).strict(),
}).strict();

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
