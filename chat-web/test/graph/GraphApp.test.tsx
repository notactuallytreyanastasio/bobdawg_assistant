import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { FetchLike } from '../../src/api/chatClient';
import { GraphApp } from '../../src/graph/GraphApp';

const graph = {
  nodes: [
    { id: 'g1', node_type: 'goal', title: 'Fix the tool calls', status: 'active', created_at: '2026-11-06T01:00:00Z', branch: 'main', metadata: { prompt: 'make it work' } },
    { id: 'a1', node_type: 'action', title: 'Render the prompt', status: 'completed', created_at: '2026-11-06T02:00:00Z', branch: 'main', metadata: { commit: '029d900' } },
    { id: 'c1', node_type: 'goal', title: 'A chat turn', status: 'active', created_at: '2026-11-06T03:00:00Z', branch: 'chat' },
  ],
  edges: [{ from_node_id: 'g1', to_node_id: 'a1' }],
};

function server(answer: { ok: boolean; text: string } = { ok: true, text: JSON.stringify(graph) }): FetchLike {
  return vi.fn<FetchLike>(async (url) => {
    const path = String(url);
    if (path.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'm', name: 'Qwen' }] }));
    if (path.endsWith('/chat/graph/tools')) return new Response(JSON.stringify({ tools: [] }));
    return new Response(JSON.stringify(answer));
  });
}

describe('GraphApp', () => {
  it('shows the goals of the work, leaving chat turns until asked', async () => {
    render(<GraphApp origin="" fetchImpl={server()} />);
    await screen.findByRole('button', { name: /Fix the tool calls.*2 nodes/ });
    expect(screen.queryByRole('button', { name: /A chat turn/ })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include chat turns' }));
    expect((await screen.findAllByRole('button', { name: /A chat turn/ })).length).toBeGreaterThan(0);
  });

  it('opens a goal into its tree, and reads a node from it', async () => {
    render(<GraphApp origin="" fetchImpl={server()} />);
    await userEvent.click(await screen.findByRole('button', { name: /Fix the tool calls.*2 nodes/ }));
    expect((await screen.findByRole('heading', { name: 'Fix the tool calls' })).textContent).toContain('Fix');
    expect(screen.getByText('make it work').textContent).toBe('make it work');
    await userEvent.click(screen.getByRole('button', { name: /^action\s*Render the prompt/ }));
    expect((await screen.findByText('029d900')).textContent).toBe('029d900');
  });

  it('searches every node, and jumps to what it finds', async () => {
    render(<GraphApp origin="" fetchImpl={server()} />);
    await screen.findByRole('button', { name: /Fix the tool calls.*2 nodes/ });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the graph' }), 'render');
    await userEvent.click(await screen.findByRole('button', { name: /^Render the prompt/ }));
    expect((await screen.findByRole('heading', { name: 'Render the prompt' })).textContent).toContain('Render');
  });

  it('says what went wrong when there is no graph', async () => {
    render(<GraphApp origin="" fetchImpl={server({ ok: false, text: 'the deciduous server is down' })} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('down'));
  });
});
