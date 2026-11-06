// The turn loop in one place: the transcript, the request that fills it, and the
// AbortController behind the Stop button. The reducer decides what happens to the
// transcript; this file only decides when to call it and where the text comes from.

import { useEffect, useRef, useState } from 'react';
import { describeFailure, streamChat } from '../api/chatClient';
import type { FetchLike } from '../api/chatClient';
import { canRetry, canSend, emptyConversation, reduceConversation } from '../chat/conversation';
import type { Conversation, ConversationEvent } from '../chat/conversation';
import { idSequence } from '../chat/message';
import type { ChatMessage } from '../chat/message';
import { createTurnClock } from '../chat/turnClock';

export type ChatConfig = {
  readonly model: string;
  readonly origin: string;
  readonly fetchImpl: FetchLike;
  readonly thinking?: boolean;
  readonly initialMessages?: readonly ChatMessage[];
  readonly now?: () => number;
  // A turn is over, however it ended: the transcript as it stands, and the failure if that
  // is what happened. A turn the reader replaced with another chat does not count.
  readonly onTurn?: (conversation: Conversation, failure: string | null) => void;
};

type Ids = {
  readonly user: () => string;
  readonly assistant: () => string;
};

// Saved messages take ids from this page's sequence, or the next question could arrive
// with an id an old message already holds.
function withFreshIds(messages: readonly ChatMessage[], ids: Ids): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    id: message.role === 'user' ? ids.user() : ids.assistant(),
  }));
}

export type Chat = {
  readonly conversation: Conversation;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly retry: () => void;
  readonly reset: () => void;
  readonly load: (messages: readonly ChatMessage[]) => void;
};

export function useChat(config: ChatConfig): Chat {
  const [ids] = useState<Ids>(() => ({ user: idSequence('u'), assistant: idSequence('a') }));
  const [conversation, setConversation] = useState<Conversation>(() => ({
    ...emptyConversation,
    messages: withFreshIds(config.initialMessages ?? [], ids),
  }));
  // The same transcript, kept where an asynchronous callback can read the current
  // version instead of the one its render saw.
  const transcript = useRef<Conversation>(conversation);
  const aborts = useRef<AbortController | null>(null);
  // A turn number, so text arriving after a reset is dropped rather than added to the
  // next conversation. A stop keeps its turn: that answer is finished, not discarded.
  const turn = useRef(0);

  function update(next: Conversation): void {
    transcript.current = next;
    setConversation(next);
  }

  function apply(myTurn: number, event: ConversationEvent): void {
    if (myTurn !== turn.current) return;
    update(reduceConversation(transcript.current, event));
  }

  async function answer(messages: readonly ChatMessage[], myTurn: number, signal: AbortSignal): Promise<void> {
    const clock = createTurnClock(config.now ?? Date.now);
    try {
      const outcome = await streamChat({
        model: config.model,
        origin: config.origin,
        messages,
        fetchImpl: config.fetchImpl,
        signal,
        ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
        onDelta: (delta) => {
          clock.mark(delta.channel);
          apply(myTurn, { type: 'delta', channel: delta.channel, text: delta.text });
        },
      });
      // A stopped stream resolved quietly, which is still the end of the turn.
      const ending = outcome.stopped ? 'stopped' : outcome.finish === 'length' ? 'length' : null;
      apply(myTurn, { type: 'end', ending, stats: clock.finish(outcome.usage) });
      if (myTurn === turn.current) config.onTurn?.(transcript.current, null);
    } catch (reason) {
      const failure = describeFailure(reason);
      apply(myTurn, { type: 'fail', text: failure });
      if (myTurn === turn.current) config.onTurn?.(transcript.current, failure);
    }
  }

  function begin(next: Conversation): void {
    turn.current += 1;
    update(next);

    const controller = new AbortController();
    aborts.current = controller;
    void answer(next.messages, turn.current, controller.signal).finally(() => {
      if (aborts.current === controller) aborts.current = null;
    });
  }

  function send(text: string): void {
    if (!canSend(transcript.current, text)) return;
    begin(
      reduceConversation(transcript.current, {
        type: 'send',
        text: text.trim(),
        userId: ids.user(),
        assistantId: ids.assistant(),
      }),
    );
  }

  function retry(): void {
    if (!canRetry(transcript.current)) return;
    begin(reduceConversation(transcript.current, { type: 'retry', assistantId: ids.assistant() }));
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

  // Another conversation takes the page over, and whatever this one was bringing stops.
  function load(messages: readonly ChatMessage[]): void {
    turn.current += 1;
    aborts.current?.abort();
    update(reduceConversation(transcript.current, { type: 'load', messages: withFreshIds(messages, ids) }));
  }

  // The page going away ends the turn: there is nothing left to show the answer in.
  useEffect(
    () => () => {
      aborts.current?.abort();
    },
    [],
  );

  return { conversation, send, stop, retry, reset, load };
}
