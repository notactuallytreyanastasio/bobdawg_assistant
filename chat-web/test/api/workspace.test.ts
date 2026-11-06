import { describe, expect, it, vi } from 'vitest';
import { NO_WORKSPACES, createWorkspace, isWorkspaceId, runInWorkspace } from '../../src/api/workspace';
import type { FetchLike } from '../../src/api/chatClient';

const id = 'ab'.repeat(16);
const signal = new AbortController().signal;

function run(fetchImpl: FetchLike) {
  return runInWorkspace({ origin: 'http://s.test', id, tool: 'bash', args: { command: 'ls' }, signal, fetchImpl });
}

describe('createWorkspace', () => {
  it('asks as JSON and takes only an id of the right shape', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ id })));
    expect(await createWorkspace('http://s.test', fetchImpl)).toBe(id);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://s.test/chat/workspace');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(await createWorkspace('', async () => new Response(JSON.stringify({ id: '../x' })))).toBeNull();
  });

  it('is null on a server without workspaces, or none at all', async () => {
    expect(await createWorkspace('', async () => new Response('', { status: 404 }))).toBeNull();
    expect(await createWorkspace('', async () => Promise.reject(new Error('down')))).toBeNull();
  });
});

describe('runInWorkspace', () => {
  it('sends the call and reads the answer', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ok: true, text: 'hi' })));
    expect(await run(fetchImpl)).toEqual({ ok: true, text: 'hi' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://s.test/chat/workspace/run');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ id, tool: 'bash', args: { command: 'ls' } });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it('trusts nothing about what comes back', async () => {
    for (const body of ['not json', '[]', '{"ok":"yes","text":1}', 'null']) {
      expect((await run(async () => new Response(body))).ok).toBe(false);
    }
  });

  it('says what the server said', async () => {
    expect((await run(async () => new Response('', { status: 404 }))).text).toBe(NO_WORKSPACES);
    expect((await run(async () => new Response('', { status: 429 }))).text).toContain('busy');
    expect((await run(async () => new Response('', { status: 500 }))).text).toContain('500');
  });
});

describe('isWorkspaceId', () => {
  it('knows its own shape', () => {
    expect(isWorkspaceId(id)).toBe(true);
    expect(isWorkspaceId(null)).toBe(false);
    expect(isWorkspaceId('short')).toBe(false);
  });
});
