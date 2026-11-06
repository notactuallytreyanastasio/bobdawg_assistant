// What a workspace turn did, as a list of steps to show. A chart gets a card because it has
// something to open; a step's whole story is what was asked and what came back.

import { WORKSPACE_TOOLS } from '../tools/workspace';
import { toolBlockAfter } from './message';
import type { ChatMessage, ToolCall } from './message';

export type Step = {
  readonly key: string;
  readonly label: string;
  // What the call carried beyond its label: a file's new text, the change an edit makes.
  readonly detail: string;
  readonly output: string;
  // Null while it runs.
  readonly ok: boolean | null;
};

const LABEL_CHARS = 120;
const ROUND_LINE = /^Round \d+ of \d+[^\n]*\n/;

function argsOf(call: ToolCall): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Readonly<Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

function field(args: Readonly<Record<string, unknown>>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > LABEL_CHARS || text.includes('\n') ? `${line.slice(0, LABEL_CHARS)}…` : line;
}

function labelOf(call: ToolCall, args: Readonly<Record<string, unknown>>): string {
  switch (call.name) {
    case 'bash':
      return `$ ${firstLine(field(args, 'command'))}`;
    case 'list':
      return `list ${field(args, 'path') || '.'}`;
    case 'search':
      return `search ${firstLine(field(args, 'query'))}`;
    case 'todo':
      return 'task list';
    default:
      return `${call.name} ${field(args, 'path')}`;
  }
}

function detailOf(call: ToolCall, args: Readonly<Record<string, unknown>>): string {
  switch (call.name) {
    case 'bash':
      return field(args, 'command').includes('\n') ? field(args, 'command') : '';
    case 'write':
      return field(args, 'content');
    case 'todo':
      return field(args, 'items');
    case 'edit': {
      const lines = (mark: string, text: string) => text.split('\n').map((line) => `${mark} ${line}`).join('\n');
      return `${lines('-', field(args, 'old'))}\n${lines('+', field(args, 'new'))}`;
    }
    default:
      return '';
  }
}

export function stepsOf(messages: readonly ChatMessage[], index: number): readonly Step[] {
  const message = messages[index];
  if (message === undefined) return [];
  const calls = message.calls.filter((call) => WORKSPACE_TOOLS.includes(call.name));
  if (calls.length === 0) return [];
  const block = toolBlockAfter(messages, index);
  return calls.map((call): Step => {
    const answer = block.find((entry) => entry.result?.callId === call.id);
    const args = argsOf(call);
    return {
      key: `${message.id}/${call.id}`,
      label: labelOf(call, args),
      detail: detailOf(call, args),
      output: answer?.text.replace(ROUND_LINE, '') ?? '',
      ok: answer?.result?.ok ?? null,
    };
  });
}
