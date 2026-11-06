// The turn loop in one place: the transcript, the request that fills it, and the
// AbortController behind the Stop button. The reducer decides what happens to the
// transcript; this file only decides when to call it and where the text comes from.

import { useEffect, useRef, useState } from 'react';
import { describeFailure, streamChat } from '../api/chatClient';
import type { FetchLike } from '../api/chatClient';
import { canSend, emptyConversation, reduceConversation } from '../chat/conversation';
import type { Conversation, ConversationEvent } from '../chat/conversation';
import { idSequence } from '../chat/message';
import type { ChatMessage } from '../chat/message';

export type ChatConfig = {
  readonly model: string;
  readonly origin: string;
  readonly fetchImpl: FetchLike;
};

export type Chat = {
  readonly conversation: Conversation;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly reset: () => void;
};

export function useChat(config: ChatConfig): Chat {
  const [conversation, setConversation] = useState<Conversation>(emptyConversation);
  // The same transcript, kept where an asynchronous callback can read the current
  // version instead of the one its render saw.
  const transcript = useRef<Conversation>(emptyConversation);
  const aborts = useRef<AbortController | null>(null);
  // A turn number, so text arriving after a reset is dropped rather than added to the
  // next conversation. A stop keeps its turn: that answer is finished, not discarded.
  const turn = useRef(0);
  const ids = useRef({ user: idSequence('u'), assistant: idSequence('a') }).current;

  function update(next: Conversation): void {
    transcript.current = next;
    setConversation(next);
  }

  function apply(myTurn: number, event: ConversationEvent): void {
    if (myTurn !== turn.current) return;
    update(reduceConversation(transcript.current, event));
  }

  async function answer(messages: readonly ChatMessage[], myTurn: number, signal: AbortSignal): Promise<void> {
    try {
      await streamChat({
        model: config.model,
        origin: config.origin,
        messages,
        fetchImpl: config.fetchImpl,
        signal,
        onDelta: (delta) => {
          apply(myTurn, { type: 'delta', channel: delta.channel, text: delta.text });
        },
      });
      // A stopped stream resolved quietly, which is still the end of the turn.
      apply(myTurn, { type: 'end' });
    } catch (reason) {
      apply(myTurn, { type: 'fail', text: describeFailure(reason) });
    }
  }

  function send(text: string): void {
    if (!canSend(transcript.current, text)) return;
    const next = reduceConversation(transcript.current, {
      type: 'send',
      text: text.trim(),
      userId: ids.user(),
      assistantId: ids.assistant(),
    });
    turn.current += 1;
    update(next);

    const controller = new AbortController();
    aborts.current = controller;
    void answer(next.messages, turn.current, controller.signal).finally(() => {
      if (aborts.current === controller) aborts.current = null;
    });
  }

  function stop(): void {
    aborts.current?.abort();
  }

  function reset(): void {
    // Anything this turn is still bringing is no longer wanted.
    turn.current += 1;
    aborts.current?.abort();
    update(emptyConversation);
  }

  // The page going away ends the turn: there is nothing left to show the answer in.
  useEffect(
    () => () => {
      aborts.current?.abort();
    },
    [],
  );

  return { conversation, send, stop, reset };
}
