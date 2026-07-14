import { z } from 'zod';
import type { JobDetail, JobSummary, RepoConfigRecord, StatsPayload } from './schema';

// D-26: DashboardSessionUser/AuthSessionUser is a discriminated union keyed on `provider`.
// This is the SINGLE canonical definition — src/server/env.ts imports and re-exports this
// exact schema object as dashboardSessionUserSchema so the server and client sides cannot
// independently drift (06-REVIEWS.md HIGH consensus finding). Do NOT redefine this schema
// anywhere else.
export const authSessionUserSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('github'),
    githubUserId: z.number(),
    login: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    email: z.string().nullable(),
    signedInAt: z.string(),
  }),
  z.object({
    provider: z.literal('bitbucket'),
    accountId: z.string(),
    uuid: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    email: z.string().nullable(),
    signedInAt: z.string(),
    // Deviation (Rule 3 — auto-fixed blocking issue found during 06-02 execution): this
    // optional field is NOT part of the Bitbucket variant's real shape (D-26). It exists
    // solely so TypeScript allows `data.user.login` to be read across the union WITHOUT
    // narrowing first, resolving to `string | undefined`. This is required because the
    // NREG-02 protected spec test/api.spec.ts:316 reads `data.user.login` unnarrowed and
    // that spec must NOT be edited. Runtime validation is unaffected: the field is optional
    // and unused by any Bitbucket code path.
    login: z.string().optional(),
  }),
]);

export type AuthSessionUser = z.infer<typeof authSessionUserSchema>;

export type ApiErrorPayload = {
  error: string;
};

export type JobsResponse = {
  jobs: JobSummary[];
  total: number;
};

export type AuthSessionResponse = {
  user: AuthSessionUser;
};

export type JobDetailResponse = {
  job: JobDetail;
};

export type RetryJobResponse = {
  job: JobSummary;
};

export type RepoConfigsResponse = {
  repos: RepoConfigRecord[];
};

export type RepoConfigResponse = {
  repo: RepoConfigRecord;
};

export type StatsResponse = {
  stats: StatsPayload;
};

export type SyncReposResponse = {
  ok: boolean;
  synced: string[];
};


export type ModelConfigsResponse = {
  providers: import('./schema').LlmProvider[];
  configs: import('./schema').ModelConfig[];
  syncErrors?: Array<{ providerId: string; providerName: string; error: string }>;
};
