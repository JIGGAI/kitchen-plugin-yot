import { describe, it, expect } from 'vitest';
import { cleanRosterStylistName } from '../handler';

describe('cleanRosterStylistName', () => {
  it('strips the trailing role suffix YOT appends to roster names', () => {
    expect(cleanRosterStylistName('Alaysa Kwek (Stylist)')).toBe('Alaysa Kwek');
    expect(cleanRosterStylistName('Des Johnson (ARTIST)')).toBe('Des Johnson');
    expect(cleanRosterStylistName('Marie Tocco (Artist)')).toBe('Marie Tocco');
  });

  it('handles the stray space inside/around the suffix', () => {
    // Real roster payload: "Chelsea  Desselles (Stylist )".
    expect(cleanRosterStylistName('Chelsea  Desselles (Stylist )')).toBe('Chelsea Desselles');
    expect(cleanRosterStylistName('Lex Blanco  (Stylist)')).toBe('Lex Blanco');
  });

  it('collapses the double spaces that also appear in StaffPerformance names', () => {
    // Both sides of the name join need the same whitespace treatment —
    // the report ships "Lessie  Traylor", the roster ships "Blu Traylor".
    expect(cleanRosterStylistName('Lessie  Traylor')).toBe('Lessie Traylor');
    expect(cleanRosterStylistName('  Allison   Indra  ')).toBe('Allison Indra');
  });

  it('leaves a clean name untouched, and is idempotent', () => {
    expect(cleanRosterStylistName('Blu Traylor')).toBe('Blu Traylor');
    expect(cleanRosterStylistName(cleanRosterStylistName('Alaysa Kwek (Stylist)'))).toBe('Alaysa Kwek');
  });

  it('only strips a suffix at the END — a parenthetical mid-name survives', () => {
    expect(cleanRosterStylistName('Sarah (Sam) Sharp')).toBe('Sarah (Sam) Sharp');
  });

  it('handles null/undefined/empty safely', () => {
    expect(cleanRosterStylistName(null)).toBe('');
    expect(cleanRosterStylistName(undefined)).toBe('');
    expect(cleanRosterStylistName('')).toBe('');
    // A name that is nothing BUT a suffix collapses to empty rather than
    // producing a bare "(Stylist)" label.
    expect(cleanRosterStylistName('(Stylist)')).toBe('');
  });
});
