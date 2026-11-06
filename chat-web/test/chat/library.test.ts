import { describe, expect, it } from 'vitest';
import { emptyLibrary, MAX_CHATS, MAX_SAVED_ARGUMENTS, parseLibrary, removeChat, saveChat, titleOf } from '../../src/chat/library';
import { assistantMessage, toolMessage, userMessage } from '../../src/chat/message';

const question = userMessage('u1', 'What is a redlock?');
const answer = { ...assistantMessage('a1'), text: 'a gate' };

describe('titleOf', () => {
  it('is the first line of the first question', () => {
    expect(titleOf([userMessage('u1', '  line one\nline two')])).toBe('line one');
  });

  it('shortens a long question', () => {
    const title = titleOf([userMessage('u1', 'x'.repeat(200))]);
    expect(title.length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when nothing was asked', () => {
    expect(titleOf([])).toBe('New chat');
  });
});

describe('saveChat', () => {
  it('puts the newest chat first', () => {
    const one = saveChat(emptyLibrary, 'c1', [question], 1);
    const two = saveChat(one, 'c2', [question], 2);
    expect(two.chats.map((chat) => chat.id)).toEqual(['c2', 'c1']);
  });

  it('leaves out an answer that never received a word', () => {
    const saved = saveChat(emptyLibrary, 'c1', [question, assistantMessage('a1')], 1);
    expect(saved.chats[0]?.messages).toEqual([question]);
  });

  it('keeps nothing for a chat with nothing in it', () => {
    expect(saveChat(emptyLibrary, 'c1', [assistantMessage('a1')], 1)).toBe(emptyLibrary);
  });

  it('does not move a chat that has not changed, whatever ids it now carries', () => {
    const library = saveChat(saveChat(emptyLibrary, 'c1', [question, answer], 1), 'c2', [question], 2);
    const reopened = [{ ...question, id: 'u9' }, { ...answer, id: 'a9' }];
    expect(saveChat(library, 'c1', reopened, 3)).toBe(library);
  });

  it('keeps the title a chat started with, and moves it up when it grows', () => {
    const library = saveChat(saveChat(emptyLibrary, 'c1', [question], 1), 'c2', [question], 2);
    const grown = saveChat(library, 'c1', [question, answer, userMessage('u2', 'more')], 3);
    expect(grown.chats[0]?.id).toBe('c1');
    expect(grown.chats[0]?.title).toBe('What is a redlock?');
  });

  it('forgets the oldest past the limit', () => {
    let library = emptyLibrary;
    for (let index = 0; index <= MAX_CHATS; index += 1) {
      library = saveChat(library, `c${index}`, [question], index);
    }
    expect(library.chats).toHaveLength(MAX_CHATS);
    expect(library.chats.some((chat) => chat.id === 'c0')).toBe(false);
  });
});

describe('removeChat', () => {
  it('removes the chat and lets go of it if it was active', () => {
    const library = { ...saveChat(emptyLibrary, 'c1', [question], 1), activeId: 'c1' };
    expect(removeChat(library, 'c1')).toEqual(emptyLibrary);
  });
});

describe('parseLibrary', () => {
  it('reads back what was saved', () => {
    const library = { ...saveChat(emptyLibrary, 'c1', [question, answer], 1), activeId: 'c1' };
    expect(parseLibrary(JSON.stringify(library))).toEqual(library);
  });

  it('answers with an empty library for nothing, junk or the wrong shape', () => {
    expect(parseLibrary(null)).toEqual(emptyLibrary);
    expect(parseLibrary('{not json')).toEqual(emptyLibrary);
    expect(parseLibrary('[1,2]')).toEqual(emptyLibrary);
    expect(parseLibrary('{"chats":7}')).toEqual(emptyLibrary);
  });

  it('keeps the good chats beside a damaged one', () => {
    const good = saveChat(emptyLibrary, 'c1', [question], 1).chats[0];
    const text = JSON.stringify({ activeId: 'gone', chats: [good, { id: 3 }, { id: 'c2', title: 't', updatedAt: 1, messages: [{ role: 'bot' }] }] });
    expect(parseLibrary(text)).toEqual({ activeId: null, chats: [good] });
  });

  it('fills in fields an older page did not write', () => {
    const text = JSON.stringify({
      chats: [{ id: 'c1', title: 't', updatedAt: 1, messages: [{ id: 'u1', role: 'user', text: 'q' }] }],
    });
    expect(parseLibrary(text).chats[0]?.messages[0]).toEqual(userMessage('u1', 'q'));
  });
});

describe('saved tool calls', () => {
  const call = { id: 'c1', name: 'plot', arguments: '{"code":"x"}' };
  const stored = (message: Record<string, unknown>): string =>
    JSON.stringify({
      activeId: 'c1',
      chats: [{ id: 'c1', title: 't', updatedAt: 1, messages: [{ id: 'u1', role: 'user', text: 'q' }, message] }],
    });
  const second = (text: string) => parseLibrary(text).chats[0]?.messages[1];

  it('reads an older save, with no calls and Plot off', () => {
    expect(second(stored({ id: 'a1', role: 'assistant', text: 'hi' }))).toMatchObject({
      calls: [],
      result: null,
      plot: false,
    });
  });

  it('reads calls, results and Plot back', () => {
    expect(second(stored({ id: 'a1', role: 'assistant', text: '', calls: [call] }))?.calls).toEqual([call]);
    expect(
      second(stored({ id: 't1', role: 'tool', text: 'ok', result: { callId: 'c1', ok: true } }))?.result,
    ).toEqual({ callId: 'c1', ok: true });
    expect(second(stored({ id: 'u2', role: 'user', text: 'q', plot: true }))?.plot).toBe(true);
  });

  it('counts only a true Plot', () => {
    expect(second(stored({ id: 'u2', role: 'user', text: 'q', plot: 'yes' }))?.plot).toBe(false);
  });

  it('reads the out-of-rounds ending', () => {
    expect(second(stored({ id: 'a1', role: 'assistant', text: 'x', ending: 'capped' }))?.ending).toBe('capped');
  });

  it('reads the gave-up ending', () => {
    expect(second(stored({ id: 'a1', role: 'assistant', text: 'x', ending: 'gaveup' }))?.ending).toBe('gaveup');
  });

  it('drops a damaged call and keeps the chat', () => {
    const calls = [call, { id: 1, name: 'plot', arguments: '{}' }, 'junk', null];
    const read = parseLibrary(stored({ id: 'a1', role: 'assistant', text: 'hi', calls }));
    expect(read.chats).toHaveLength(1);
    expect(read.chats[0]?.messages[1]?.calls).toEqual([call]);
  });

  it('drops calls that are not a list', () => {
    expect(second(stored({ id: 'a1', role: 'assistant', text: 'hi', calls: 'x' }))?.calls).toEqual([]);
  });

  it('refuses a call past the saved size limit', () => {
    const large = { ...call, arguments: 'x'.repeat(MAX_SAVED_ARGUMENTS + 1) };
    expect(second(stored({ id: 'a1', role: 'assistant', text: 'hi', calls: [large] }))?.calls).toEqual([]);
  });

  it('drops a tool message with no valid result', () => {
    const read = parseLibrary(stored({ id: 't1', role: 'tool', text: 'ok', result: { callId: 7, ok: true } }));
    expect(read.chats[0]?.messages).toHaveLength(1);
  });

  it('keeps an answer that holds only calls, and a tool message', () => {
    const answer = { ...assistantMessage('a1'), calls: [call] };
    const result = toolMessage('t1', 'c1', true, 'ok');
    const saved = saveChat(emptyLibrary, 'c1', [question, answer, result], 1);
    expect(saved.chats[0]?.messages).toHaveLength(3);
  });

  it('saves a change to calls, a result or Plot', () => {
    const answer = { ...assistantMessage('a1'), text: 'x' };
    const base = saveChat(emptyLibrary, 'c1', [question, answer], 1);
    const withCalls = saveChat(base, 'c1', [question, { ...answer, calls: [call] }], 2);
    expect(withCalls.chats[0]?.updatedAt).toBe(2);
    const withPlot = saveChat(base, 'c1', [{ ...question, plot: true }, answer], 3);
    expect(withPlot.chats[0]?.updatedAt).toBe(3);
    const before = toolMessage('t1', 'c1', true, 'ok');
    const one = saveChat(base, 'c1', [question, before], 4);
    const flipped = saveChat(one, 'c1', [question, toolMessage('t1', 'c1', false, 'ok')], 5);
    expect(flipped.chats[0]?.updatedAt).toBe(5);
  });

  it('leaves a chat alone when its calls match', () => {
    const answer = { ...assistantMessage('a1'), calls: [call] };
    const base = saveChat(emptyLibrary, 'c1', [question, answer], 1);
    expect(saveChat(base, 'c1', [question, { ...answer, calls: [{ ...call }] }], 2)).toBe(base);
  });
});
