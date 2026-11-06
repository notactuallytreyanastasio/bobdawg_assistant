// Saved conversations as plain data: what a saved chat is, how it gets its title, and how
// a stored value that may be old or damaged is read back. Storage itself is one file over.

import type { ChatMessage, Ending, Role, TurnStats } from './message';

export const MAX_CHATS = 100;
const TITLE_LENGTH = 60;

export type SavedChat = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: readonly ChatMessage[];
};

export type Library = {
  readonly activeId: string | null;
  // Newest first.
  readonly chats: readonly SavedChat[];
};

export const emptyLibrary: Library = { activeId: null, chats: [] };

// An answer that never received a word is a placeholder of the moment, not something to
// reopen later.
function worthKeeping(message: ChatMessage): boolean {
  return message.role === 'user' || message.text !== '' || message.reasoning !== '';
}

export function titleOf(messages: readonly ChatMessage[]): string {
  const question = messages.find((message) => message.role === 'user')?.text ?? '';
  const line = question.trim().split('\n')[0]?.trim() ?? '';
  if (line === '') return 'New chat';
  return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}

function sameTranscript(a: readonly ChatMessage[], b: readonly ChatMessage[]): boolean {
  return (
    a.length === b.length &&
    a.every((message, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        message.role === other.role &&
        message.text === other.text &&
        message.reasoning === other.reasoning &&
        message.ending === other.ending
      );
    })
  );
}

// Saving a chat that has not changed leaves it where it is, so that merely opening an old
// conversation does not move it to the top of the list.
export function saveChat(
  library: Library,
  id: string,
  messages: readonly ChatMessage[],
  now: number,
): Library {
  const kept = messages.filter(worthKeeping);
  if (kept.length === 0) return library;
  const existing = library.chats.find((chat) => chat.id === id);
  if (existing !== undefined && sameTranscript(existing.messages, kept)) return library;
  const chat: SavedChat = {
    id,
    title: existing?.title ?? titleOf(kept),
    updatedAt: now,
    messages: kept,
  };
  const others = library.chats.filter((other) => other.id !== id);
  return { ...library, chats: [chat, ...others].slice(0, MAX_CHATS) };
}

export function removeChat(library: Library, id: string): Library {
  return {
    activeId: library.activeId === id ? null : library.activeId,
    chats: library.chats.filter((chat) => chat.id !== id),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function statsOf(value: unknown): TurnStats | null {
  const stats = record(value);
  if (stats === null) return null;
  return {
    outputTokens: numberOrNull(stats['outputTokens']),
    contextTokens: numberOrNull(stats['contextTokens']),
    tokensPerSecond: numberOrNull(stats['tokensPerSecond']),
    thoughtMs: numberOrNull(stats['thoughtMs']),
  };
}

function endingOf(value: unknown): Ending | null {
  return value === 'stopped' || value === 'length' ? value : null;
}

function messageOf(value: unknown): ChatMessage | null {
  const message = record(value);
  if (message === null) return null;
  const { id, role, text, reasoning } = message;
  if (typeof id !== 'string' || typeof text !== 'string') return null;
  if (role !== 'user' && role !== 'assistant') return null;
  return {
    id,
    role: role satisfies Role,
    text,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
    ending: endingOf(message['ending']),
    stats: statsOf(message['stats']),
  };
}

function chatOf(value: unknown): SavedChat | null {
  const chat = record(value);
  if (chat === null) return null;
  const { id, title, updatedAt, messages } = chat;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof updatedAt !== 'number') return null;
  if (!Array.isArray(messages)) return null;
  const read = (messages as readonly unknown[])
    .map(messageOf)
    .filter((message) => message !== null);
  return read.length === 0 ? null : { id, title, updatedAt, messages: read };
}

// Whatever was stored, an older page or a damaged value included: what can be read is
// kept and the rest is left behind, because a bad entry must not cost the good ones.
export function parseLibrary(text: string | null): Library {
  if (text === null) return emptyLibrary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyLibrary;
  }
  const stored = record(parsed);
  if (stored === null || !Array.isArray(stored['chats'])) return emptyLibrary;
  const chats = (stored['chats'] as readonly unknown[])
    .map(chatOf)
    .filter((chat) => chat !== null);
  const activeId = stored['activeId'];
  const known = typeof activeId === 'string' && chats.some((chat) => chat.id === activeId);
  return { activeId: known ? activeId : null, chats };
}
