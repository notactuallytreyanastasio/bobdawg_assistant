import { describe, expect, it } from 'vitest';
import { assistantMessage, toolMessage, userMessage } from '../../src/chat/message';
import type { ChatMessage } from '../../src/chat/message';
import { diffLines, noteMessage, workOf } from '../../src/chat/work';

function calling(id: string, reasoning: string, name: string, args: unknown): ChatMessage {
  return { ...assistantMessage(id), reasoning, calls: [{ id: `c-${id}`, name, arguments: JSON.stringify(args) }] };
}

describe('diffLines', () => {
  it('keeps the lines an edit repeats as context', () => {
    expect(diffLines('a\nold\nz', 'a\nnew\nmore\nz')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'add', text: 'more' },
      { kind: 'same', text: 'z' },
    ]);
  });

  it('does not count a repeated line twice', () => {
    expect(diffLines('x\nx', 'x')).toEqual([
      { kind: 'same', text: 'x' },
      { kind: 'del', text: 'x' },
    ]);
  });
});

describe('workOf', () => {
  it('ties a change to the thinking in its own message', () => {
    const messages = [
      userMessage('u1', 'Fix the cache. It evicts wrongly.'),
      calling('a1', 'Reading first.\n\nThe pop takes the newest key.', 'edit', { path: 'c.py', old: 'pop()', new: 'pop(0)' }),
      toolMessage('t1', 'c-a1', true, 'Round 1 of 40.\nedited'),
    ];
    const { thoughts, changes } = workOf(messages);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({ key: 'a1', title: 'Reading first.', changes: ['a1/c-a1'] });
    expect(changes[0]).toMatchObject({
      thought: 'a1',
      path: 'c.py',
      whole: false,
      why: 'The pop takes the newest key.',
      goal: 'Fix the cache.',
      ok: true,
    });
  });

  it('shows a written file as all new, and running until its result comes', () => {
    const { changes } = workOf([calling('a1', 'Writing it.', 'write', { path: 'n.py', content: 'one\ntwo' })]);
    expect(changes[0]).toMatchObject({ whole: true, ok: null });
    expect(changes[0]?.lines.map((line) => line.kind)).toEqual(['add', 'add']);
  });

  it('lists what a thought did, but no change for a command', () => {
    const { thoughts, changes } = workOf([calling('a1', 'Run it.', 'bash', { command: 'make test\nmake' })]);
    expect(thoughts[0]?.did).toEqual(['$ make test']);
    expect(changes).toEqual([]);
  });

  it('skips plain answers with no thinking, and survives broken arguments', () => {
    const broken = { ...assistantMessage('a2'), calls: [{ id: 'c', name: 'edit', arguments: '{' }] };
    const { thoughts, changes } = workOf([assistantMessage('a1'), broken]);
    expect(thoughts.map((thought) => thought.key)).toEqual(['a2']);
    expect(changes[0]).toMatchObject({ path: '' });
  });
});

describe('noteMessage', () => {
  it('quotes the code, so the model knows what is meant', () => {
    expect(noteMessage({ kind: 'comment', path: 'c.py', code: 'x = 1', text: 'Why one?' })).toBe(
      'A comment on this code in c.py:\n\n```\nx = 1\n```\n\nWhy one?',
    );
  });

  it('asks for a revert, with or without a reason', () => {
    expect(noteMessage({ kind: 'reject', path: 'c.py', code: 'x', text: '' })).toBe(
      'I reject this code, so revert it, in c.py:\n\n```\nx\n```',
    );
  });
});
