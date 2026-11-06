import { describe, expect, it } from 'vitest';
import { recordTurn, turnRecordOf } from '../../src/api/recordTurn';
import type { FetchLike } from '../../src/api/chatClient';
import { assistantMessage, userMessage } from '../../src/chat/message';

const first = userMessage('u1', 'why is the sky blue?');
const answered = { ...assistantMessage('a1'), text: 'scattering' };
const second = userMessage('u2', 'and at sunset?');

describe('turnRecordOf', () => {
  it('takes the newest exchange and remembers how the chat opened', () => {
    const cut = { ...assistantMessage('a2'), text: 'red', ending: 'length' as const };
    expect(turnRecordOf('c1', 'Qwen', [first, answered, second, cut], null)).toEqual({
      chat: 'c1',
      model: 'Qwen',
      first: 'why is the sky blue?',
      question: 'and at sunset?',
      answer: 'red',
      ending: 'length',
    });
  });

  it('never carries the thinking', () => {
    const thought = { ...assistantMessage('a1'), text: 'yes', reasoning: 'private working' };
    expect(JSON.stringify(turnRecordOf('c1', 'm', [first, thought], null))).not.toContain('private');
  });

  it('records a failure in the server words, in place of an answer', () => {
    const record = turnRecordOf('c1', 'm', [first], 'model busy');
    expect(record?.ending).toBe('failed');
    expect(record?.answer).toBe('model busy');
  });

  it('records a question stopped before a word arrived', () => {
    const record = turnRecordOf('c1', 'm', [first], null);
    expect(record?.ending).toBe('stopped');
    expect(record?.answer).toBe('');
  });

  it('has nothing to say about an empty transcript', () => {
    expect(turnRecordOf('c1', 'm', [], null)).toBeNull();
  });
});

describe('recordTurn', () => {
  const turn = { chat: 'c1', first: 'q', question: 'q', answer: 'a', ending: '', model: 'm' } as const;
  const replying = (status: number): FetchLike => async () => new Response('{}', { status });

  it('posts the turn as JSON, which is what the server insists on', async () => {
    const seen: { input: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      seen.push({ input: String(input), init });
      return new Response('{}');
    };
    expect(await recordTurn({ origin: '', fetchImpl, turn })).toBe('recorded');
    expect(seen[0]?.input).toBe('/chat/record');
    expect(seen[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(turn);
  });

  it('tells a server that does not record from a record that was lost', async () => {
    expect(await recordTurn({ origin: '', fetchImpl: replying(404), turn })).toBe('off');
    expect(await recordTurn({ origin: '', fetchImpl: replying(503), turn })).toBe('missed');
  });

  it('never throws, because the answer is already on the page', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('connection refused');
    };
    expect(await recordTurn({ origin: '', fetchImpl: down, turn })).toBe('missed');
  });
});
