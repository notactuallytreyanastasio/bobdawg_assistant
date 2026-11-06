// What a transcript holds in the way of charts, as data: the code each plot call carried,
// how its check went, and which of the reader's texts it may see. Reading this runs nothing.

import { MAX_DATA_CHARS } from '../artifact/limits';
import { toolBlockAfter } from './message';
import type { ChatMessage, ToolCall } from './message';

const TITLE_CHARS = 80;
const SEPARATOR = '\n\n';

export type ArtifactStatus = 'ok' | 'failed' | 'unchecked';

export type Artifact = {
  // The call id alone can repeat across turns, so the page tells attempts apart by this.
  readonly key: string;
  readonly callId: string;
  readonly title: string;
  readonly code: string;
  readonly messages: readonly string[];
  readonly withheld: number;
  readonly status: ArtifactStatus;
  readonly detail: string;
};

export type FrameTexts = {
  readonly texts: readonly string[];
  readonly truncated: boolean;
  // Earlier questions sent with Plot off: not in the texts, but the model did read them.
  readonly withheld: number;
};

export function titleOfCode(code: string): string {
  const title = /^\s*\/\/\s*title:\s*(.*?)\s*$/m.exec(code)?.[1] ?? '';
  return title === '' ? 'Chart' : title.slice(0, TITLE_CHARS);
}

// What DATA will come to, separators included, which is the number the reader is shown.
export function plotCharacters(texts: readonly string[]): number {
  return texts.join(SEPARATOR).length;
}

// Blank lines are left out because the separators between messages are blank, and so is what
// usually ends a paste: neither is a row the code could have lost.
export function plotLines(texts: readonly string[]): number {
  return texts.join(SEPARATOR).split('\n').filter((line) => line.trim() !== '').length;
}

// What the reader agrees to, in the words of the risk: the sandbox holds against the page
// and the API, and it cannot hold against a DNS lookup. Text sent with Plot off stays out of
// DATA, and a chart that seems to have no data is explained here; the model is told it may copy
// such text in, so the reader has to hear that too.
export function consentText(chars: number, withheld = 0): string {
  const left =
    withheld === 0
      ? ''
      : ` ${withheld === 1 ? 'Your earlier message sent with Plot off is' : `Your ${withheld} earlier messages sent with Plot off are`} not given to the chart, though the model can copy what it read into its code.`;
  return `This code will run with the ${chars} characters you sent with Plot on.${left} A hostile chart could leak that text through DNS, which this page cannot stop.`;
}

function textsOf(messages: readonly ChatMessage[]): FrameTexts {
  const texts: string[] = [];
  let used = 0;
  let truncated = false;
  // Newest first, so it is the old messages that give way.
  for (const message of messages.toReversed()) {
    if (message.role !== 'user' || !message.plot) continue;
    const size = message.text.length + (texts.length === 0 ? 0 : SEPARATOR.length);
    if (used + size > MAX_DATA_CHARS) {
      truncated = true;
      if (texts.length === 0) texts.push(message.text.slice(0, MAX_DATA_CHARS));
      break;
    }
    texts.push(message.text);
    used += size;
  }
  const withheld = messages.filter((message) => message.role === 'user' && !message.plot).length;
  return { texts: texts.reverse(), truncated, withheld };
}

// The texts sent with Plot on up to the message holding a call, so an old attempt sees what
// it saw then and never the reader's later messages.
export function frameTexts(messages: readonly ChatMessage[], upToCall: string): FrameTexts {
  const index = messages.findLastIndex((message) => message.calls.some((call) => call.id === upToCall));
  return index < 0 ? { texts: [], truncated: false, withheld: 0 } : textsOf(messages.slice(0, index));
}

function codeOf(call: ToolCall): string {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed !== 'object' || parsed === null) return '';
    const { code } = parsed as { readonly code?: unknown };
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

export function artifactsOf(messages: readonly ChatMessage[]): readonly Artifact[] {
  return messages.flatMap((message, index) => {
    const plots = message.calls.filter((call) => call.name === 'plot');
    if (plots.length === 0) return [];
    const block = toolBlockAfter(messages, index);
    const { texts, withheld } = textsOf(messages.slice(0, index));
    return plots.map((call): Artifact => {
      const answer = block.find((entry) => entry.result?.callId === call.id);
      const code = codeOf(call);
      return {
        key: `${message.id}/${call.id}`,
        callId: call.id,
        title: titleOfCode(code),
        code,
        messages: texts,
        withheld,
        status: answer === undefined ? 'unchecked' : answer.result?.ok === true ? 'ok' : 'failed',
        detail: answer?.text ?? '',
      };
    });
  });
}
