// A workspace turn seen as work: what the model thought, and what it changed because of it.
// An edit arrives in the same message as the thinking that led to it, so the link between the
// two is read from the transcript rather than guessed.

import { WORKSPACE_TOOLS } from '../tools/workspace';
import { toolBlockAfter } from './message';
import type { ChatMessage, ToolCall } from './message';

export type DiffLine = {
  readonly kind: 'add' | 'del' | 'same';
  readonly text: string;
};

export type Change = {
  readonly key: string;
  // The message whose thinking led here.
  readonly thought: string;
  readonly path: string;
  // A write carries the whole file, and the old text is not in the call.
  readonly whole: boolean;
  readonly lines: readonly DiffLine[];
  // The model's own last words before making this change.
  readonly why: string;
  // What the reader asked for, which this change is working towards.
  readonly goal: string;
  // Null while it runs.
  readonly ok: boolean | null;
};

export type Thought = {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  // What it went on to do, for a thought that ran tools.
  readonly did: readonly string[];
  readonly changes: readonly string[];
};

export type Work = {
  readonly thoughts: readonly Thought[];
  readonly changes: readonly Change[];
};

export type NoteKind = 'comment' | 'reject';

// Something the reader said about some lines of a change.
export type Note = {
  readonly id: string;
  readonly change: string;
  readonly path: string;
  readonly kind: NoteKind;
  readonly code: string;
  readonly text: string;
  // Lines of the change it hangs from, by index.
  readonly first: number;
  readonly last: number;
};

const TITLE_CHARS = 90;
const WHY_CHARS = 240;

function shorten(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text;
}

function firstSentence(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  const end = line.search(/[.!?](\s|$)/);
  return shorten(end === -1 ? line : line.slice(0, end + 1), TITLE_CHARS);
}

function lastParagraph(text: string): string {
  const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part !== '');
  return shorten((parts.at(-1) ?? '').replace(/\s+/g, ' '), WHY_CHARS);
}

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

// An edit names the text it replaces, which usually repeats lines around the real change.
// Those read better as context than as a line removed and the same line put back.
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const old = before.split('\n');
  const next = after.split('\n');
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  const line = (kind: DiffLine['kind']) => (text: string): DiffLine => ({ kind, text });
  return [
    ...old.slice(0, head).map(line('same')),
    ...old.slice(head, old.length - tail).map(line('del')),
    ...next.slice(head, next.length - tail).map(line('add')),
    ...old.slice(old.length - tail).map(line('same')),
  ];
}

function linesOf(call: ToolCall, args: Readonly<Record<string, unknown>>): readonly DiffLine[] {
  if (call.name === 'edit') return diffLines(field(args, 'old'), field(args, 'new'));
  return field(args, 'content').split('\n').map((text) => ({ kind: 'add', text }));
}

function didOf(call: ToolCall, args: Readonly<Record<string, unknown>>): string {
  if (call.name === 'bash') return `$ ${field(args, 'command').split('\n', 1)[0] ?? ''}`;
  return `${call.name} ${field(args, 'path')}`.trim();
}

export function workOf(messages: readonly ChatMessage[]): Work {
  const thoughts: Thought[] = [];
  const changes: Change[] = [];
  let goal = '';
  messages.forEach((message, index) => {
    if (message.role === 'user') goal = firstSentence(message.text);
    if (message.role !== 'assistant') return;
    const calls = message.calls.filter((call) => WORKSPACE_TOOLS.includes(call.name));
    if (message.reasoning === '' && calls.length === 0) return;
    const block = toolBlockAfter(messages, index);
    const made: string[] = [];
    for (const call of calls) {
      if (call.name !== 'edit' && call.name !== 'write') continue;
      const args = argsOf(call);
      const key = `${message.id}/${call.id}`;
      made.push(key);
      changes.push({
        key,
        thought: message.id,
        path: field(args, 'path'),
        whole: call.name === 'write',
        lines: linesOf(call, args),
        why: lastParagraph(message.reasoning),
        goal,
        ok: block.find((entry) => entry.result?.callId === call.id)?.result?.ok ?? null,
      });
    }
    thoughts.push({
      key: message.id,
      title: firstSentence(message.reasoning) || 'Working',
      text: message.reasoning,
      did: calls.filter((call) => call.name !== 'todo').map((call) => didOf(call, argsOf(call))),
      changes: made,
    });
  });
  return { thoughts, changes };
}

const OPENINGS: Readonly<Record<NoteKind, string>> = {
  comment: 'About this code in',
  reject: 'I reject this code, so revert it, in',
};

// A note is an ordinary message, so the model reacts the way it does to anything else said.
export function noteMessage(note: Pick<Note, 'kind' | 'path' | 'code' | 'text'>): string {
  const quoted = `${OPENINGS[note.kind]} ${note.path}:\n\n\`\`\`\n${note.code}\n\`\`\``;
  return note.text === '' ? quoted : `${quoted}\n\n${note.text}`;
}
