// The decision graph as the page reads it: what came back from the server, made safe to walk.
// A node can have several parents and the edges can loop, so everything here keeps track of
// where it has been.

export type GraphNode = {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly branch: string;
  readonly createdAt: string;
  readonly commit: string;
  readonly files: readonly string[];
};

export type GraphEdge = {
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
};

export type Graph = {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
};

export type GraphIndex = {
  readonly byId: ReadonlyMap<string, GraphNode>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly parents: ReadonlyMap<string, readonly string[]>;
};

export type TreeNode = {
  readonly id: string;
  readonly children: readonly TreeNode[];
};

export type GoalSummary = {
  readonly node: GraphNode;
  // The nodes under it, itself included.
  readonly size: number;
};

export type GraphStats = {
  readonly types: readonly (readonly [string, number])[];
  readonly days: readonly (readonly [string, number])[];
};

// Turns from the chat page sit on a branch of their own, and they are talk rather than work.
export const CHAT_BRANCH = 'chat';

const NODE_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

type Loose = Readonly<Record<string, unknown>>;

function text(from: Loose, name: string): string {
  const value = from[name];
  return typeof value === 'string' ? value : '';
}

function metadataOf(node: Loose): Loose {
  const raw = node['metadata'];
  if (typeof raw === 'object' && raw !== null) return raw as Loose;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Loose) : {};
  } catch {
    return {};
  }
}

function nodeOf(value: unknown): GraphNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const node = value as Loose;
  const id = text(node, 'id');
  if (id === '') return null;
  const metadata = metadataOf(node);
  const files = metadata['files'];
  return {
    id,
    type: text(node, 'node_type') || 'note',
    status: text(node, 'status'),
    title: text(node, 'title') || '(untitled)',
    description: text(node, 'description'),
    prompt: text(metadata, 'prompt'),
    branch: text(node, 'branch'),
    createdAt: text(node, 'created_at'),
    commit: text(metadata, 'commit') || text(node, 'commit'),
    files: Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [],
  };
}

function edgeOf(value: unknown): GraphEdge | null {
  if (typeof value !== 'object' || value === null) return null;
  const edge = value as Loose;
  const from = text(edge, 'from_node_id');
  const to = text(edge, 'to_node_id');
  return from === '' || to === '' ? null : { from, to, rationale: text(edge, 'rationale') };
}

export function parseGraph(raw: string): Graph | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { nodes, edges } = parsed as Loose;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
    return {
      nodes: nodes.flatMap((node) => nodeOf(node) ?? []),
      edges: edges.flatMap((edge) => edgeOf(edge) ?? []),
    };
  } catch {
    return null;
  }
}

export function indexGraph(graph: Graph): GraphIndex {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const add = (held: Map<string, string[]>, key: string, value: string) => {
    held.set(key, [...(held.get(key) ?? []), value]);
  };
  for (const { from, to } of graph.edges) {
    if (!byId.has(from) || !byId.has(to)) continue;
    add(children, from, to);
    add(parents, to, from);
  }
  return { byId, children, parents };
}

// Each node once, under the first parent that reaches it, so a shared node cannot repeat a
// whole branch and a loop cannot go on for ever.
export function treeOf(index: GraphIndex, root: string): TreeNode {
  const seen = new Set([root]);
  const queue: { id: string; kids: TreeNode[] }[] = [];
  const top = { id: root, kids: [] as TreeNode[] };
  queue.push(top);
  for (let at = 0; at < queue.length; at += 1) {
    const current = queue[at];
    if (current === undefined) break;
    for (const child of index.children.get(current.id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const next = { id: child, kids: [] as TreeNode[] };
      current.kids.push({ id: child, children: next.kids });
      queue.push(next);
    }
  }
  return { id: root, children: top.kids };
}

export function sizeOf(tree: TreeNode): number {
  return tree.children.reduce((total, child) => total + sizeOf(child), 1);
}

// The goal a node belongs to: the first goal found walking up, or the top of what it hangs from.
export function rootOf(index: GraphIndex, id: string): string {
  const seen = new Set<string>();
  let current = id;
  let goal: string | null = null;
  while (!seen.has(current)) {
    seen.add(current);
    if (index.byId.get(current)?.type === 'goal') goal = current;
    const up = index.parents.get(current)?.[0];
    if (up === undefined) break;
    current = up;
  }
  return goal ?? current;
}

export function goalsOf(graph: Graph, index: GraphIndex, withChats: boolean): readonly GoalSummary[] {
  return graph.nodes
    .filter((node) => node.type === 'goal' && (withChats || node.branch !== CHAT_BRANCH))
    .filter((node) => (index.parents.get(node.id) ?? []).every((up) => index.byId.get(up)?.type !== 'goal'))
    .map((node) => ({ node, size: sizeOf(treeOf(index, node.id)) }))
    .sort((a, b) => b.node.createdAt.localeCompare(a.node.createdAt));
}

function tally(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

export function statsOf(nodes: readonly GraphNode[]): GraphStats {
  return {
    types: [...tally(nodes.map((node) => node.type))].sort((a, b) => b[1] - a[1]),
    days: [...tally(nodes.map((node) => node.createdAt.slice(0, 10)))].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

export function searchNodes(nodes: readonly GraphNode[], query: string, limit = 40): readonly GraphNode[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [];
  return nodes
    .filter((node) => {
      const haystack = `${node.title} ${node.description} ${node.prompt} ${node.commit}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .slice(0, limit);
}

// The nodes an answer names, in the order it names them.
export function nodeIdsIn(answer: string, index: GraphIndex): readonly string[] {
  return [...new Set(answer.match(NODE_ID) ?? [])].filter((id) => index.byId.has(id));
}
