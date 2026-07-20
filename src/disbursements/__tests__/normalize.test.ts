import { describe, it, expect } from 'vitest';
import { normalizeLocation, normalizeText } from '../normalize';

describe('normalizeText', () => {
  it('strips punctuation, collapses whitespace, lowercases', () => {
    expect(normalizeText("  O'Brien-Smith,  Jr. ")).toBe('obrien-smith jr');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('normalizeLocation', () => {
  it('drops state suffixes so YOT and roster spellings agree', () => {
    expect(normalizeLocation('World of Golf FL.')).toBe('world of golf');
    expect(normalizeLocation('World of Golf Fl.')).toBe('world of golf');
    expect(normalizeLocation('Yulee Rt. 200 FL.')).toBe('yulee rt 200');
    expect(normalizeLocation('Yulee Rt. 200 FL')).toBe('yulee rt 200');
  });

  it('treats trailing-space and state-suffix variants of a shop as one', () => {
    expect(normalizeLocation('Waterford ')).toBe(normalizeLocation('Waterford'));
    expect(normalizeLocation('Morgantown WV')).toBe(normalizeLocation('Morgantown'));
  });

  it('makes same-named shops in different states collide (guarded in Task 4)', () => {
    expect(normalizeLocation('Monroe')).toBe(normalizeLocation('Monroe FL'));
  });
});
