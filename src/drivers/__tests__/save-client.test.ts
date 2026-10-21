import { describe, it, expect, vi, afterEach } from 'vitest';
import { saveClient } from '../yot-client';

// YOT creates a client through POST /1/api/client/save with the same field
// names its GET /client/{id} returns. The driver posts JSON and hands back
// whatever YOT answers, so the caller can read the new id.
describe('saveClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs the client as JSON to /client/save and returns the parsed reply', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 42, givenName: 'Test' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await saveClient({ apiKey: 'k' } as any, { givenName: 'Test', mobilePhone: '3135550199', active: true });
    expect(out).toMatchObject({ id: 42 });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toMatch(/\/1\/api\/client\/save$/);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type'] || init.headers['Content-Type']).toMatch(/application\/json/);
    expect(JSON.parse(init.body)).toMatchObject({ givenName: 'Test', mobilePhone: '3135550199', active: true });
  });

  it('throws with the status when YOT rejects the save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(saveClient({ apiKey: 'k' } as any, { givenName: 'Test' })).rejects.toThrow(/client\/save failed: 500/);
  });
});
