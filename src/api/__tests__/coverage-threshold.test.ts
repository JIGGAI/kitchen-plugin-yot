import { describe, it, expect } from 'vitest';
import { LIGHT_HOURS_RED_THRESHOLD, isUnderCover } from '../coverage-threshold';

describe('isUnderCover', () => {
  it('flags a day red at 6 or more short hours', () => {
    expect(LIGHT_HOURS_RED_THRESHOLD).toBe(6);
    expect(isUnderCover(6)).toBe(true);
    expect(isUnderCover(6.5)).toBe(true);
    expect(isUnderCover(12)).toBe(true);
  });

  it('keeps a day green at 5 or fewer short hours', () => {
    expect(isUnderCover(0)).toBe(false);
    expect(isUnderCover(3)).toBe(false);
    expect(isUnderCover(5)).toBe(false);
  });

  it('keeps fractional person-hours between 5 and 6 green', () => {
    expect(isUnderCover(5.5)).toBe(false);
    expect(isUnderCover(5.9)).toBe(false);
  });
});
