import { describe, expect, it } from 'vitest';
import { goalsOf, indexGraph, nodeIdsIn, parseGraph, rootOf, searchNodes, sizeOf, statsOf, treeOf } from '../../src/graph/model';
import type { Graph } from '../../src/graph/model';

const raw = (id: string, node_type: string, extra: object = {}) => ({
  id, node_type, title: `t-${id}`, status: 'completed', created_at: '2026-11-05T01:00:00Z', branch: 'main', ...extra,
});
const edge = (from_node_id: string, to_node_id: string) => ({ from_node_id, to_node_id, rationale: 'because' });

function graphOf(nodes: readonly unknown[], edges: readonly unknown[]): Graph {
  const parsed = parseGraph(JSON.stringify({ nodes, edges }));
  if (parsed === null) throw new Error('did not parse');
  return parsed;
}

describe('parseGraph', () => {
  it('reads metadata as an object or as a string', () => {
    const graph = graphOf(
      [raw('a', 'goal', { metadata: { prompt: 'do it', commit: 'abc', files: ['x.c', 3] } }), raw('b', 'action', { metadata: '{"prompt":"p"}' })],
      [edge('a', 'b')],
    );
    expect(graph.nodes[0]).toMatchObject({ prompt: 'do it', commit: 'abc', files: ['x.c'] });
    expect(graph.nodes[1]?.prompt).toBe('p');
    expect(graph.edges).toEqual([{ from: 'a', to: 'b', rationale: 'because' }]);
  });

  it('refuses what is not a graph, and skips what is not a node', () => {
    expect(parseGraph('nope')).toBeNull();
    expect(parseGraph('{"nodes":1}')).toBeNull();
    expect(graphOf([{}, raw('a', 'goal')], [{}]).nodes).toHaveLength(1);
  });
});

describe('walking', () => {
  it('visits a shared node once, and survives a loop', () => {
    const graph = graphOf([raw('a', 'goal'), raw('b', 'action'), raw('c', 'action'), raw('d', 'outcome')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'a')]);
    const index = indexGraph(graph);
    expect(sizeOf(treeOf(index, 'a'))).toBe(4);
    expect(rootOf(index, 'd')).toBe('a');
  });

  it('ignores edges to nodes it does not have', () => {
    const index = indexGraph(graphOf([raw('a', 'goal')], [edge('a', 'gone')]));
    expect(treeOf(index, 'a').children).toEqual([]);
  });

  it('finds the top goal, or the top of an orphan branch', () => {
    const index = indexGraph(graphOf([raw('a', 'goal'), raw('b', 'goal'), raw('c', 'action'), raw('d', 'action'), raw('e', 'outcome')],
      [edge('a', 'b'), edge('b', 'c'), edge('d', 'e')]));
    expect(rootOf(index, 'c')).toBe('a');
    expect(rootOf(index, 'e')).toBe('d');
  });
});

describe('goalsOf', () => {
  const graph = graphOf(
    [raw('a', 'goal', { created_at: '2026-11-01T00:00:00Z' }), raw('b', 'goal', { created_at: '2026-11-03T00:00:00Z' }), raw('c', 'goal', { branch: 'chat' }), raw('d', 'goal'), raw('e', 'action')],
    [edge('a', 'e'), edge('a', 'd')],
  );
  const index = indexGraph(graph);

  it('lists top goals, newest first, with their size, and leaves out chats', () => {
    expect(goalsOf(graph, index, false).map((goal) => [goal.node.id, goal.size])).toEqual([['b', 1], ['a', 3]]);
  });

  it('brings chats in when asked', () => {
    expect(goalsOf(graph, index, true).map((goal) => goal.node.id)).toContain('c');
  });
});

describe('statsOf and searchNodes', () => {
  const graph = graphOf([raw('a', 'goal', { description: 'Tokenizer fix' }), raw('b', 'action'), raw('c', 'action', { created_at: '2026-11-06T00:00:00Z' })], []);

  it('counts kinds, most first, and days in order', () => {
    const stats = statsOf(graph.nodes);
    expect(stats.types).toEqual([['action', 2], ['goal', 1]]);
    expect(stats.days).toEqual([['2026-11-05', 2], ['2026-11-06', 1]]);
  });

  it('wants every word, in any case, and nothing for no words', () => {
    expect(searchNodes(graph.nodes, 'TOKENIZER t-a').map((node) => node.id)).toEqual(['a']);
    expect(searchNodes(graph.nodes, 'tokenizer missing')).toEqual([]);
    expect(searchNodes(graph.nodes, '  ')).toEqual([]);
  });
});

describe('nodeIdsIn', () => {
  it('finds the ids this graph holds, once each', () => {
    const id = '133de76d-6417-4be0-8127-14305f360677';
    const other = '00000000-0000-4000-8000-000000000000';
    const index = indexGraph(graphOf([raw(id, 'goal')], []));
    expect(nodeIdsIn(`see ${id}, ${id} and ${other}`, index)).toEqual([id]);
  });
});
