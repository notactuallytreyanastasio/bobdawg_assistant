// The saved chats as state: the library, kept in step with storage on every change.

import { useRef, useState } from 'react';
import { removeChat, saveChat } from '../chat/library';
import type { Library, SavedChat } from '../chat/library';
import type { ChatMessage } from '../chat/message';
import { loadLibrary, saveLibrary } from '../chat/storage';
import type { StoreLike } from '../chat/storage';

export type LibraryState = {
  readonly chats: readonly SavedChat[];
  readonly initial: SavedChat | null;
  readonly save: (id: string, messages: readonly ChatMessage[]) => void;
  readonly select: (id: string | null) => void;
  readonly remove: (id: string) => void;
};

export function useLibrary(store: StoreLike | null, now: () => number = Date.now): LibraryState {
  const [library, setLibrary] = useState<Library>(() => loadLibrary(store));
  const current = useRef(library);
  const [initial] = useState<SavedChat | null>(
    () => library.chats.find((chat) => chat.id === library.activeId) ?? null,
  );

  function commit(next: Library): void {
    if (next === current.current) return;
    current.current = next;
    setLibrary(next);
    saveLibrary(store, next);
  }

  return {
    chats: library.chats,
    initial,
    // A chat only becomes the one to come back to once it has something in it.
    save: (id, messages) => {
      const saved = saveChat(current.current, id, messages, now());
      commit(saved === current.current ? saved : { ...saved, activeId: id });
    },
    select: (id) => commit({ ...current.current, activeId: id }),
    remove: (id) => commit(removeChat(current.current, id)),
  };
}
