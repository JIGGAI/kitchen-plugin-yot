import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// GET /monthly-performance serves client_count ("# of Clients", the clients
// seen in the month) next to total_clients (the size of the client list).
vi.mock('../../drivers/yot-client', () => ({
  saveClient: vi.fn(), fetchClient: vi.fn(), fetchClients: vi.fn(),
  characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-mps-client-count-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('GET /monthly-performance client count', () => {
  it('returns the month client count, and null for a row stored before the column', async () => {
    const teamId = 'CC0';
    const { sqlite } = initializeDatabase(teamId);
    const insert = sqlite.prepare(
      `INSERT INTO monthly_performance_facts (team_id, location_id, year_month, total_clients, client_count, sales_count, total_sales, last_updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    insert.run(teamId, '1', '2026-10', 9000, 450, 480, 15200, '2026-11-01T00:00:00Z');
    insert.run(teamId, '2', '2026-10', 4000, null, 200, 6000, '2026-11-01T00:00:00Z');
    const res: any = await handleRequest({ method: 'GET', path: '/monthly-performance', query: { team: teamId, yearMonth: '2026-10' }, headers: {}, body: null }, {} as any);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.data.locations.map((l: any) => [l.locationId, l]));
    expect(byId['1']).toMatchObject({ totalClients: 9000, clientCount: 450 });
    expect(byId['2']).toMatchObject({ totalClients: 4000, clientCount: null });
  });
});
