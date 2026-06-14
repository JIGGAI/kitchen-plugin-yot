import { describe, it, expect } from 'vitest';
import { buildStylistNameMap } from '../handler';

describe('buildStylistNameMap', () => {
  it('resolves a name from a composite-keyed stylists row via private_id', () => {
    // stylists.id is stored as `LOCATION:YOT_ID`; appointments/roster use the
    // bare YOT id. Matching the raw id never lined up → "Stylist <id>" labels.
    const map = buildStylistNameMap(
      [],
      [{ id: '6857:84839', privateId: '84839', fullName: 'Cari Benedict (Artist)' }],
    );
    expect(map.get('84839')).toBe('Cari Benedict (Artist)');
  });

  it('falls back to stripping the LOCATION: prefix when private_id is absent', () => {
    const map = buildStylistNameMap(
      [],
      [{ id: '7712:83983', privateId: null, fullName: 'Jordan Lee' }],
    );
    expect(map.get('83983')).toBe('Jordan Lee');
  });

  it('uses the id as-is when it has no LOCATION: prefix and no private_id', () => {
    const map = buildStylistNameMap(
      [],
      [{ id: '99001', privateId: null, fullName: 'Sam Doe' }],
    );
    expect(map.get('99001')).toBe('Sam Doe');
  });

  it('prefers the roster name over the stylists-table name', () => {
    const map = buildStylistNameMap(
      [{ stylistId: '84839', stylistName: 'Cari (roster)' }],
      [{ id: '6857:84839', privateId: '84839', fullName: 'Cari (table)' }],
    );
    expect(map.get('84839')).toBe('Cari (roster)');
  });

  it('still resolves off-roster ids absent from the roster payload', () => {
    // The exact failure mode: stylist booked appointments but is not on the
    // day's roster, so only the stylists table can name them.
    const map = buildStylistNameMap(
      [{ stylistId: '86363', stylistName: 'Allison (roster)' }],
      [
        { id: '6857:86363', privateId: '86363', fullName: 'Allison (table)' },
        { id: '6857:84839', privateId: '84839', fullName: 'Cari Benedict' },
      ],
    );
    expect(map.get('86363')).toBe('Allison (roster)'); // on roster → roster wins
    expect(map.get('84839')).toBe('Cari Benedict');     // off roster → table fills the gap
  });

  it('skips roster rows without a name and stylist rows without a full name', () => {
    const map = buildStylistNameMap(
      [{ stylistId: '111', stylistName: null }],
      [{ id: '6857:222', privateId: '222', fullName: null }],
    );
    expect(map.has('111')).toBe(false);
    expect(map.has('222')).toBe(false);
  });
});
