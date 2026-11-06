// The browser's storage behind a narrow door. Reaching for it can throw, in a private
// window or with storage turned off, and a page that cannot remember should still chat, so
// every failure here answers with "nothing saved" rather than an exception.

import { emptyLibrary, parseLibrary } from './library';
import type { Library } from './library';

export type StoreLike = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
};

const LIBRARY_KEY = 'ds4.chat.library';
const THINKING_KEY = 'ds4.chat.thinking';

export function platformStore(): StoreLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(store: StoreLike | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: StoreLike | null, key: string, value: string): boolean {
  if (store === null) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadLibrary(store: StoreLike | null): Library {
  return store === null ? emptyLibrary : parseLibrary(read(store, LIBRARY_KEY));
}

// Browser storage is a few megabytes and thinking text is long. When it is full the oldest
// chats give way, so the conversation in progress is still the one that survives a reload.
export function saveLibrary(store: StoreLike | null, library: Library): boolean {
  let chats = library.chats;
  while (!write(store, LIBRARY_KEY, JSON.stringify({ ...library, chats }))) {
    if (store === null || chats.length <= 1) return false;
    chats = chats.slice(0, -1);
  }
  return true;
}

// Thinking is on unless it was turned off: the answer is better for it, and the toggle is
// there for when it is not worth the wait.
export function loadThinking(store: StoreLike | null): boolean {
  return read(store, THINKING_KEY) !== 'off';
}

export function saveThinking(store: StoreLike | null, thinking: boolean): boolean {
  return write(store, THINKING_KEY, thinking ? 'on' : 'off');
}
