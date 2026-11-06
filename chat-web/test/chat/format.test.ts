import { describe, expect, it } from 'vitest';
import { contextPercent, formatDuration, formatStats } from '../../src/chat/format';

describe('formatDuration', () => {
  it('rounds to seconds and never says zero', () => {
    expect(formatDuration(200)).toBe('1s');
    expect(formatDuration(14400)).toBe('14s');
  });

  it('moves to minutes', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(75000)).toBe('1m 15s');
  });
});

describe('formatStats', () => {
  it('says what is known', () => {
    const none = { outputTokens: null, contextTokens: null, tokensPerSecond: null, thoughtMs: null };
    expect(formatStats(null)).toBe('');
    expect(formatStats(none)).toBe('');
    expect(formatStats({ ...none, outputTokens: 12 })).toBe('12 tokens');
    expect(formatStats({ ...none, outputTokens: 1200, tokensPerSecond: 7 })).toBe('1,200 tokens · 7.0 tok/s');
  });
});

describe('contextPercent', () => {
  it('needs both numbers', () => {
    expect(contextPercent(null, 100)).toBeNull();
    expect(contextPercent(5, null)).toBeNull();
  });

  it('stays between one and a hundred', () => {
    expect(contextPercent(1, 100000)).toBe(1);
    expect(contextPercent(50, 100)).toBe(50);
    expect(contextPercent(500, 100)).toBe(100);
  });
});
