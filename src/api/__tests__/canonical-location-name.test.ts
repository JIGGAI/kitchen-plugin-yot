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
