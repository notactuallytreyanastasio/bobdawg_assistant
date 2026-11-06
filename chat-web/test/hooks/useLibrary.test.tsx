import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLibrary } from '../../src/hooks/useLibrary';
import { userMessage } from '../../src/chat/message';
import type { StoreLike } from '../../src/chat/storage';

function memoryStore(): StoreLike {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
  };
}

const question = [userMessage('u1', 'q')];

describe('useLibrary', () => {
  it('lists what was saved and remembers it as the chat to come back to', () => {
    const store = memoryStore();
    const first = renderHook(() => useLibrary(store, () => 1));
    act(() => first.result.current.save('c1', question));
    expect(first.result.current.chats.map((chat) => chat.id)).toEqual(['c1']);

    const second = renderHook(() => useLibrary(store, () => 2));
    expect(second.result.current.initial?.id).toBe('c1');
  });

  it('starts empty after the reader moved to a new chat', () => {
    const store = memoryStore();
    const first = renderHook(() => useLibrary(store, () => 1));
    act(() => first.result.current.save('c1', question));
    act(() => first.result.current.select(null));

    expect(renderHook(() => useLibrary(store)).result.current.initial).toBeNull();
  });

  it('removes a chat from the list and from storage', () => {
    const store = memoryStore();
    const view = renderHook(() => useLibrary(store, () => 1));
    act(() => view.result.current.save('c1', question));
    act(() => view.result.current.remove('c1'));

    expect(view.result.current.chats).toEqual([]);
    expect(renderHook(() => useLibrary(store)).result.current.chats).toEqual([]);
  });

  it('works with no storage at all', () => {
    const view = renderHook(() => useLibrary(null, () => 1));
    act(() => view.result.current.save('c1', question));
    expect(view.result.current.chats).toHaveLength(1);
  });
});
