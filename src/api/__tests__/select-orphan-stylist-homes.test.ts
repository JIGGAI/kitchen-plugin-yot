import { describe, it, expect } from 'vitest';
import { selectOrphanStylistHomes } from '../handler';

describe('selectOrphanStylistHomes', () => {
  it('files an orphan under the location where they have the most appointments', () => {
    const home = selectOrphanStylistHomes(
      [
        { sid: '1655', locId: '6857', n: 43 }, // Howell
        { sid: '1655', locId: '7712', n: 37 }, // Rochester
        { sid: '1655', locId: '4176', n: 19 }, // Brighton
      ],
      new Set(),
    );
    expect(home.get('1655')).toBe('6857');
  });

  it('skips stylists already known in the stylists table', () => {
    const home = selectOrphanStylistHomes(
      [
        { sid: '84839', locId: '6857', n: 200 }, // already synced
        { sid: '1655', locId: '7712', n: 5 }, // orphan
      ],
      new Set(['84839']),
    );
    expect(home.has('84839')).toBe(false);
    expect(home.get('1655')).toBe('7712');
  });

  it('ignores rows with a null stylist id or null location', () => {
    const home = selectOrphanStylistHomes(
      [
        { sid: null, locId: '6857', n: 10 },
        { sid: '1655', locId: null, n: 10 },
        { sid: '1655', locId: '7712', n: 3 },
      ],
      new Set(),
    );
    expect(home.size).toBe(1);
    expect(home.get('1655')).toBe('7712');
  });

  it('handles multiple orphans independently', () => {
    const home = selectOrphanStylistHomes(
      [
        { sid: '1655', locId: '6857', n: 43 },
        { sid: '65123', locId: '7712', n: 28 },
        { sid: '65123', locId: '6857', n: 30 },
      ],
      new Set(),
    );
    expect(home.get('1655')).toBe('6857');
    expect(home.get('65123')).toBe('6857');
  });

  it('returns an empty map when every stylist is already known', () => {
    const home = selectOrphanStylistHomes(
      [{ sid: '84839', locId: '6857', n: 5 }],
      new Set(['84839']),
    );
    expect(home.size).toBe(0);
  });
});
