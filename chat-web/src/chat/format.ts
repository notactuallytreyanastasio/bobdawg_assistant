// The words the page uses for numbers, kept apart from the components so the rounding
// rules have one home.

import type { TurnStats } from './message';

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function formatStats(stats: TurnStats | null): string {
  if (stats === null) return '';
  const parts: string[] = [];
  if (stats.outputTokens !== null) parts.push(`${stats.outputTokens.toLocaleString('en-US')} tokens`);
  if (stats.tokensPerSecond !== null) parts.push(`${stats.tokensPerSecond.toFixed(1)} tok/s`);
  return parts.join(' · ');
}

// How full the context is, in whole percent. Anything used reads as at least 1, because
// "0% of context" next to a conversation is a claim the reader would not believe.
export function contextPercent(tokens: number | null, contextLength: number | null): number | null {
  if (tokens === null || contextLength === null || contextLength <= 0) return null;
  return Math.min(100, Math.max(1, Math.round((tokens * 100) / contextLength)));
}
