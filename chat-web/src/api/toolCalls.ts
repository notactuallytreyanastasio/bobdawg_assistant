// Tool calls as the stream delivers them. A call can arrive whole or as fragments of its
// arguments, with its id and name only on the first, so they gather by index until the
// stream ends. What comes in here is the server's JSON, so nothing about it is assumed.

import type { ToolCall } from '../chat/message';

type Gathering = {
  id: string;
  name: string;
  arguments: string;
};

export type CallCollector = {
  readonly push: (fragments: unknown) => void;
  readonly calls: () => readonly ToolCall[];
};

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createCallCollector(nextId: () => string): CallCollector {
  const gathered = new Map<number, Gathering>();

  function take(fragment: unknown, position: number): void {
    if (typeof fragment !== 'object' || fragment === null) return;
    const { index, id, function: called } = fragment as {
      readonly index?: unknown;
      readonly id?: unknown;
      readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
    };
    if (index !== undefined && typeof index !== 'number') return;
    const slot = index ?? position;
    const call = gathered.get(slot) ?? { id: '', name: '', arguments: '' };
    gathered.set(slot, call);
    if (call.id === '') call.id = stringOf(id);
    if (call.name === '') call.name = stringOf(called?.name);
    call.arguments += stringOf(called?.arguments);
  }

  return {
    push(fragments) {
      if (!Array.isArray(fragments)) return;
      (fragments as readonly unknown[]).forEach(take);
    },
    calls() {
      return [...gathered.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          // The result has to name its call, so a server that sent no id still needs one,
          // and the same one however often the list is read.
          if (call.id === '') call.id = nextId();
          return { ...call };
        });
    },
  };
}
