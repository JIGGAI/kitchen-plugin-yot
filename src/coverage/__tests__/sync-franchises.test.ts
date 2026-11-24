import { describe, expect, it } from 'vitest';
import { franchiseSyncOrder, requireFranchiseRows } from '../sync-franchises';

describe('franchiseSyncOrder', () => {
  it('stamps corporate last so corporate wins an overlapping shop', () => {
    const rows = franchiseSyncOrder([
      { name: 'Terry Morgantown', franchiseId: '77' },
      { name: 'Hair MX', franchiseId: '1' },
      { name: 'Tony', franchiseId: '22' },
    ]);

    expect(rows.map((row) => row.franchiseId)).toEqual(['77', '22', '1']);
  });

  it('fails closed when YOT parses to zero rows', () => {
    expect(() => requireFranchiseRows([])).toThrow(/FRANCHISE_SYNC_EMPTY/);
  });

  it('passes a non-empty roster through unchanged', () => {
    const rows = [{ name: 'Hair MX' }];
    expect(requireFranchiseRows(rows)).toBe(rows);
  });
});
