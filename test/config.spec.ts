import { parseRepoConfig } from '@server/core/config';

describe('parseRepoConfig', () => {
  it('returns defaults when config is missing', () => {
    const parsed = parseRepoConfig(null);
    expect(parsed.configMissing).toBe(true);
    expect(parsed.parsedJson.review.max_files).toBe(15);
  });

  it('merges custom values through schema defaults', () => {
    const parsed = parseRepoConfig(`
review:
  max_files: 5
  custom_rules:
    - Never skip audit logs
`);

    expect(parsed.configMissing).toBe(false);
    expect(parsed.parsedJson.review.max_files).toBe(5);
    expect(parsed.parsedJson.review.ignore_drafts).toBe(true);
    expect(parsed.parsedJson.review.custom_rules).toContain('Never skip audit logs');
  });
});
