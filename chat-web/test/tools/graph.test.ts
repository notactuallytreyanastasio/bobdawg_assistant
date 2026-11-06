import { describe, expect, it, vi } from 'vitest';
import type { GraphTool } from '../../src/api/graph';
import { GRAPH_RESULT_CHARS, GRAPH_ROUNDS, graphAssistant, withPlace } from '../../src/tools/graph';
import type { GraphRunner } from '../../src/tools/graph';
import { runToolCall } from '../../src/tools/tool';
import type { ToolContext } from '../../src/tools/tool';

const schema = (...names: string[]) => ({ type: 'object', properties: Object.fromEntries(names.map((name) => [name, {}])) });
const tools: readonly GraphTool[] = [
  { name: 'show_node', description: 'read', parameters: schema('node_id', 'workspace') },
  { name: 'delete_node', description: 'write', parameters: schema('node_id', 'workspace', 'branch') },
  { name: 'brand_new_tool', description: 'unknown', parameters: schema() },
];
const context: ToolContext = { callId: 'c', messages: [], signal: new AbortController().signal };
const call = (name: string, args: unknown) => ({ id: 'c', name, arguments: JSON.stringify(args) });

function assistant(yes: boolean, text = 'done') {
  const run = vi.fn<GraphRunner>(async () => ({ ok: true, text }));
  const confirm = vi.fn(async () => yes);
  const onChanged = vi.fn();
  return { run, confirm, onChanged, made: graphAssistant({ tools, run, confirm, onChanged }) };
}

describe('graphAssistant', () => {
  it('offers every tool the server has, with room for its answers', async () => {
    const { made } = assistant(true);
    expect(made.tools.map((tool) => tool.name)).toEqual(['show_node', 'delete_node', 'brand_new_tool']);
    expect(made.rounds).toBe(GRAPH_ROUNDS);
    expect(made.tools[0]?.resultChars).toBe(GRAPH_RESULT_CHARS);
  });

  it('reads without asking', async () => {
    const { made, run, confirm } = assistant(false);
    expect((await runToolCall(made.tools, call('show_node', { node_id: 'a' }), context)).ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('show_node', { node_id: 'a', workspace: 'ds4' }, context.signal);
  });

  it('asks before a write, and tells the page the graph changed', async () => {
    const { made, run, confirm, onChanged } = assistant(true);
    await runToolCall(made.tools, call('delete_node', { node_id: 'a' }), context);
    expect(confirm).toHaveBeenCalledWith({ tool: 'delete_node', args: { node_id: 'a', workspace: 'ds4', branch: 'main' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the reader declines', async () => {
    const { made, run, onChanged } = assistant(false);
    const result = await runToolCall(made.tools, call('delete_node', { node_id: 'a' }), context);
    expect(result).toMatchObject({ ok: false });
    expect(result.text).toContain('declined');
    expect(run).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('treats a tool it has never heard of as a write', async () => {
    const { made, confirm } = assistant(false);
    await runToolCall(made.tools, call('brand_new_tool', {}), context);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('withPlace', () => {
  it('fills in only what a tool takes, and lets the call say otherwise', () => {
    expect(withPlace(tools[2] as GraphTool, {})).toEqual({});
    expect(withPlace(tools[1] as GraphTool, { branch: 'other' })).toEqual({ workspace: 'ds4', branch: 'other' });
  });
});
