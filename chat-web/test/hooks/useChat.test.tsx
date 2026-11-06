import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useChat } from '../../src/hooks/useChat';
import type { FetchLike } from '../../src/api/chatClient';
import { emptyConversation } from '../../src/chat/conversation';
import type { Conversation } from '../../src/chat/conversation';
import { userMessage } from '../../src/chat/message';

const encoder = new TextEncoder();

function sseResponse(payloads: readonly string[]): Response {
  return new Response(encoder.encode(payloads.join('')), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function contentChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
}

function reasoningChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: text } }] })}\n\n`;
}

const done = 'data: [DONE]\n\n';

function fetchOf(payloads: readonly string[]): FetchLike {
  return async () => sseResponse(payloads);
}

const settings = { model: 'alias', origin: 'http://server.test' } as const;

// A fetch whose answer the test releases by hand, so the middle of a turn can be seen.
function heldFetch(): {
  readonly fetchImpl: FetchLike;
  readonly release: (payloads: readonly string[]) => void;
} {
  let resolve: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolveResponse) => {
    resolve = resolveResponse;
  });
  return {
    fetchImpl: async () => pending,
    release: (payloads) => {
      resolve(sseResponse(payloads));
    },
  };
}

function ask(fetchImpl: FetchLike) {
  return renderHook(() => useChat({ ...settings, fetchImpl }));
}

describe('useChat', () => {
  it('starts with an empty transcript and no turn in progress', () => {
    const view = ask(fetchOf([done]));
    expect(view.result.current.conversation).toEqual(emptyConversation);
  });

  it('adds the question and an empty answer before the text arrives', async () => {
    const held = heldFetch();
    const view = ask(held.fetchImpl);

    await act(async () => {
      view.result.current.send('What is a redlock?');
    });
    expect(view.result.current.conversation.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(view.result.current.conversation.messages[1]?.text).toBe('');
    expect(view.result.current.conversation.streaming).toBe(true);

    held.release([contentChunk('a lock '), contentChunk('held by water'), done]);
    await waitFor(() => {
      expect(view.result.current.conversation.streaming).toBe(false);
    });
    expect(view.result.current.conversation.messages[1]?.text).toBe('a lock held by water');
  });

  it('keeps thinking and the answer in their own fields of the same message', async () => {
    const view = ask(fetchOf([reasoningChunk('ask simply '), contentChunk('short'), done]));

    await act(async () => {
      view.result.current.send('why');
    });
    await waitFor(() => {
      expect(view.result.current.conversation.streaming).toBe(false);
    });

    const assistant = view.result.current.conversation.messages[1];
    expect(assistant?.reasoning).toBe('ask simply ');
    expect(assistant?.text).toBe('short');
  });

  it('ignores a question with nothing in it', async () => {
    const view = ask(fetchOf([done]));

    await act(async () => {
      view.result.current.send('   ');
    });
    expect(view.result.current.conversation.messages).toEqual([]);
  });

  it('shows what the server said when the request fails', async () => {
    const view = ask(async () => new Response('model alias not found', { status: 404 }));

    await act(async () => {
      view.result.current.send('first');
    });
    await waitFor(() => {
      expect(view.result.current.conversation.error).toContain('model alias not found');
    });
    expect(view.result.current.conversation.streaming).toBe(false);
  });

  it('clears the old failure when the next question goes out', async () => {
    let attempts = 0;
    const view = ask(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('gone', { status: 503 })
        : sseResponse([contentChunk('answer'), done]);
    });

    await act(async () => {
      view.result.current.send('first');
    });
    await waitFor(() => {
      expect(view.result.current.conversation.error).toContain('gone');
    });

    await act(async () => {
      view.result.current.send('second');
    });
    expect(view.result.current.conversation.error).toBeNull();

    await waitFor(() => {
      expect(view.result.current.conversation.streaming).toBe(false);
    });
    // The failed turn left its question standing with no answer behind it, so the second
    // turn adds another question and its answer.
    expect(view.result.current.conversation.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'assistant',
    ]);
  });

  it('refuses a second question while the first is still being answered', async () => {
    const held = heldFetch();
    const view = ask(held.fetchImpl);

    await act(async () => {
      view.result.current.send('first');
    });
    expect(view.result.current.conversation.streaming).toBe(true);

    await act(async () => {
      view.result.current.send('second');
    });
    // Still the two entries of the first turn: the question and the answer in progress.
    expect(view.result.current.conversation.messages).toHaveLength(2);

    held.release([contentChunk('answer'), done]);
    await waitFor(() => {
      expect(view.result.current.conversation.streaming).toBe(false);
    });
    expect(view.result.current.conversation.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('ends the turn on stop, keeping the text that had arrived', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        stream = c;
      },
    });
    const fetchImpl: FetchLike = async (_input, init) => {
      init?.signal?.addEventListener('abort', () => {
        stream?.error(new DOMException('aborted', 'AbortError'));
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const view = ask(fetchImpl);

    await act(async () => {
      view.result.current.send('first');
    });
    stream?.enqueue(encoder.encode(contentChunk('partial ')));
    await waitFor(() => {
      expect(view.result.current.conversation.messages[1]?.text).toBe('partial ');
    });

    await act(async () => {
      view.result.current.stop();
    });
    await waitFor(() => {
      expect(view.result.current.conversation.streaming).toBe(false);
    });
    expect(view.result.current.conversation.messages[1]?.text).toBe('partial ');
    expect(view.result.current.conversation.messages[1]?.ending).toBe('stopped');
    expect(view.result.current.conversation.error).toBeNull();
  });

  it('reports each finished turn once, with the failure if there was one', async () => {
    const seen: { last: string | undefined; failure: string | null }[] = [];
    const onTurn = (conversation: Conversation, failure: string | null): void => {
      seen.push({ last: conversation.messages.at(-1)?.text, failure });
    };
    let refuse = false;
    const fetchImpl: FetchLike = async () =>
      refuse
        ? new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 })
        : sseResponse([contentChunk('done'), 'data: [DONE]\n\n']);
    const view = renderHook(() => useChat({ model: 'm', origin: '', fetchImpl, onTurn }));

    await act(async () => view.result.current.send('first'));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ last: 'done', failure: null });

    refuse = true;
    await act(async () => view.result.current.send('second'));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]?.failure).toBe('busy');
  });

  it('does not report a turn another chat replaced', async () => {
    const onTurn = vi.fn();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        stream = c;
      },
    });
    const view = renderHook(() =>
      useChat({ model: 'm', origin: '', fetchImpl: async () => new Response(body), onTurn }),
    );
    await act(async () => view.result.current.send('first'));
    act(() => view.result.current.load([userMessage('u1', 'other chat')]));
    stream?.close();
    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));
    await act(async () => undefined);
    expect(onTurn).not.toBeCalled();
  });

  it('asks again on retry, sending the question and not the old answer', async () => {
    const bodies: string[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(String(init?.body));
      return sseResponse([contentChunk(`answer ${bodies.length}`), 'data: [DONE]\n\n']);
    };
    const view = ask(fetchImpl);

    await act(async () => view.result.current.send('question'));
    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));
    await act(async () => view.result.current.retry());
    await waitFor(() => expect(view.result.current.conversation.messages[1]?.text).toBe('answer 2'));

    expect(JSON.parse(bodies[1] ?? '').messages).toEqual([{ role: 'user', content: 'question' }]);
    expect(view.result.current.conversation.messages).toHaveLength(2);
  });

  it('notes when the server cut the answer at its length limit', async () => {
    const finishing = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`;
    const view = ask(async () => sseResponse([contentChunk('cut'), finishing, 'data: [DONE]\n\n']));

    await act(async () => view.result.current.send('question'));
    await waitFor(() => expect(view.result.current.conversation.messages[1]?.ending).toBe('length'));
  });

  it('gives loaded messages ids that the next question cannot collide with', async () => {
    const view = ask(async () => sseResponse([contentChunk('new'), 'data: [DONE]\n\n']));

    act(() => view.result.current.load([{ ...userMessage('u1', 'old'), id: 'u1' }]));
    await act(async () => view.result.current.send('next'));
    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));

    const ids = view.result.current.conversation.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(view.result.current.conversation.messages[0]?.text).toBe('old');
  });

  it('drops text from a turn that another chat replaced', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        stream = c;
      },
    });
    const view = ask(async () => new Response(body));

    await act(async () => view.result.current.send('first'));
    act(() => view.result.current.load([userMessage('u1', 'other chat')]));
    stream?.enqueue(encoder.encode(contentChunk('late')));

    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));
    expect(view.result.current.conversation.messages.map((message) => message.text)).toEqual(['other chat']);
  });

  it('drops text from a turn the user reset', async () => {
    const held = heldFetch();
    const view = ask(held.fetchImpl);

    await act(async () => {
      view.result.current.send('first');
    });
    await act(async () => {
      view.result.current.reset();
    });
    expect(view.result.current.conversation.messages).toEqual([]);

    held.release([contentChunk('too late'), done]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.result.current.conversation.messages).toEqual([]);
  });

  it('starts a fresh transcript on reset, so the next question has no history', async () => {
    const held = heldFetch();
    const view = ask(held.fetchImpl);

    await act(async () => {
      view.result.current.send('first');
    });
    held.release([contentChunk('answer'), done]);
    await waitFor(() => {
      expect(view.result.current.conversation.streaming).toBe(false);
    });

    await act(async () => {
      view.result.current.reset();
    });
    expect(view.result.current.conversation).toEqual(emptyConversation);

    await act(async () => {
      view.result.current.send('second');
    });
    expect(view.result.current.conversation.messages[0]?.text).toBe('second');
  });
});
