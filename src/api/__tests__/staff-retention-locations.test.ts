import { describe, it, expect } from 'vitest';
import { canonicalLocationName } from '../handler';
import { groupRetentionByLocation } from '../staff-retention';

const row = (locationName: string, staffName: string, totalSales: number, syncedAt: string) => ({
  locationName,
  staffName,
  totalSales,
  syncedAt,
});

describe('groupRetentionByLocation', () => {
  it('returns a renamed shop under its current name', () => {
    // Windows synced before 2026-11-10 carry the report's old spelling. The
    // locations table and the cohort endpoint both use the new one, so a shop
    // left under the old name drops out of the ownership filter and loses its
    // new-client cohort figures.
    const out = groupRetentionByLocation(
      [
        row('Waterford', 'Pat Example', 40, '2026-10-05T14:00:00.000Z'),
        row('Westland', 'Sam Example', 30, '2026-10-05T14:00:00.000Z'),
        row('Brighton MI', 'Lee Example', 20, '2026-10-05T14:00:00.000Z'),
      ],
      canonicalLocationName,
    );
    expect(out.map((l) => l.locationName)).toEqual(['Brighton MI', 'Waterford Mi', 'Westland Mi.']);
    expect(out[1].staff.map((s) => s.staffName)).toEqual(['Pat Example']);
  });

  it('keeps only the newest snapshot when one window holds a shop under two names', () => {
    // A window re-synced after the rename has the same shop twice: the stale
    // rows under the old name and the fresh ones under the new name. Merging
    // them would double every count.
    const out = groupRetentionByLocation(
      [
        row('Waterford', 'Pat Example', 40, '2026-11-09T14:26:05.087Z'),
        row('Waterford', 'Gone Example', 3, '2026-11-05T14:26:33.737Z'),
        row('Waterford Mi', 'Pat Example', 41, '2026-11-17T15:11:02.279Z'),
      ],
      canonicalLocationName,
    );
    expect(out).toHaveLength(1);
    expect(out[0].locationName).toBe('Waterford Mi');
    expect(out[0].staff).toEqual([row('Waterford Mi', 'Pat Example', 41, '2026-11-17T15:11:02.279Z')]);
  });

  it('sorts staff by total sales, then name, and leaves other shops untouched', () => {
    const out = groupRetentionByLocation(
      [
        row('Brighton MI', 'Bea Example', 10, 't'),
        row('Brighton MI', 'Abe Example', 10, 't'),
        row('Brighton MI', 'Cy Example', 25, 't'),
      ],
      canonicalLocationName,
    );
    expect(out[0].staff.map((s) => s.staffName)).toEqual(['Cy Example', 'Abe Example', 'Bea Example']);
  });
});
