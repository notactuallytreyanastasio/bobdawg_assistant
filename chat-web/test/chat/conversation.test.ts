import { describe, expect, it } from 'vitest';
import {
  canRetry,
  canSend,
  emptyConversation,
  reduceConversation,
} from '../../src/chat/conversation';
import { assistantMessage, userMessage } from '../../src/chat/message';
import type { Conversation } from '../../src/chat/conversation';

const sent = {
  type: 'send',
  userId: 'u1',
  assistantId: 'a1',
  text: 'Explain Redis streams.',
} as const;

function send(): Conversation {
  return reduceConversation(emptyConversation, sent);
}

function streaming(): Conversation {
  return reduceConversation(send(), {
    type: 'delta',
    channel: 'content',
    text: 'A stream ',
  });
}

describe('reduceConversation on send', () => {
  it('adds the question and an empty answer, and marks the turn as streaming', () => {
    const state = send();
    expect(state.streaming).toBe(true);
    expect(state.error).toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual(userMessage('u1', 'Explain Redis streams.'));
    expect(state.messages[1]).toEqual(assistantMessage('a1'));
  });

  it('clears an earlier failure when a new turn starts', () => {
    const failed = reduceConversation(emptyConversation, { type: 'fail', text: 'boom' });
    expect(reduceConversation(failed, sent).error).toBeNull();
  });
});

describe('reduceConversation on delta', () => {
  it('appends content to the streaming answer', () => {
    const state = reduceConversation(streaming(), {
      type: 'delta',
      channel: 'content',
      text: 'is a log.',
    });
    expect(state.messages[1]?.text).toBe('A stream is a log.');
    expect(state.messages[1]?.reasoning).toBe('');
  });

  it('keeps the reasoning channel beside the answer instead of inside it', () => {
    const withReasoning = reduceConversation(send(), {
      type: 'delta',
      channel: 'reasoning',
      text: 'check the docs',
    });
    const state = reduceConversation(withReasoning, {
      type: 'delta',
      channel: 'content',
      text: 'Here is the short answer.',
    });
    expect(state.messages[1]?.reasoning).toBe('check the docs');
    expect(state.messages[1]?.text).toBe('Here is the short answer.');
  });

  it('ignores a delta once the turn has ended', () => {
    const ended = reduceConversation(streaming(), { type: 'end' });
    const state = reduceConversation(ended, { type: 'delta', channel: 'content', text: 'late' });
    expect(state.messages[1]?.text).toBe('A stream ');
    expect(state.messages).toBe(ended.messages);
  });

  it('ignores a delta that arrives with no assistant message to fill', () => {
    const state = reduceConversation(emptyConversation, {
      type: 'delta',
      channel: 'content',
      text: 'orphan',
    });
    expect(state.messages).toHaveLength(0);
  });

  it('ignores a delta when the newest message is the user speaking', () => {
    const asked: Conversation = {
      messages: [userMessage('u1', 'question')],
      streaming: true,
      error: null,
    };
    const state = reduceConversation(asked, { type: 'delta', channel: 'content', text: 'orphan' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.text).toBe('question');
  });
});

describe('reduceConversation on end, fail and reset', () => {
  it('stops streaming without changing what was written', () => {
    const state = reduceConversation(streaming(), { type: 'end' });
    expect(state.streaming).toBe(false);
    expect(state.messages[1]?.text).toBe('A stream ');
  });

  it('stops streaming and reports the failure', () => {
    const state = reduceConversation(streaming(), { type: 'fail', text: 'no model' });
    expect(state.streaming).toBe(false);
    expect(state.error).toBe('no model');
  });

  it('drops the answer placeholder when nothing arrived', () => {
    const state = reduceConversation(send(), { type: 'fail', text: 'no model' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe('user');
  });

  it('keeps a partial answer when the stream died mid-sentence', () => {
    const state = reduceConversation(streaming(), { type: 'fail', text: 'closed' });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.text).toBe('A stream ');
  });

  it('clears the transcript on reset', () => {
    const state = reduceConversation(streaming(), { type: 'reset' });
    expect(state.messages).toHaveLength(0);
    expect(state.streaming).toBe(false);
    expect(state.error).toBeNull();
  });
});

describe('canSend', () => {
  it('is true while nothing is in flight and there is something asked', () => {
    expect(canSend(emptyConversation, 'What is a redlock?')).toBe(true);
  });

  it('is false while an answer is arriving', () => {
    expect(canSend(send(), 'next')).toBe(false);
  });

  it('is false for a question with nothing in it', () => {
    expect(canSend(emptyConversation, '')).toBe(false);
    expect(canSend(emptyConversation, '   ')).toBe(false);
  });
});

describe('how a turn ends', () => {
  const stats = { outputTokens: 3, contextTokens: 9, tokensPerSecond: 2, thoughtMs: null };

  it('keeps the ending and the numbers on the answer', () => {
    const ended = reduceConversation(streaming(), { type: 'end', ending: 'length', stats });
    expect(ended.messages.at(-1)?.ending).toBe('length');
    expect(ended.messages.at(-1)?.stats).toEqual(stats);
    expect(ended.streaming).toBe(false);
  });

  it('marks a stopped answer and keeps its words', () => {
    const ended = reduceConversation(streaming(), { type: 'end', ending: 'stopped' });
    expect(ended.messages.at(-1)?.ending).toBe('stopped');
    expect(ended.messages.at(-1)?.text).toBe('A stream ');
  });

  it('leaves no empty answer behind when stopped before a word arrived', () => {
    const ended = reduceConversation(send(), { type: 'end', ending: 'stopped' });
    expect(ended.messages.map((message) => message.role)).toEqual(['user']);
  });
});

describe('retry', () => {
  const finished = () => reduceConversation(streaming(), { type: 'end' });

  it('replaces the last answer and keeps the question', () => {
    const again = reduceConversation(finished(), { type: 'retry', assistantId: 'a2' });
    expect(again.messages.map((message) => message.id)).toEqual(['u1', 'a2']);
    expect(again.messages.at(-1)?.text).toBe('');
    expect(again.streaming).toBe(true);
  });

  it('answers a question whose answer failed, clearing the failure', () => {
    const failed = reduceConversation(send(), { type: 'fail', text: 'no' });
    const again = reduceConversation(failed, { type: 'retry', assistantId: 'a2' });
    expect(again.messages.map((message) => message.id)).toEqual(['u1', 'a2']);
    expect(again.error).toBeNull();
  });

  it('does nothing mid-turn or with no question', () => {
    expect(canRetry(streaming())).toBe(false);
    expect(canRetry(emptyConversation)).toBe(false);
    const turn = streaming();
    expect(reduceConversation(turn, { type: 'retry', assistantId: 'a2' })).toBe(turn);
  });
});

describe('load', () => {
  it('takes over the transcript and forgets the failure', () => {
    const failed = reduceConversation(send(), { type: 'fail', text: 'no' });
    const loaded = reduceConversation(failed, { type: 'load', messages: [userMessage('u9', 'old')] });
    expect(loaded).toEqual({ messages: [userMessage('u9', 'old')], streaming: false, error: null });
  });
});
