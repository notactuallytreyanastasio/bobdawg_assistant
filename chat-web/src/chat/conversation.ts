// One conversation as data plus the events that change it. The reducer is the
// only place that decides what a delta, a finished turn or a failure does to the
// transcript, so the components below it stay presentational.

import { assistantMessage, userMessage } from './message';
import type { ChatMessage } from './message';

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
    }
  | { readonly type: 'delta'; readonly channel: DeltaChannel; readonly text: string }
  | { readonly type: 'end' }
  | { readonly type: 'fail'; readonly text: string }
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

export function reduceConversation(
  conversation: Conversation,
  event: ConversationEvent,
): Conversation {
  switch (event.type) {
    case 'send':
      return {
        messages: [
          ...conversation.messages,
          userMessage(event.userId, event.text),
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
      return conversation.streaming ? { ...conversation, streaming: false } : conversation;
    case 'fail': {
      const index = conversation.messages.length - 1;
      const target = conversation.messages[index];
      // A placeholder that never received text would look like an empty answer;
      // a partial one is worth keeping next to the message about the failure.
      const placeholder =
        conversation.streaming &&
        target !== undefined &&
        target.role === 'assistant' &&
        target.text === '';
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
