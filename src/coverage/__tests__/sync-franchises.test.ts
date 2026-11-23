import { describe, expect, it } from 'vitest';
import { franchiseSyncOrder } from '../sync-franchises';

describe('franchiseSyncOrder', () => {
  it('stamps corporate first so a specific owner wins an overlapping shop', () => {
    const rows = franchiseSyncOrder([
      { name: 'Terry Morgantown', franchiseId: '77' },
      { name: 'Hair MX', franchiseId: '1' },
      { name: 'Tony', franchiseId: '22' },
    ]);

    expect(rows.map((row) => row.franchiseId)).toEqual(['1', '77', '22']);
  });
});
