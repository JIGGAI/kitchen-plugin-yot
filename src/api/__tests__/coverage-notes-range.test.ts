import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

let tmp: string;
let seq = 0;
function freshTeam(): string {
  const teamId = `RN${seq++}`;
  initializeDatabase(teamId); // creates + migrates a temp db (incl. coverage_day_comments)
  return teamId;
}
function seed(teamId: string, c: { id: string; locationId: string; date: string; body: string; createdAt: string }) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO coverage_day_comments (id, team_id, location_id, date, author_email, author_name, body, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(c.id, teamId, c.locationId, c.date, 'a@b.co', 'A', c.body, c.createdAt);
}
const range = (teamId: string, start: string, end: string): Promise<any> =>
  handleRequest({ method: 'GET', path: '/coverage/day-comments/range', query: { team: teamId, start, end }, headers: {}, body: null } as any, {} as any);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-notes-range-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('GET /coverage/day-comments/range', () => {
  it('returns only comments within [start,end], ordered loc/date then newest-first', async () => {
    const t = freshTeam();
    seed(t, { id: '1', locationId: 'L1', date: '2026-06-21', body: 'before', createdAt: '2026-06-21T10:00:00Z' }); // out of range
    seed(t, { id: '2', locationId: 'L1', date: '2026-06-22', body: 'old', createdAt: '2026-06-22T08:00:00Z' });
    seed(t, { id: '3', locationId: 'L1', date: '2026-06-22', body: 'new', createdAt: '2026-06-22T09:00:00Z' });
    seed(t, { id: '4', locationId: 'L2', date: '2026-06-28', body: 'edge-end', createdAt: '2026-06-28T09:00:00Z' });
    seed(t, { id: '5', locationId: 'L2', date: '2026-06-29', body: 'after', createdAt: '2026-06-29T09:00:00Z' }); // out of range
    const res = await range(t, '2026-06-22', '2026-06-28');
    expect(res.status).toBe(200);
    expect(res.data.comments.map((c: any) => c.id)).toEqual(['3', '2', '4']);
    expect(res.data.comments[0]).toMatchObject({ locationId: 'L1', date: '2026-06-22', body: 'new', authorEmail: 'a@b.co' });
  });

  it('rejects missing, malformed, inverted, or oversized ranges with 400', async () => {
    const t = freshTeam();
    expect((await range(t, '', '2026-06-28')).status).toBe(400);
    expect((await range(t, '2026-6-1', '2026-06-28')).status).toBe(400);
    expect((await range(t, '2026-06-28', '2026-06-22')).status).toBe(400);
    expect((await range(t, '2026-01-01', '2026-12-31')).status).toBe(400);
  });
});
