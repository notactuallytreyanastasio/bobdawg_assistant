import { describe, expect, it } from 'vitest';
import { stepsOf } from '../../src/chat/steps';
import { assistantMessage, toolMessage } from '../../src/chat/message';
import type { ChatMessage } from '../../src/chat/message';

function calling(name: string, args: unknown): ChatMessage {
  return { ...assistantMessage('a1'), calls: [{ id: 'c1', name, arguments: JSON.stringify(args) }] };
}

describe('stepsOf', () => {
  it('shows a command and what it printed, without the round line', () => {
    const messages = [calling('bash', { command: 'ls -la' }), toolMessage('t1', 'c1', true, 'Round 2 of 40.\na.txt')];
    expect(stepsOf(messages, 0)).toEqual([
      { key: 'a1/c1', label: '$ ls -la', detail: '', output: 'a.txt', ok: true },
    ]);
  });

  it('is running until the result comes', () => {
    expect(stepsOf([calling('read', { path: 'a.c' })], 0)[0]).toMatchObject({ label: 'read a.c', ok: null });
  });

  it('marks a failure', () => {
    const messages = [calling('bash', { command: 'false' }), toolMessage('t1', 'c1', false, '[exit 1]')];
    expect(stepsOf(messages, 0)[0]?.ok).toBe(false);
  });

  it('shows what a change carries', () => {
    expect(stepsOf([calling('write', { path: 'a', content: 'body' })], 0)[0]?.detail).toBe('body');
    expect(stepsOf([calling('edit', { path: 'a', old: 'x', new: 'y' })], 0)[0]?.detail).toBe('- x\n+ y');
    expect(stepsOf([calling('todo', { items: '[ ] a' })], 0)[0]).toMatchObject({ label: 'task list', detail: '[ ] a' });
  });

  it('cuts a long command to one line and keeps the whole of it below', () => {
    const step = stepsOf([calling('bash', { command: 'one\ntwo' })], 0)[0];
    expect(step?.label).toBe('$ one…');
    expect(step?.detail).toBe('one\ntwo');
  });

  it('leaves charts to their cards, and survives bad arguments', () => {
    expect(stepsOf([calling('plot', { code: 'x' })], 0)).toEqual([]);
    const bad = { ...assistantMessage('a1'), calls: [{ id: 'c', name: 'bash', arguments: 'not json' }] };
    expect(stepsOf([bad], 0)[0]?.label).toBe('$ ');
    expect(stepsOf([], 0)).toEqual([]);
  });
});
