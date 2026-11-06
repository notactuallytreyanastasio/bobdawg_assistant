import { describe, expect, it, vi } from 'vitest';
import { callGraphTool, listGraphTools } from '../../src/api/graph';
import type { FetchLike } from '../../src/api/chatClient';

const reply = (status: number, body: unknown): FetchLike => async () =>
  new Response(JSON.stringify(body), { status });

describe('listGraphTools', () => {
  it('reads the server’s list, and drops what has no name', async () => {
    const send = reply(200, { tools: [{ name: 'show_node', description: 'd', inputSchema: { type: 'object' } }, {}] });
    expect(await listGraphTools('', send)).toEqual([
      { name: 'show_node', description: 'd', parameters: { type: 'object' } },
    ]);
  });

  it('answers with nothing when there is no graph', async () => {
    expect(await listGraphTools('', reply(404, {}))).toEqual([]);
    expect(await listGraphTools('', async () => { throw new Error('down'); })).toEqual([]);
  });
});

describe('callGraphTool', () => {
  it('posts the tool and its arguments as JSON', async () => {
    const send = vi.fn<FetchLike>(async () => new Response('{"ok":true,"text":"found"}'));
    expect(await callGraphTool('http://x', 'show_node', { node_id: 'a' }, undefined, send)).toEqual({ ok: true, text: 'found' });
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe('http://x/chat/graph/call');
    expect(init?.body).toBe('{"tool":"show_node","args":{"node_id":"a"}}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('turns a refusal or a failure into an answer', async () => {
    expect(await callGraphTool('', 't', {}, undefined, reply(200, { ok: false, text: 'no such node' }))).toEqual({ ok: false, text: 'no such node' });
    expect(await callGraphTool('', 't', {}, undefined, reply(503, {}))).toEqual({ ok: false, text: 'the server answered 503' });
    expect((await callGraphTool('', 't', {}, undefined, async () => { throw new Error('gone'); })).text).toBe('gone');
  });
});
