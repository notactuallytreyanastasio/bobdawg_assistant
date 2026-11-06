// One conversation as data plus the events that change it. The reducer is the
// only place that decides what a delta, a finished turn or a failure does to the
// transcript, so the components below it stay presentational.

import { assistantMessage, toolMessage, userMessage } from './message';
import type { ChatMessage, Ending, ToolCall, TurnStats } from './message';

export type Conversation = {
  readonly messages: readonly ChatMessage[];
  readonly streaming: boolean;
  readonly error: string | null;
};

export type DeltaChannel = 'content' | 'reasoning';

export type ConversationEvent =
  | {
      readonly type: 'send';
      readonly userId: string;
      readonly assistantId: string;
      readonly text: string;
      readonly plot?: boolean;
    }
  | { readonly type: 'delta'; readonly channel: DeltaChannel; readonly text: string }
  | {
      readonly type: 'end';
      readonly ending?: Ending | null;
      readonly stats?: TurnStats | null;
      // A banner to raise as the turn ends, for an ending worse than the word beside it.
      readonly error?: string;
    }
  | { readonly type: 'calls'; readonly calls: readonly ToolCall[] }
  | {
      readonly type: 'result';
      readonly id: string;
      readonly callId: string;
      readonly ok: boolean;
      readonly text: string;
    }
  | { readonly type: 'next'; readonly assistantId: string }
  | { readonly type: 'fail'; readonly text: string }
  | { readonly type: 'retry'; readonly assistantId: string; readonly plot?: boolean }
  | { readonly type: 'load'; readonly messages: readonly ChatMessage[] }
  | { readonly type: 'reset' };

export const emptyConversation: Conversation = {
  messages: [],
  streaming: false,
  error: null,
};

// One rule for whether a question may go out: nothing already in flight, and something
// actually asked. Both halves are here so the composer and the turn loop agree.
export function canSend(conversation: Conversation, text: string): boolean {
  return !conversation.streaming && text.trim() !== '';
}

// A question can be asked again once nothing is in flight, as long as there is one.
export function canRetry(conversation: Conversation): boolean {
  return !conversation.streaming && conversation.messages.some((message) => message.role === 'user');
}

function newestAnswerIndex(messages: readonly ChatMessage[]): number {
  return messages.findLastIndex((message) => message.role === 'assistant');
}

function isEmptyAnswer(message: ChatMessage): boolean {
  return message.text === '' && message.reasoning === '' && message.calls.length === 0;
}

// A turn can end on a tool message, so the answer to mark is the newest one rather than
// the last entry.
function endTurn(
  conversation: Conversation,
  ending: Ending | null,
  stats: TurnStats | null,
  error: string | null,
): Conversation {
  const settled = { ...conversation, streaming: false, error };
  const index = newestAnswerIndex(conversation.messages);
  const target = conversation.messages[index];
  if (target === undefined) return settled;
  const messages = [...conversation.messages];
  if (ending === 'stopped' && isEmptyAnswer(target)) {
    // Stopped before a word arrived: there is no answer to mark. The round before it may
    // still hold one, and that is the turn the reader stopped.
    messages.splice(index, 1);
    const earlier = messages[index - 1]?.role === 'tool' ? newestAnswerIndex(messages) : -1;
    const previous = messages[earlier];
    if (previous !== undefined) messages[earlier] = { ...previous, ending, stats };
    return { ...settled, messages };
  }
  messages[index] = { ...target, ending, stats };
  return { ...settled, messages };
}

export function reduceConversation(
  conversation: Conversation,
  event: ConversationEvent,
): Conversation {
  switch (event.type) {
    case 'send':
      return {
        messages: [
          ...conversation.messages,
          userMessage(event.userId, event.text, event.plot ?? false),
          assistantMessage(event.assistantId),
        ],
        streaming: true,
        // A new turn is a fresh start for whatever failed before it.
        error: null,
      };
    case 'delta': {
      const index = conversation.messages.length - 1;
      const target = conversation.messages[index];
      if (!conversation.streaming || target === undefined || target.role !== 'assistant') {
        return conversation;
      }
      const filled: ChatMessage =
        event.channel === 'content'
          ? { ...target, text: target.text + event.text }
          : { ...target, reasoning: target.reasoning + event.text };
      const messages = conversation.messages.slice(0, index);
      messages.push(filled);
      return { ...conversation, messages };
    }
    case 'end':
      return conversation.streaming
        ? endTurn(conversation, event.ending ?? null, event.stats ?? null, event.error ?? conversation.error)
        : conversation;
    case 'calls': {
      const index = conversation.messages.length - 1;
      const target = conversation.messages[index];
      if (!conversation.streaming || target === undefined || target.role !== 'assistant') {
        return conversation;
      }
      const messages = conversation.messages.slice(0, index);
      messages.push({ ...target, calls: event.calls });
      return { ...conversation, messages };
    }
    case 'result':
      if (!conversation.streaming) return conversation;
      return {
        ...conversation,
        messages: [...conversation.messages, toolMessage(event.id, event.callId, event.ok, event.text)],
      };
    case 'next':
      if (!conversation.streaming) return conversation;
      return { ...conversation, messages: [...conversation.messages, assistantMessage(event.assistantId)] };
    case 'retry': {
      if (!canRetry(conversation)) return conversation;
      // The last answer goes, every round of it; the question before it stands. The Plot
      // setting of this attempt is the one that counts for what the chart may see.
      const asked = conversation.messages.findLastIndex((message) => message.role === 'user');
      const kept = conversation.messages.slice(0, asked + 1);
      const question = kept[asked];
      if (question !== undefined && event.plot !== undefined) {
        kept[asked] = { ...question, plot: event.plot };
      }
      return {
        messages: [...kept, assistantMessage(event.assistantId)],
        streaming: true,
        error: null,
      };
    }
    case 'load':
      return { messages: event.messages, streaming: false, error: null };
    case 'fail': {
      const index = conversation.messages.length - 1;
      const target = conversation.messages[index];
      // A placeholder that never received text would look like an empty answer;
      // a partial one is worth keeping next to the message about the failure.
      const placeholder =
        conversation.streaming &&
        target !== undefined &&
        target.role === 'assistant' &&
        target.text === '' &&
        target.calls.length === 0;
      return {
        messages: placeholder ? conversation.messages.slice(0, index) : conversation.messages,
        streaming: false,
        error: event.text,
      };
    }
    case 'reset':
      return emptyConversation;
  }
}
