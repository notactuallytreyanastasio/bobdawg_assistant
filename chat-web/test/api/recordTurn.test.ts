import { describe, expect, it } from 'vitest';
import { recordTurn, turnRecordOf } from '../../src/api/recordTurn';
import type { FetchLike } from '../../src/api/chatClient';
import { assistantMessage, toolMessage, userMessage } from '../../src/chat/message';

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

describe('a turn with tool calls', () => {
  const asked = userMessage('u1', 'chart this', true);
  const code = '// title: Loaves\ndraw()';
  const calling = {
    ...assistantMessage('a1'),
    calls: [{ id: 'c1', name: 'plot', arguments: JSON.stringify({ code }) }],
  };
  const drew = toolMessage('t1', 'c1', true, 'ok: drew 1 svg');

  it('takes the newest words the model said', () => {
    const closing = { ...assistantMessage('a2'), text: 'Saturdays lead.' };
    const record = turnRecordOf('c1', 'm', [asked, calling, drew, closing], null);
    expect(record).toMatchObject({ answer: 'Saturdays lead.', ending: '' });
  });

  it('names the chart when the model said nothing', () => {
    const record = turnRecordOf('c1', 'm', [asked, calling, drew], null);
    expect(record).toMatchObject({ answer: 'Drew: Loaves', ending: '' });
  });

  it('never records the code', () => {
    const record = turnRecordOf('c1', 'm', [asked, calling, drew], null);
    expect(JSON.stringify(record)).not.toContain('draw()');
  });

  it('records giving up as a failure', () => {
    const gaveup = { ...calling, ending: 'gaveup' as const };
    const failed = toolMessage('t1', 'c1', false, 'error');
    expect(turnRecordOf('c1', 'm', [asked, gaveup, failed], null)?.ending).toBe('failed');
  });

  it('records running out of rounds as a failure, and not the words before the last call', () => {
    const capped = { ...calling, text: 'Let me re-test', ending: 'capped' as const };
    const record = turnRecordOf('c1', 'm', [asked, capped, drew], null);
    expect(record).toMatchObject({ answer: 'Ran out of rounds. Drew: Loaves', ending: 'failed' });
  });

  it('records a stop after the chart as a stop', () => {
    const stopped = { ...calling, ending: 'stopped' as const };
    const declined = toolMessage('t1', 'c1', false, 'stopped by the reader');
    expect(turnRecordOf('c1', 'm', [asked, stopped, declined], null)).toMatchObject({ answer: '', ending: 'stopped' });
  });

  it('does not borrow words from an earlier turn', () => {
    const earlier = { ...assistantMessage('a0'), text: 'old words' };
    const record = turnRecordOf('c1', 'm', [first, earlier, asked, calling, drew], null);
    expect(record?.answer).toBe('Drew: Loaves');
  });
});
