import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  idSequence,
  toWireMessages,
  userMessage,
} from '../../src/chat/message';

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
