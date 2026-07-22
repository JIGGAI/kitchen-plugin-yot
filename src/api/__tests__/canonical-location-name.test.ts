import { describe, it, expect } from 'vitest';
import { canonicalLocationName } from '../handler';

describe('canonicalLocationName', () => {
  const CANON = 'Treaty Oaks St. Aug. FL.';

  it('merges the three St. Augustine / Treaty Oaks variants onto the canonical name', () => {
    expect(canonicalLocationName('St. Augustine FL.')).toBe(CANON);
    expect(canonicalLocationName('Treaty Oaks St. Augustine Fl.')).toBe(CANON);
    // The canonical name maps to itself.
    expect(canonicalLocationName('Treaty Oaks St. Aug. FL.')).toBe(CANON);
  });

  it('folds a CASE-ONLY variant of the canonical name', () => {
    // Regression: the alias map held no key for the canonical name's own
    // normalized form, so this missed the lookup and fell through to `raw`.
    // That let YOT's inactive location 7429 ('...Aug. Fl.', lowercase 'l')
    // survive as a separate shop alongside the active 7432 ('...Aug. FL.'),
    // double-counting May 2026 revenue by $15,369 on /monthly-leadership.
    expect(canonicalLocationName('Treaty Oaks St. Aug. Fl.')).toBe(CANON);
    expect(canonicalLocationName('TREATY OAKS ST. AUG. FL.')).toBe(CANON);
    expect(canonicalLocationName('  treaty oaks   st. aug.   fl.  ')).toBe(CANON);
  });

  it('is idempotent — canonicalizing an already-canonical name is a no-op', () => {
    expect(canonicalLocationName(canonicalLocationName('Treaty Oaks St. Aug. Fl.'))).toBe(CANON);
    expect(canonicalLocationName(canonicalLocationName('Brighton MI'))).toBe('Brighton MI');
  });

  it('is case- and whitespace-insensitive when matching aliases', () => {
    expect(canonicalLocationName('  st. augustine fl.  ')).toBe(CANON);
    expect(canonicalLocationName('Treaty Oaks   St. Augustine   Fl.')).toBe(CANON);
  });

  it('passes through non-aliased names unchanged (incl. their original spacing)', () => {
    expect(canonicalLocationName('Brighton MI')).toBe('Brighton MI');
    expect(canonicalLocationName('Clinton Twp.  MI')).toBe('Clinton Twp.  MI');
    expect(canonicalLocationName('World of Golf FL.')).toBe('World of Golf FL.');
  });

  it('handles null/undefined/empty safely', () => {
    expect(canonicalLocationName(null)).toBe('');
    expect(canonicalLocationName(undefined)).toBe('');
    expect(canonicalLocationName('')).toBe('');
  });
});
