import { passesConfidenceFloor } from '@server/core/review';
import type { ParsedReviewComment } from '@shared/schema';

function comment(confidence: number | null | undefined): ParsedReviewComment {
  return {
    path: 'src/example.ts',
    severity: 'P1',
    category: 'quality',
    title: 'x',
    body: 'y',
    confidence,
  } as ParsedReviewComment;
}

describe('passesConfidenceFloor — fail-open confidence gate', () => {
  const floor = 0.7;

  it('drops a finding below the floor', () => {
    expect(passesConfidenceFloor(comment(0.6), floor)).toBe(false);
  });

  it('keeps a finding exactly at the floor', () => {
    expect(passesConfidenceFloor(comment(0.7), floor)).toBe(true);
  });

  it('keeps a finding above the floor', () => {
    expect(passesConfidenceFloor(comment(0.9), floor)).toBe(true);
  });

  it('keeps a finding with null confidence (fail-open)', () => {
    expect(passesConfidenceFloor(comment(null), floor)).toBe(true);
  });

  it('keeps a finding with undefined confidence (fail-open)', () => {
    expect(passesConfidenceFloor(comment(undefined), floor)).toBe(true);
  });
});
