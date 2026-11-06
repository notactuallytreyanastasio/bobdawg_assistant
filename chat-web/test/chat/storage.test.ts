import { describe, expect, it } from 'vitest';
import { emptyLibrary, saveChat } from '../../src/chat/library';
import { userMessage } from '../../src/chat/message';
import {
  loadLibrary,
  loadPlot,
  loadThinking,
  loadWorkSizes,
  loadWorkspaceId,
  loadWorkspaceOn,
  saveWorkSizes,
  saveLibrary,
  savePlot,
  saveThinking,
  saveWorkspaceId,
  saveWorkspaceOn,
} from '../../src/chat/storage';
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

const broken: StoreLike = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('quota');
  },
};

describe('storage', () => {
  it('holds a library between loads', () => {
    const store = memoryStore();
    const library = saveChat(emptyLibrary, 'c1', [userMessage('u1', 'q')], 1);
    expect(saveLibrary(store, library)).toBe(true);
    expect(loadLibrary(store)).toEqual(library);
  });

  it('lets the oldest chats go when storage is full', () => {
    let library = emptyLibrary;
    for (const id of ['old', 'mid', 'new']) library = saveChat(library, id, [userMessage('u1', 'q')], 1);
    const roomForOne = JSON.stringify({ ...library, chats: library.chats.slice(0, 1) }).length;
    const held = new Map<string, string>();
    const small: StoreLike = {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => {
        if (value.length > roomForOne) throw new Error('quota');
        held.set(key, value);
      },
    };

    expect(saveLibrary(small, library)).toBe(true);
    expect(loadLibrary(small).chats.map((chat) => chat.id)).toEqual(['new']);
  });

  it('has thinking on until it is turned off', () => {
    const store = memoryStore();
    expect(loadThinking(store)).toBe(true);
    saveThinking(store, false);
    expect(loadThinking(store)).toBe(false);
  });

  it('carries on with nothing saved when storage is refused or missing', () => {
    expect(loadLibrary(broken)).toEqual(emptyLibrary);
    expect(saveLibrary(broken, emptyLibrary)).toBe(false);
    expect(loadThinking(broken)).toBe(true);
    expect(loadLibrary(null)).toEqual(emptyLibrary);
    expect(saveThinking(null, true)).toBe(false);
  });
});

describe('the Plot toggle', () => {
  it('is off until it was turned on', () => {
    const store = memoryStore();
    expect(loadPlot(store)).toBe(false);
    expect(savePlot(store, true)).toBe(true);
    expect(loadPlot(store)).toBe(true);
    savePlot(store, false);
    expect(loadPlot(store)).toBe(false);
  });

  it('stays off without storage', () => {
    expect(loadPlot(null)).toBe(false);
    expect(savePlot(null, true)).toBe(false);
  });
});

describe('the workspace settings', () => {
  it('is off unless turned on, and keeps its id', () => {
    const store = memoryStore();
    expect(loadWorkspaceOn(store)).toBe(false);
    saveWorkspaceOn(store, true);
    expect(loadWorkspaceOn(store)).toBe(true);
    expect(loadWorkspaceId(store)).toBeNull();
    saveWorkspaceId(store, 'abc');
    expect(loadWorkspaceId(store)).toBe('abc');
  });
});

describe('work sizes', () => {
  const memory = (): StoreLike => {
    const held = new Map<string, string>();
    return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
  };

  it('keeps what was dragged', () => {
    const store = memory();
    expect(saveWorkSizes(store, { thinking: 320, chat: null })).toBe(true);
    expect(loadWorkSizes(store)).toEqual({ thinking: 320, chat: null });
  });

  it('falls back to the defaults for anything else', () => {
    const store = memory();
    expect(loadWorkSizes(null)).toEqual({ thinking: null, chat: null });
    store.setItem('ds4.chat.work.sizes', 'not json');
    expect(loadWorkSizes(store)).toEqual({ thinking: null, chat: null });
    store.setItem('ds4.chat.work.sizes', '{"thinking":-4,"chat":"wide"}');
    expect(loadWorkSizes(store)).toEqual({ thinking: null, chat: null });
  });
});
