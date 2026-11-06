import { describe, expect, it } from 'vitest';
import { createTurnClock } from '../../src/chat/turnClock';

function clockAt(times: readonly number[]) {
  let index = 0;
  return createTurnClock(() => times[index++] ?? 0);
}

describe('createTurnClock', () => {
  it('measures the rate from the first delta to the last, leaving prefill out', () => {
    const clock = clockAt([5000, 7000]);
    clock.mark('content');
    clock.mark('content');
    const stats = clock.finish({ promptTokens: 10, completionTokens: 40 });
    expect(stats.tokensPerSecond).toBe(20);
    expect(stats.outputTokens).toBe(40);
    expect(stats.contextTokens).toBe(50);
  });

  it('measures thinking up to where the reasoning ended', () => {
    const clock = clockAt([1000, 4000, 4100]);
    clock.mark('reasoning');
    clock.mark('reasoning');
    clock.mark('content');
    expect(clock.finish(null).thoughtMs).toBe(3000);
  });

  it('has nothing to say about a turn with no usage or no thinking', () => {
    const clock = clockAt([1000, 2000]);
    clock.mark('content');
    clock.mark('content');
    expect(clock.finish(null)).toEqual({
      outputTokens: null,
      contextTokens: null,
      tokensPerSecond: null,
      thoughtMs: null,
    });
  });

  it('claims no rate for a turn that arrived all at once', () => {
    const clock = clockAt([1000]);
    clock.mark('content');
    expect(clock.finish({ promptTokens: 1, completionTokens: 1 }).tokensPerSecond).toBeNull();
  });
});
