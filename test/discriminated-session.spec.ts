import { describe, it, expect } from 'vitest';

// RED (Wave 0): `dashboardSessionUserSchema` does not exist yet on `@server/env` — Wave 1
// (06-02-PLAN.md) authors it as a re-export of the canonical `authSessionUserSchema` defined
// once in `@shared/api.ts` (per 06-REVIEWS.md HIGH finding "client/server schema drift" +
// Codex HIGH finding "RED specs cannot typecheck as written"). This import is expected to fail
// to resolve at collection time; that missing-module-export signal IS the acceptance criterion
// for this plan. Do NOT create the schema here (mirrors the Phase 4 Wave 0 precedent,
// `.planning/phases/04-bitbucket-bot-auth-credential-storage/04-01-PLAN.md` Task 1).
import { dashboardSessionUserSchema } from '@server/env';
// RED (Wave 0): `authSessionUserSchema` does not exist yet on `@shared/api` — Wave 1 defines it
// as the single source of truth that `@server/env`'s `dashboardSessionUserSchema` re-exports, so
// Block 1 and Block 2 below structurally cannot drift once Wave 1 lands (they parse against the
// literal same Zod object via two different module paths).
import { authSessionUserSchema } from '@shared/api';

// D-26: DashboardSessionUser / AuthSessionUser become a discriminated union keyed on `provider`.
// The GitHub variant fixture below matches the pre-Phase-6 shape (githubUserId, login, name,
// avatarUrl, email, signedInAt); the Bitbucket variant fixture matches the new shape introduced
// by this phase (accountId, uuid, username, displayName, avatarUrl, email, signedInAt).
const githubFixture = {
  provider: 'github' as const,
  githubUserId: 42,
  login: 'devarshishimpi',
  name: null,
  avatarUrl: null,
  email: null,
  signedInAt: '2026-07-13T00:00:00.000Z',
};

const bitbucketFixture = {
  provider: 'bitbucket' as const,
  accountId: '557058:1bb1b1aa-aaaa-bbbb-cccc-ddddeeeeffff',
  uuid: '{11111111-2222-3333-4444-555555555555}',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: 'https://bitbucket.org/account/alice/avatar/',
  email: null,
  signedInAt: '2026-07-13T00:00:00.000Z',
};

describe('DashboardSessionUser server-side discriminated union — D-26', () => {
  it('parses the GitHub variant by discriminator', () => {
    const parsed = dashboardSessionUserSchema.safeParse(githubFixture);
    expect(parsed.success).toBe(true);
  });

  it('parses the Bitbucket variant by discriminator', () => {
    const parsed = dashboardSessionUserSchema.safeParse(bitbucketFixture);
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload missing the provider discriminator', () => {
    const { provider, ...withoutProvider } = githubFixture;
    const parsed = dashboardSessionUserSchema.safeParse(withoutProvider);
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload with an unknown provider', () => {
    const parsed = dashboardSessionUserSchema.safeParse({ ...githubFixture, provider: 'gitlab' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a GitHub payload missing a variant-specific field (githubUserId)', () => {
    const { githubUserId, ...withoutGithubUserId } = githubFixture;
    const parsed = dashboardSessionUserSchema.safeParse(withoutGithubUserId);
    expect(parsed.success).toBe(false);
  });
});

describe('AuthSessionUser client-side discriminated union — D-26 mirror', () => {
  it('parses the GitHub variant by discriminator', () => {
    const parsed = authSessionUserSchema.safeParse(githubFixture);
    expect(parsed.success).toBe(true);
  });

  it('parses the Bitbucket variant by discriminator', () => {
    const parsed = authSessionUserSchema.safeParse(bitbucketFixture);
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload missing the provider discriminator', () => {
    const { provider, ...withoutProvider } = githubFixture;
    const parsed = authSessionUserSchema.safeParse(withoutProvider);
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload with an unknown provider', () => {
    const parsed = authSessionUserSchema.safeParse({ ...githubFixture, provider: 'gitlab' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a GitHub payload missing a variant-specific field (githubUserId)', () => {
    const { githubUserId, ...withoutGithubUserId } = githubFixture;
    const parsed = authSessionUserSchema.safeParse(withoutGithubUserId);
    expect(parsed.success).toBe(false);
  });
});
