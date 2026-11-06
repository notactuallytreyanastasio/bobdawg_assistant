// The turn loop in one place: the transcript, the request that fills it, and the
// AbortController behind the Stop button. The reducer decides what happens to the
// transcript; this file only decides when to call it and where the text comes from.

import { useEffect, useRef, useState } from 'react';
import { describeFailure, streamChat } from '../api/chatClient';
import type { FetchLike } from '../api/chatClient';
import { canRetry, canSend, emptyConversation, reduceConversation } from '../chat/conversation';
import type { Conversation, ConversationEvent } from '../chat/conversation';
import { idSequence } from '../chat/message';
import type { ChatMessage, ToolCall } from '../chat/message';
import { createTurnClock } from '../chat/turnClock';
import type { Assistant } from '../tools/assistant';
import { MAX_ROUNDS, ONE_CALL_LINE, roundLine, runToolCall, toWireTools } from '../tools/tool';
import type { ToolResult } from '../tools/tool';

export type ChatConfig = {
  readonly model: string;
  readonly origin: string;
  readonly fetchImpl: FetchLike;
  readonly thinking?: boolean;
  // The assistant for new turns, or null for plain chat. A turn keeps the one it began with.
  readonly assistant?: Assistant | null;
  readonly initialMessages?: readonly ChatMessage[];
  readonly now?: () => number;
  // A turn is over, however it ended: the transcript as it stands, and the failure if that
  // is what happened. A turn the reader replaced with another chat does not count.
  readonly onTurn?: (conversation: Conversation, failure: string | null) => void;
  // A turn is starting, so whatever was granted to the one before it no longer holds.
  readonly onBegin?: () => void;
};

type Ids = {
  readonly user: () => string;
  readonly assistant: () => string;
  readonly call: () => string;
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
  const [ids] = useState<Ids>(() => ({ user: idSequence('u'), assistant: idSequence('a'), call: idSequence('call-') }));
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

  function finishTurn(myTurn: number, failure: string | null): void {
    if (myTurn === turn.current) config.onTurn?.(transcript.current, failure);
  }

  async function stream(myTurn: number, signal: AbortSignal, assistant: Assistant | null) {
    const clock = createTurnClock(config.now ?? Date.now);
    const outcome = await streamChat({
      model: config.model,
      origin: config.origin,
      messages: transcript.current.messages,
      fetchImpl: config.fetchImpl,
      signal,
      nextCallId: ids.call,
      ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
      ...(assistant === null
        ? {}
        : {
            tooling: {
              system: assistant.system,
              tools: toWireTools(assistant.tools),
              ...(assistant.clip === undefined ? {} : { clip: assistant.clip }),
            },
          }),
      onDelta: (delta) => {
        clock.mark(delta.channel);
        apply(myTurn, { type: 'delta', channel: delta.channel, text: delta.text });
      },
    });
    return { outcome, stats: clock.finish(outcome.usage) };
  }

  // Every call gets a result, whatever happens, because a call with no result is a turn the
  // server cannot replay. Only the first runs: the rest are answered without running, and so
  // are any left once one has ended the turn.
  async function runCalls(
    myTurn: number,
    signal: AbortSignal,
    assistant: Assistant,
    calls: readonly ToolCall[],
    round: number,
  ): Promise<ToolResult | null> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      const fatal = results.find((result) => result.fatal === true);
      const result: ToolResult =
        fatal !== undefined
          ? { ok: false, text: 'not run: an earlier call ended the turn' }
          : results.length > 0
            ? { ok: false, text: ONE_CALL_LINE }
            : await runToolCall(assistant.tools, call, {
                callId: call.id,
                messages: transcript.current.messages,
                signal,
              });
      if (myTurn !== turn.current) return null;
      const over = result.fatal === true || fatal !== undefined || signal.aborted;
      const max = assistant.rounds ?? MAX_ROUNDS;
      const thing = assistant.rounds === undefined ? 'chart' : 'work';
      const text = over ? result.text : `${roundLine(round, max, thing)}\n${result.text}`;
      apply(myTurn, { type: 'result', id: ids.assistant(), callId: call.id, ok: result.ok, text });
      results.push(result);
    }
    return results.find((result) => result.fatal === true) ?? results[0] ?? null;
  }

  async function answer(myTurn: number, signal: AbortSignal, assistant: Assistant | null): Promise<void> {
    try {
      await assistant?.prepare?.(signal).catch(() => undefined);
      if (myTurn !== turn.current) return;
      let previous: ToolResult | null = null;
      for (let round = 1; ; round += 1) {
        const { outcome, stats } = await stream(myTurn, signal, assistant);
        if (myTurn !== turn.current) return;
        // A stopped stream resolved quietly, which is still the end of the turn. A call the
        // length limit cut off is half a program, so it never runs.
        const ending = outcome.stopped ? 'stopped' : outcome.finish === 'length' ? 'length' : null;
        if (assistant === null || ending !== null || outcome.calls.length === 0) {
          // Silence after a failed attempt leaves nothing on the page to say that it failed.
          const silent = ending === null && previous?.ok === false && transcript.current.messages.at(-1)?.text === '';
          apply(myTurn, { type: 'end', ending: silent ? 'gaveup' : ending, stats });
          finishTurn(myTurn, null);
          return;
        }

        apply(myTurn, { type: 'calls', calls: outcome.calls });
        const last = await runCalls(myTurn, signal, assistant, outcome.calls, round);
        if (myTurn !== turn.current || last === null) return;
        previous = last;

        const finalEvent: ConversationEvent | null = signal.aborted
          ? { type: 'end', ending: 'stopped', stats }
          : last.fatal === true
            ? { type: 'end', ending: 'gaveup', stats, error: last.text }
            : round === (assistant.rounds ?? MAX_ROUNDS)
              ? { type: 'end', ending: last.ok ? 'capped' : 'gaveup', stats }
              : null;
        if (finalEvent !== null) {
          apply(myTurn, finalEvent);
          finishTurn(myTurn, null);
          return;
        }
        apply(myTurn, { type: 'next', assistantId: ids.assistant() });
      }
    } catch (reason) {
      const failure = describeFailure(reason);
      apply(myTurn, { type: 'fail', text: failure });
      finishTurn(myTurn, failure);
    }
  }

  function begin(next: Conversation): void {
    turn.current += 1;
    config.onBegin?.();
    update(next);

    const controller = new AbortController();
    aborts.current = controller;
    void answer(turn.current, controller.signal, config.assistant ?? null).finally(() => {
      if (aborts.current === controller) aborts.current = null;
    });
  }

  function send(text: string): void {
    if (!canSend(transcript.current, text)) return;
    begin(
      reduceConversation(transcript.current, {
        type: 'send',
        text: text.trim(),
        plot: (config.assistant ?? null) !== null,
        userId: ids.user(),
        assistantId: ids.assistant(),
      }),
    );
  }

  function retry(): void {
    if (!canRetry(transcript.current)) return;
    begin(
      reduceConversation(transcript.current, {
        type: 'retry',
        assistantId: ids.assistant(),
        plot: (config.assistant ?? null) !== null,
      }),
    );
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
