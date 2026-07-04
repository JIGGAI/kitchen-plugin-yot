import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRequest } from '../handler';
import { initializeDatabase } from '../../db';

let tmp: string;
let seq = 0;
function freshTeam(): string {
  const teamId = `CE${seq++}`;
  initializeDatabase(teamId);
  return teamId;
}
function seed(teamId: string, c: { id: string; author: string; body: string }) {
  const { sqlite } = initializeDatabase(teamId);
  sqlite.prepare(
    `INSERT INTO coverage_day_comments (id, team_id, location_id, date, author_email, author_name, body, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(c.id, teamId, 'L1', '2026-06-22', c.author, 'A', c.body, '2026-06-22T09:00:00Z');
}
const patch = (teamId: string, body: Record<string, unknown>): Promise<any> =>
  handleRequest({ method: 'PATCH', path: '/coverage/day-comments', query: { team: teamId }, headers: {}, body } as any, {} as any);
const getOne = (teamId: string): Promise<any> =>
  handleRequest({ method: 'GET', path: '/coverage/day-comments', query: { team: teamId, locationId: 'L1', date: '2026-06-22' }, headers: {}, body: null } as any, {} as any);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yot-comment-edit-'));
  process.env.HOME = tmp;
  process.env.YOT_ALLOW_DB_AUTOCREATE = '1';
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('PATCH /coverage/day-comments', () => {
  it('author edits own comment: body updates and updatedAt is stamped', async () => {
    const t = freshTeam();
    seed(t, { id: '1', author: 'me@x.co', body: 'original' });
    const res = await patch(t, { id: '1', body: 'edited text', authorEmail: 'me@x.co' });
    expect(res.status).toBe(200);
    expect(res.data.comment.body).toBe('edited text');
    expect(typeof res.data.comment.updatedAt).toBe('string');
    // GET reflects the edit and surfaces updatedAt
    const list = await getOne(t);
    const row = list.data.comments.find((c: any) => c.id === '1');
    expect(row.body).toBe('edited text');
    expect(row.updatedAt).toBeTruthy();
  });

  it('a different user cannot edit: 403 and body unchanged', async () => {
    const t = freshTeam();
    seed(t, { id: '1', author: 'owner@x.co', body: 'original' });
    const res = await patch(t, { id: '1', body: 'hijack', authorEmail: 'someone@else.co' });
    expect(res.status).toBe(403);
    const list = await getOne(t);
    expect(list.data.comments.find((c: any) => c.id === '1').body).toBe('original');
  });

  it('missing comment → 404', async () => {
    const t = freshTeam();
    expect((await patch(t, { id: 'nope', body: 'x', authorEmail: 'me@x.co' })).status).toBe(404);
  });

  it('validates required fields and length', async () => {
    const t = freshTeam();
    seed(t, { id: '1', author: 'me@x.co', body: 'original' });
    expect((await patch(t, { body: 'x', authorEmail: 'me@x.co' })).status).toBe(400); // no id
    expect((await patch(t, { id: '1', authorEmail: 'me@x.co' })).status).toBe(400);   // no body
    expect((await patch(t, { id: '1', body: 'x' })).status).toBe(400);                // no authorEmail
    expect((await patch(t, { id: '1', body: 'z'.repeat(4001), authorEmail: 'me@x.co' })).status).toBe(400);
  });
});
