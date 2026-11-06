import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_ROUNDS, WORKSPACE_TOOLS, workspaceAssistant } from '../../src/tools/workspace';
import type { WorkspaceRunner } from '../../src/tools/workspace';
import { runToolCall } from '../../src/tools/tool';

const context = { callId: 'c', messages: [], signal: new AbortController().signal };

function call(name: string, args: unknown) {
  return { id: 'c', name, arguments: JSON.stringify(args) };
}

describe('workspaceAssistant', () => {
  it('offers what the sandbox can do, with room to work', () => {
    const assistant = workspaceAssistant(async () => ({ ok: true, text: '' }));
    expect(assistant.tools.map((tool) => tool.name)).toEqual([...WORKSPACE_TOOLS]);
    expect(assistant.rounds).toBe(WORKSPACE_ROUNDS);
    expect(assistant.system).toContain('no network');
  });

  it('hands a call to the sandbox with its name and arguments', async () => {
    const run = vi.fn<WorkspaceRunner>(async () => ({ ok: true, text: 'out' }));
    const { tools } = workspaceAssistant(run);
    const result = await runToolCall(tools, call('bash', { command: 'ls' }), context);
    expect(result.text).toBe('out');
    expect(run).toHaveBeenCalledWith('bash', { command: 'ls' }, context.signal);
  });

  it('keeps a task list without the sandbox, and refuses a bad one', async () => {
    const run = vi.fn<WorkspaceRunner>();
    const { tools } = workspaceAssistant(run);
    const kept = await runToolCall(tools, call('todo', { items: '[x] a\n[>] b\n[ ] c' }), context);
    expect(kept).toEqual({ ok: true, text: 'Task list kept: 1 of 3 done' });
    expect((await runToolCall(tools, call('todo', { items: 'just words' }), context)).ok).toBe(false);
    expect((await runToolCall(tools, call('todo', {}), context)).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
