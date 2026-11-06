// The clock behind a turn's numbers. The first delta is where decoding starts, so the rate
// leaves prefill out of it, and thinking runs from the first reasoning delta to the first
// word of the answer. The caller supplies the time, so a test can say what it was.

import type { DeltaChannel } from './conversation';
import type { TurnStats } from './message';

export type TurnClock = {
  readonly mark: (channel: DeltaChannel) => void;
  readonly finish: (usage: { promptTokens: number; completionTokens: number } | null) => TurnStats;
};

export function createTurnClock(now: () => number): TurnClock {
  let first: number | null = null;
  let last: number | null = null;
  let thinkingFrom: number | null = null;
  let thinkingTo: number | null = null;
  let answering = false;

  return {
    mark(channel) {
      const at = now();
      first ??= at;
      last = at;
      if (channel === 'content') {
        answering = true;
      } else if (!answering) {
        thinkingFrom ??= at;
        thinkingTo = at;
      }
    },
    finish(usage) {
      // A thought with no answer after it ends where its last word did. Otherwise it
      // runs up to the answer, and the first content mark is not recorded separately:
      // the last reasoning mark sits right beside it.
      const thoughtMs =
        thinkingFrom === null || thinkingTo === null ? null : thinkingTo - thinkingFrom;
      const decoding = first === null || last === null ? 0 : last - first;
      return {
        outputTokens: usage?.completionTokens ?? null,
        contextTokens: usage === null ? null : usage.promptTokens + usage.completionTokens,
        tokensPerSecond:
          usage === null || decoding <= 0 ? null : (usage.completionTokens * 1000) / decoding,
        thoughtMs,
      };
    },
  };
}
