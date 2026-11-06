// Handing a finished exchange to ds4-server, which writes it to the decision graph. The
// token that writes there stays on the server, so this is the page's whole part: say what
// was asked and what came back, and report whether it landed. A turn is sent once; a
// record that failed is shown, not retried, because the answer it describes is unaffected.

import { platformFetch } from './chatClient';
import type { FetchLike } from './chatClient';
import { artifactsOf } from '../chat/artifact';
import type { ChatMessage } from '../chat/message';

export type TurnRecord = {
  readonly chat: string;
  readonly first: string;
  readonly question: string;
  readonly answer: string;
  readonly ending: '' | 'stopped' | 'length' | 'failed';
  readonly model: string;
};

// 'off' is a server that does not record, which is a setting and not a loss.
export type RecordResult = 'recorded' | 'off' | 'missed';

export type RecordOptions = {
  readonly origin: string;
  readonly fetchImpl?: FetchLike;
  readonly turn: TurnRecord;
};

// What the transcript says about its newest exchange, or nothing if no question was asked.
// The answer is missing when the turn failed or was stopped before a word, and the turn is
// worth recording all the same: that it went wrong is part of what happened. A chart the
// model drew without comment goes in by name; its code never goes in.
export function turnRecordOf(
  chat: string,
  model: string,
  messages: readonly ChatMessage[],
  failure: string | null,
): TurnRecord | null {
  const asked = messages.filter((message) => message.role === 'user');
  const question = asked.at(-1)?.text;
  if (question === undefined) return null;
  const turn = messages.slice(messages.findLastIndex((message) => message.role === 'user') + 1);
  const answers = turn.filter((message) => message.role === 'assistant');
  const words = answers.findLast((message) => message.text !== '')?.text;
  const drawn = artifactsOf(turn).findLast((artifact) => artifact.status === 'ok');
  const answer = words ?? (drawn === undefined ? '' : `Drew: ${drawn.title}`);
  const ending = answers.at(-1)?.ending ?? null;
  const base = { chat, model, question, first: asked[0]?.text ?? question };
  if (failure !== null) return { ...base, answer: failure, ending: 'failed' };
  if (ending === 'gaveup') return { ...base, answer, ending: 'failed' };
  // The server's list of endings has no word for this, and it is no clean success: nobody
  // looked at the chart. Any words are from before the last call, so they are not an answer.
  if (ending === 'capped') {
    const last = drawn === undefined ? answer : `Drew: ${drawn.title}`;
    return { ...base, answer: `Ran out of rounds. ${last}`.trimEnd(), ending: 'failed' };
  }
  if (answer === '') return { ...base, answer, ending: 'stopped' };
  return { ...base, answer, ending: ending ?? '' };
}

export async function recordTurn(options: RecordOptions): Promise<RecordResult> {
  const send = options.fetchImpl ?? platformFetch;
  try {
    const response = await send(`${options.origin}/chat/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.turn),
    });
    if (response.ok) return 'recorded';
    return response.status === 404 ? 'off' : 'missed';
  } catch {
    return 'missed';
  }
}
