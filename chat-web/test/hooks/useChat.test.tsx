import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useChat } from '../../src/hooks/useChat';
import type { FetchLike } from '../../src/api/chatClient';
import { emptyConversation } from '../../src/chat/conversation';
import type { Conversation } from '../../src/chat/conversation';
import { toolMessage, assistantMessage, userMessage } from '../../src/chat/message';
import type { ChatMessage } from '../../src/chat/message';
import type { ChatConfig } from '../../src/hooks/useChat';
import type { Assistant } from '../../src/tools/assistant';
import { MAX_ROUNDS, roundLine } from '../../src/tools/tool';
import type { ToolResult } from '../../src/tools/tool';

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

describe('the tool loop', () => {
  type Body = { readonly messages: readonly Record<string, unknown>[]; readonly tools?: unknown };

  const callChunk = (id: string, code = 'draw()') =>
    `data: ${JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'plot', arguments: JSON.stringify({ code }) } }] },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`;
  const lengthCut = `data: ${JSON.stringify({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'plot', arguments: '{"co' } }] },
        finish_reason: 'length',
      },
    ],
  })}\n\n`;
  const finished = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;

  // A server that answers each request with the next script, and keeps what it was sent.
  function scripted(rounds: readonly (readonly string[])[]) {
    const bodies: Body[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return sseResponse(rounds[bodies.length - 1] ?? [contentChunk('more'), finished, done]);
    };
    return { fetchImpl, bodies };
  }

  type Ran = { readonly code: unknown; readonly messages: readonly ChatMessage[] };

  function assistantOf(run: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<ToolResult>) {
    const ran: Ran[] = [];
    const assistant: Assistant = {
      id: 'plot',
      label: 'Plot',
      system: 'draw',
      tools: [
        {
          name: 'plot',
          description: 'd',
          parameters: {},
          run: (args, context) => {
            ran.push({ code: args['code'], messages: context.messages });
            return run(args, context.signal);
          },
        },
      ],
    };
    return { assistant, ran };
  }

  const good = async (): Promise<ToolResult> => ({ ok: true, text: 'ok: drew 1 svg' });
  const bad = async (): Promise<ToolResult> => ({ ok: false, text: 'error: D3 is not defined' });

  function mount(config: Partial<ChatConfig> & { readonly fetchImpl: FetchLike }) {
    const turns: (string | null)[] = [];
    const view = renderHook(() =>
      useChat({ ...settings, onTurn: (_conversation, failure) => turns.push(failure), ...config }),
    );
    return { view, turns };
  }

  const settled = async (view: ReturnType<typeof mount>['view']) => {
    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));
  };

  const shape = (messages: readonly ChatMessage[]) => messages.map((message) => message.role);

  it('sends the prompt and tools, and marks the question as Plot', async () => {
    const server = scripted([[contentChunk('no chart'), finished, done]]);
    const { assistant } = assistantOf(good);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(server.bodies[0]?.messages[0]).toEqual({ role: 'system', content: 'draw' });
    expect(server.bodies[0]?.tools).toBeDefined();
    expect(view.result.current.conversation.messages[0]?.plot).toBe(true);
  });

  it('sends neither without an assistant', async () => {
    const server = scripted([[contentChunk('hi'), finished, done]]);
    const { view } = mount({ fetchImpl: server.fetchImpl });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(server.bodies[0]?.tools).toBeUndefined();
    expect(view.result.current.conversation.messages[0]?.plot).toBe(false);
  });

  it('does not run a call the server sent to plain chat', async () => {
    const server = scripted([[callChunk('c1'), done]]);
    const { view } = mount({ fetchImpl: server.fetchImpl });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(view.result.current.conversation.messages[1]?.calls).toEqual([]);
  });

  it('runs a call, tells the model, and finishes on its answer', async () => {
    const server = scripted([[callChunk('c1'), done], [contentChunk('A chart.'), finished, done]]);
    const { assistant, ran } = assistantOf(good);
    const { view, turns } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(ran.map((entry) => entry.code)).toEqual(['draw()']);
    expect(shape(view.result.current.conversation.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(server.bodies[1]?.messages.slice(-2)).toMatchObject([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Round 1 of 5.\nok: drew 1 svg' },
    ]);
    expect(turns).toEqual([null]);
  });

  it('repairs: a failure goes back and the next code succeeds', async () => {
    const server = scripted([
      [callChunk('c1', 'D3.svg()'), done],
      [callChunk('c2', 'd3.select(root)'), done],
      [contentChunk('Fixed.'), finished, done],
    ]);
    let attempts = 0;
    const { assistant, ran } = assistantOf(async () => {
      attempts += 1;
      return attempts === 1 ? bad() : good();
    });
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(ran.map((entry) => entry.code)).toEqual(['D3.svg()', 'd3.select(root)']);
    expect(server.bodies).toHaveLength(3);
    expect(view.result.current.conversation.messages.at(-1)?.text).toBe('Fixed.');
    expect(view.result.current.conversation.messages.at(-1)?.ending).toBeNull();
  });

  it('gives up at the cap, and never asks again', async () => {
    const server = scripted(Array.from({ length: MAX_ROUNDS + 2 }, (_, index) => [callChunk(`c${index}`), done]));
    const { assistant, ran } = assistantOf(bad);
    const { view, turns } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(server.bodies).toHaveLength(MAX_ROUNDS);
    expect(ran).toHaveLength(MAX_ROUNDS);
    const messages = view.result.current.conversation.messages;
    expect(messages.findLast((message) => message.role === 'assistant')?.ending).toBe('gaveup');
    expect(turns).toEqual([null]);
  });

  it('says it ran out of rounds at the cap when the last result was ok', async () => {
    const server = scripted(Array.from({ length: MAX_ROUNDS }, (_, index) => [callChunk(`c${index}`), done]));
    const { assistant } = assistantOf(good);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    const messages = view.result.current.conversation.messages;
    expect(messages.findLast((message) => message.role === 'assistant')?.ending).toBe('capped');
  });

  it('tells the model each round what it has spent, above anything the code wrote', async () => {
    const server = scripted(Array.from({ length: MAX_ROUNDS }, (_, index) => [callChunk(`c${index}`), done]));
    const { assistant } = assistantOf(bad);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    const answers = view.result.current.conversation.messages.filter((message) => message.role === 'tool');
    expect(answers.map((message) => message.text.split('\n')[0])).toEqual(
      answers.map((_, index) => roundLine(index + 1, MAX_ROUNDS)),
    );
    expect(answers[0]?.text.split('\n')[1]).toBe('error: D3 is not defined');
  });

  it('warns the model before its last call, in the request that makes it', async () => {
    const server = scripted(Array.from({ length: MAX_ROUNDS }, (_, index) => [callChunk(`c${index}`), done]));
    const { assistant } = assistantOf(bad);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    const heard = server.bodies.at(-1)?.messages.filter((message) => message['role'] === 'tool').at(-1);
    expect(String(heard?.['content'])).toContain('your next call is your last');
  });

  it('gives up when the model goes quiet after a failed attempt', async () => {
    const server = scripted([[callChunk('c1'), done], [finished, done]]);
    const { assistant } = assistantOf(bad);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(view.result.current.conversation.messages.at(-1)?.ending).toBe('gaveup');
  });

  it('takes the words of a model that explains a failed attempt as its answer', async () => {
    const server = scripted([[callChunk('c1'), done], [contentChunk('I could not read it.'), finished, done]]);
    const { assistant } = assistantOf(bad);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(view.result.current.conversation.messages.at(-1)?.ending).toBeNull();
  });

  it('never runs a call the length limit cut off', async () => {
    const server = scripted([[lengthCut, done]]);
    const { assistant, ran } = assistantOf(good);
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(ran).toEqual([]);
    expect(view.result.current.conversation.messages.at(-1)?.ending).toBe('length');
    expect(view.result.current.conversation.messages.at(-1)?.calls).toEqual([]);
  });

  it('stays streaming while a tool runs, so nothing else can be sent', async () => {
    const server = scripted([[callChunk('c1'), done], [contentChunk('ok'), finished, done]]);
    let release: (result: ToolResult) => void = () => undefined;
    const { assistant } = assistantOf(() => new Promise((resolve) => (release = resolve)));
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await waitFor(() => expect(view.result.current.conversation.messages[1]?.calls).toHaveLength(1));
    expect(view.result.current.conversation.streaming).toBe(true);
    act(() => view.result.current.send('another'));
    expect(view.result.current.conversation.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    await act(async () => release({ ok: true, text: 'ok' }));
    await settled(view);
  });

  it('stop while the model streams a repair ends the turn stopped', async () => {
    const pending = new Promise<Response>(() => undefined);
    let requests = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      requests += 1;
      if (requests === 1) return sseResponse([callChunk('c1'), done]);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        void pending;
      });
    };
    const { assistant } = assistantOf(bad);
    const { view, turns } = mount({ fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await waitFor(() => expect(requests).toBe(2));
    act(() => view.result.current.stop());
    await settled(view);
    expect(shape(view.result.current.conversation.messages)).toEqual(['user', 'assistant', 'tool']);
    expect(view.result.current.conversation.messages[1]?.ending).toBe('stopped');
    expect(turns).toEqual([null]);
  });

  it('stop at the Run prompt writes the result and ends, with the pair complete', async () => {
    const server = scripted([[callChunk('c1'), done]]);
    // A tool that waits for a grant which never comes, as the runner does.
    const { assistant } = assistantOf((_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('declined')));
    }));
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await waitFor(() => expect(view.result.current.conversation.messages[1]?.calls).toHaveLength(1));
    act(() => view.result.current.stop());
    await settled(view);
    const messages = view.result.current.conversation.messages;
    expect(messages.at(-1)).toMatchObject({ role: 'tool', text: 'stopped by the reader', result: { callId: 'c1', ok: false } });
    expect(messages[1]?.ending).toBe('stopped');
    expect(server.bodies).toHaveLength(1);
  });

  it('stop while running does the same, and asks the model nothing more', async () => {
    const server = scripted([[callChunk('c1'), done]]);
    const { assistant } = assistantOf(() => new Promise(() => undefined));
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await waitFor(() => expect(view.result.current.conversation.messages[1]?.calls).toHaveLength(1));
    act(() => view.result.current.stop());
    await settled(view);
    expect(view.result.current.conversation.messages.at(-1)?.result?.ok).toBe(false);
    expect(server.bodies).toHaveLength(1);
  });

  it.each(['reset', 'load'] as const)('%s mid-tool drops the turn silently', async (how) => {
    const server = scripted([[callChunk('c1'), done]]);
    let release: (result: ToolResult) => void = () => undefined;
    const { assistant } = assistantOf(() => new Promise((resolve) => (release = resolve)));
    const { view, turns } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await waitFor(() => expect(view.result.current.conversation.messages[1]?.calls).toHaveLength(1));
    act(() => (how === 'reset' ? view.result.current.reset() : view.result.current.load([userMessage('u9', 'other')])));
    await act(async () => release({ ok: true, text: 'late' }));
    const messages = view.result.current.conversation.messages;
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
    expect(view.result.current.conversation.streaming).toBe(false);
    expect(turns).toEqual([]);
    expect(server.bodies).toHaveLength(1);
  });

  it('a failure in round two keeps the first round standing', async () => {
    let requests = 0;
    const fetchImpl: FetchLike = async () => {
      requests += 1;
      if (requests === 1) return sseResponse([callChunk('c1'), done]);
      throw new Error('server gone');
    };
    const { assistant } = assistantOf(good);
    const { view, turns } = mount({ fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(view.result.current.conversation.error).toBe('server gone');
    expect(shape(view.result.current.conversation.messages)).toEqual(['user', 'assistant', 'tool']);
    expect(turns).toEqual(['server gone']);
  });

  it('a fatal result ends the turn as gave up, with a banner, and no repair', async () => {
    const server = scripted([[callChunk('c1'), done]]);
    const { assistant } = assistantOf(async () => ({ ok: false, text: 'it left', fatal: true }));
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(view.result.current.conversation.messages[1]?.ending).toBe('gaveup');
    expect(view.result.current.conversation.error).toBe('it left');
    expect(server.bodies).toHaveLength(1);
  });

  it('answers the other calls in a round after a fatal one without running them', async () => {
    const two = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'c1', function: { name: 'plot', arguments: '{"code":"a"}' } },
              { index: 1, id: 'c2', function: { name: 'plot', arguments: '{"code":"b"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`;
    const server = scripted([[two, done]]);
    const { assistant, ran } = assistantOf(async () => ({ ok: false, text: 'it left', fatal: true }));
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(ran).toHaveLength(1);
    const results = view.result.current.conversation.messages.filter((message) => message.role === 'tool');
    expect(results.map((message) => message.result?.callId)).toEqual(['c1', 'c2']);
  });

  // A round is one call. Otherwise a reply holding sixty calls runs sixty programs under one
  // Run, and the cap on rounds caps nothing.
  it('runs one call in a round and answers the rest without running them', async () => {
    const many = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: Array.from({ length: 60 }, (_, index) => ({
              index,
              id: `c${index}`,
              function: { name: 'plot', arguments: '{"code":"a"}' },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`;
    const server = scripted([[many, done], [contentChunk('drawn'), done]]);
    const { assistant, ran } = assistantOf(async () => ({ ok: true, text: 'ok: drew 1 svg' }));
    const { view } = mount({ fetchImpl: server.fetchImpl, assistant });
    act(() => view.result.current.send('data'));
    await settled(view);
    expect(ran).toHaveLength(1);
    const results = view.result.current.conversation.messages.filter((message) => message.role === 'tool');
    expect(results).toHaveLength(60);
    expect(results[0]?.result?.ok).toBe(true);
    expect(results[1]?.text).toContain('not run');
    // What the round comes to is the call that ran, so the rest cannot read as a failed chart.
    expect(view.result.current.conversation.messages.at(-1)?.ending).toBeNull();
  });

  it('replays an old call on a later turn, with no tools', async () => {
    const server = scripted([[contentChunk('sure'), finished, done]]);
    const saved: readonly ChatMessage[] = [
      userMessage('u1', 'data', true),
      { ...assistantMessage('a1'), calls: [{ id: 'c1', name: 'plot', arguments: '{"code":  "x"}' }] },
      toolMessage('t1', 'c1', true, 'ok'),
      { ...assistantMessage('a2'), text: 'A chart.' },
    ];
    const { view } = mount({ fetchImpl: server.fetchImpl, initialMessages: saved });
    act(() => view.result.current.send('make it a line chart'));
    await settled(view);
    const roles = server.bodies[0]?.messages.map((message) => message['role']);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(JSON.stringify(server.bodies[0]?.messages[1])).toContain(String.raw`{\"code\":  \"x\"}`);
    expect(server.bodies[0]?.tools).toBeUndefined();
  });

  it('says when a turn begins, once per turn', async () => {
    const server = scripted([[contentChunk('a'), finished, done], [contentChunk('b'), finished, done]]);
    let began = 0;
    const { view } = mount({ fetchImpl: server.fetchImpl, onBegin: () => (began += 1) });
    act(() => view.result.current.send('one'));
    await settled(view);
    act(() => view.result.current.retry());
    await settled(view);
    expect(began).toBe(2);
  });

  it('retries with the Plot setting of the moment', async () => {
    const server = scripted([[contentChunk('a'), finished, done], [contentChunk('b'), finished, done]]);
    const { assistant } = assistantOf(good);
    const view = renderHook((props: { readonly on: boolean }) =>
      useChat({ ...settings, fetchImpl: server.fetchImpl, assistant: props.on ? assistant : null }), {
      initialProps: { on: false },
    });
    act(() => view.result.current.send('data'));
    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));
    view.rerender({ on: true });
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.conversation.streaming).toBe(false));
    expect(view.result.current.conversation.messages[0]?.plot).toBe(true);
  });
});
