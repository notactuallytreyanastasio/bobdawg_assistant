import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  idSequence,
  toWireMessages,
  userMessage, toolMessage } from '../../src/chat/message';

describe('idSequence', () => {
  it('numbers every id behind a prefix, so the same input gives the same ids', () => {
    const userIds = idSequence('u');
    const assistantIds = idSequence('a');
    expect(userIds()).toBe('u1');
    expect(userIds()).toBe('u2');
    expect(assistantIds()).toBe('a1');
    expect(userIds()).toBe('u3');
  });
});

describe('userMessage', () => {
  it('carries the typed text and no reasoning of its own', () => {
    const message = userMessage('u1', 'hello there');
    expect(message).toEqual({
      id: 'u1',
      role: 'user',
      text: 'hello there',
      reasoning: '',
      ending: null,
      stats: null,
      calls: [],
      result: null,
      plot: false,
    });
  });
});

describe('assistantMessage', () => {
  it('starts as an empty placeholder that streaming fills in', () => {
    const message = assistantMessage('a1');
    expect(message).toEqual({
      id: 'a1',
      role: 'assistant',
      text: '',
      reasoning: '',
      ending: null,
      stats: null,
      calls: [],
      result: null,
      plot: false,
    });
  });
});

describe('toWireMessages', () => {
  it('sends role and content only, in order, with reasoning left behind', () => {
    const messages = [
      { ...userMessage('u1', 'question'), reasoning: 'not sent' },
      { ...assistantMessage('a1'), text: 'answer', reasoning: 'hidden thought' },
      userMessage('u2', 'follow up'),
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'follow up' },
    ]);
  });

  it('drops an assistant message that never received any text', () => {
    const messages = [
      userMessage('u1', 'question'),
      assistantMessage('a1'),
      { ...assistantMessage('a2'), text: 'thought only', reasoning: 'why' },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'thought only' },
    ]);
  });

  it('leaves nothing behind for an empty transcript', () => {
    expect(toWireMessages([])).toEqual([]);
  });
});

describe('tool messages on the wire', () => {
  const call = { id: 'c1', name: 'plot', arguments: '{"code":  "x"}' };
  const asked = userMessage('u1', 'chart this');
  const calling = { ...assistantMessage('a1'), calls: [call] };
  const answered = toolMessage('t1', 'c1', true, 'ok: drew 1 svg');

  it('replays a call and its result byte for byte', () => {
    expect(toWireMessages([asked, calling, answered])).toEqual([
      { role: 'user', content: 'chart this' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'plot', arguments: '{"code":  "x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok: drew 1 svg' },
    ]);
  });

  it('keeps the words said beside a call', () => {
    const wire = toWireMessages([asked, { ...calling, text: 'Drawing it.' }, answered]);
    expect(wire[1]).toMatchObject({ role: 'assistant', content: 'Drawing it.' });
  });

  it('drops a call that has no result, and the empty message around it', () => {
    expect(toWireMessages([asked, calling])).toEqual([{ role: 'user', content: 'chart this' }]);
  });

  it('keeps the words of a message whose call was dropped', () => {
    expect(toWireMessages([asked, { ...calling, text: 'Drawing it.' }])).toEqual([
      { role: 'user', content: 'chart this' },
      { role: 'assistant', content: 'Drawing it.' },
    ]);
  });

  it('drops a result with no call in front of it', () => {
    expect(toWireMessages([asked, answered])).toEqual([{ role: 'user', content: 'chart this' }]);
  });

  it('keeps only the complete pair when one of two calls went unanswered', () => {
    const second = { id: 'c2', name: 'plot', arguments: '{}' };
    const wire = toWireMessages([asked, { ...calling, calls: [call, second] }, answered]);
    expect(wire).toHaveLength(3);
    expect(wire[1]).toMatchObject({ tool_calls: [{ id: 'c1' }] });
  });

  it('pairs inside the block after each call, so a server reusing an id cannot cross turns', () => {
    const later = toolMessage('t2', 'c1', false, 'error');
    const wire = toWireMessages([asked, calling, answered, userMessage('u2', 'again'), calling, later]);
    expect(wire.filter((message) => message.role === 'tool').map((message) => message.content)).toEqual([
      'ok: drew 1 svg',
      'error',
    ]);
  });

  it('does not let one result answer the same id twice', () => {
    const repeat = toolMessage('t2', 'c1', false, 'again');
    const wire = toWireMessages([asked, calling, answered, repeat]);
    expect(wire.filter((message) => message.role === 'tool')).toHaveLength(1);
  });

  it('never carries reasoning', () => {
    const wire = toWireMessages([asked, { ...calling, reasoning: 'hmm' }, answered]);
    expect(JSON.stringify(wire)).not.toContain('hmm');
  });

  it('runs a question sent with Plot on through the clip, and no other', () => {
    const plain = userMessage('u0', 'plain');
    const wire = toWireMessages([plain, { ...asked, plot: true }], () => 'clipped');
    expect(wire.map((message) => message.content)).toEqual(['plain', 'clipped']);
  });
});

describe('a new message', () => {
  it('starts with no calls, no result and Plot off', () => {
    expect(userMessage('u1', 'x')).toMatchObject({ calls: [], result: null, plot: false });
    expect(assistantMessage('a1')).toMatchObject({ calls: [], result: null, plot: false });
  });

  it('can say it was sent with Plot on', () => {
    expect(userMessage('u1', 'x', true).plot).toBe(true);
  });
});
