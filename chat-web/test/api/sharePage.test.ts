import { describe, expect, it, vi } from 'vitest';
import { sharePage } from '../../src/api/sharePage';
import type { FetchLike } from '../../src/api/chatClient';
import type { Artifact } from '../../src/chat/artifact';

const artifact: Artifact = {
  key: 'a1/c1',
  callId: 'c1',
  title: 'Loaves',
  code: '// title: Loaves\ndraw()',
  messages: ['the data'],
  withheld: 0,
  status: 'ok',
  detail: '',
};
const path = `/chat/shared/${'ab'.repeat(16)}`;

function share(fetchImpl: FetchLike) {
  return sharePage({ origin: 'http://server.test', artifact, fetchImpl, d3: async () => 'var d3={};' });
}

describe('sharePage', () => {
  it('sends the whole document as JSON and answers with a link', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ path })));

    expect(await share(fetchImpl)).toEqual({ kind: 'shared', url: `http://server.test${path}` });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('http://server.test/chat/shared');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    const sent = JSON.parse(String(init?.body)) as { title: string; page: string };
    expect(sent.title).toBe('Loaves');
    expect(sent.page).toContain('var d3={};');
    expect(sent.page).toContain('the data');
    expect(sent.page).toContain('draw()');
  });

  it('leaves the harness out, as nobody is there to hear it', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ path })));
    await share(fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain('HEARTBEAT_MS');
  });

  it.each([
    [404, 'off'],
    [507, 'full'],
    [413, 'large'],
    [500, 'failed'],
  ])('reads a %i as %s', async (status, kind) => {
    expect((await share(async () => new Response('{}', { status }))).kind).toBe(kind);
  });

  it('takes no link but the kind the server makes', async () => {
    const elsewhere = new Response(JSON.stringify({ path: '//evil.test/chat/shared/x' }));
    expect((await share(async () => elsewhere)).kind).toBe('failed');
  });

  it('says it failed when the server cannot be reached', async () => {
    expect((await share(async () => Promise.reject(new Error('down')))).kind).toBe('failed');
  });
});
