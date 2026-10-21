import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// POST /clients creates the client in YOT (the system of record) and then
// caches it the same way the roster sync would, so segments see it at once.
const { saveClientMock, fetchClientMock } = vi.hoisted(() => ({ saveClientMock: vi.fn(), fetchClientMock: vi.fn() }));
vi.mock('../../drivers/yot-client', () => ({
  saveClient: (...a: any[]) => saveClientMock(...a),
  fetchClient: (...a: any[]) => fetchClientMock(...a),
  fetchClients: vi.fn(), characterizeClientPaging: vi.fn(), extractAppointmentsRangeRows: vi.fn(),
  fetchAppointmentsRange: vi.fn(), fetchBusiness: vi.fn(),
  fetchLocationServices: vi.fn(), fetchLocationStaff: vi.fn(),
  fetchLocations: vi.fn(), fetchStaffProfile: vi.fn(), ping: vi.fn(),
}));

import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

let tmp: string;
let teamSeq = 0;
function freshTeam(): string {
  const teamId = `T${teamSeq++}`;
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare('INSERT INTO plugin_config (team_id, key, value, updated_at) VALUES (?,?,?,?)')
    .run(teamId, 'yot', JSON.stringify({ apiKey: 'k' }), new Date().toISOString());
  return teamId;
}
const create = (teamId: string, body: any) =>
  handleRequest({ method: 'POST', path: '/clients', query: { team: teamId }, headers: {}, body }, {} as any);
const cached = (teamId: string, id: string) => {
  const { sqlite } = initializeDatabase(teamId);
  return sqlite.prepare('SELECT id, first_name AS firstName, last_name AS lastName, mobile_phone AS mobilePhone, email_address AS emailAddress, source_location_id AS sourceLocationId, active FROM clients WHERE team_id=? AND id=?').get(teamId, id) as any;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-clients-create-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
  saveClientMock.mockReset();
  fetchClientMock.mockReset();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('POST /clients', () => {
  it('saves to YOT, re-reads the record by id, caches it, and returns it', async () => {
    saveClientMock.mockResolvedValue({ id: 9001 });
    fetchClientMock.mockResolvedValue({ id: 9001, givenName: 'Test', surname: 'Walkin', mobilePhone: '3135550199', emailAddress: 't@example.com', active: true });
    const teamId = freshTeam();
    const res: any = await create(teamId, { givenName: 'Test', surname: 'Walkin', mobilePhone: '(313) 555-0199', emailAddress: 't@example.com', sourceLocationId: '1347' });
    expect(res.status).toBe(201);
    expect(res.data.client).toMatchObject({ id: '9001', firstName: 'Test', lastName: 'Walkin', mobilePhone: '3135550199' });
    // What went to YOT: the fields the operator typed, nothing invented.
    const sent = saveClientMock.mock.calls[0][1];
    expect(sent).toMatchObject({ givenName: 'Test', surname: 'Walkin', mobilePhone: '(313) 555-0199', emailAddress: 't@example.com', active: true });
    expect(sent.id).toBeUndefined();
    expect(fetchClientMock).toHaveBeenCalledWith(expect.anything(), 9001, expect.anything());
    const row = cached(teamId, '9001');
    expect(row).toMatchObject({ firstName: 'Test', lastName: 'Walkin', mobilePhone: '3135550199', sourceLocationId: '1347', active: 1 });
  });

  it('requires a first name and a phone', async () => {
    const teamId = freshTeam();
    expect((await create(teamId, { surname: 'X', mobilePhone: '3135550199' }) as any).status).toBe(400);
    expect((await create(teamId, { givenName: 'Test' }) as any).status).toBe(400);
    expect(saveClientMock).not.toHaveBeenCalled();
  });

  it('refuses a mobile number that is already on the roster, naming the match', async () => {
    const teamId = freshTeam();
    const { sqlite } = initializeDatabase(teamId);
    sqlite.prepare('INSERT INTO clients (id, team_id, first_name, mobile_phone, active, synced_at) VALUES (?,?,?,?,?,?)')
      .run('77', teamId, 'Already', '313-555-0199', 1, new Date().toISOString());
    const res: any = await create(teamId, { givenName: 'Dup', mobilePhone: '3135550199' });
    expect(res.status).toBe(409);
    expect(res.data.details.existing).toMatchObject({ id: '77', firstName: 'Already' });
    expect(saveClientMock).not.toHaveBeenCalled();
  });

  it('maps a YOT failure to 502 and caches nothing', async () => {
    saveClientMock.mockRejectedValue(new Error('YOT /client/save failed: 500'));
    const teamId = freshTeam();
    const res: any = await create(teamId, { givenName: 'Test', mobilePhone: '3135550199' });
    expect(res.status).toBe(502);
    expect(cached(teamId, '9001')).toBeUndefined();
  });

  it('still answers 201 from the save response when the re-read is not available yet', async () => {
    saveClientMock.mockResolvedValue({ id: 9002, givenName: 'Test', mobilePhone: '3135550198', active: true });
    fetchClientMock.mockResolvedValue(null); // YOT read-after-write lag
    const teamId = freshTeam();
    const res: any = await create(teamId, { givenName: 'Test', mobilePhone: '3135550198' });
    expect(res.status).toBe(201);
    expect(cached(teamId, '9002')).toMatchObject({ firstName: 'Test', mobilePhone: '3135550198' });
  });
});
