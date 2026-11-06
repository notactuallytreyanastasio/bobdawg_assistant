import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  buildChatRequest,
  describeFailure,
  streamChat,
  type FetchLike,
} from '../../src/api/chatClient';
import { assistantMessage, userMessage } from '../../src/chat/message';

const encoder = new TextEncoder();

function chunkOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function sseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunkOf(chunk));
      }
      controller.close();
    },
  });
}

function sseResponse(chunks: readonly string[]): Response {
  return new Response(sseBody(chunks), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function contentChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
}

function reasoningChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: text } }] })}\n\n`;
}

const conversation = [userMessage('u1', 'Explain Redis streams.'), { ...assistantMessage('a1'), text: 'earlier answer' }];

describe('buildChatRequest', () => {
  it('asks the model for a streamed answer built from role and content only', () => {
    expect(buildChatRequest('deepseek-v4-flash', conversation)).toEqual({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'Explain Redis streams.' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });
  });
});

describe('streamChat request', () => {
  it('posts the request body to the chat endpoint on the same origin', async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input: String(input), init });
      return sseResponse(['data: [DONE]\n\n']);
    };

    await streamChat({ model: 'deepseek-v4-flash', messages: [], origin: '', fetchImpl, onDelta: () => undefined });

    expect(calls[0]?.input).toBe('/v1/chat/completions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [],
    });
  });

  it('uses the configured origin when the page is not on the API host', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      seen.push(String(input));
      return sseResponse(['data: [DONE]\n\n']);
    };

    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: 'http://127.0.0.1:8000',
      fetchImpl,
      onDelta: () => undefined,
    });

    expect(seen).toEqual(['http://127.0.0.1:8000/v1/chat/completions']);
  });

  it('falls back to the platform fetch when no implementation is supplied', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: string) => {
        seen.push(String(input));
        return sseResponse(['data: [DONE]\n\n']);
      },
    );

    await streamChat({ model: 'alias', messages: [], origin: '', onDelta: () => undefined });

    expect(seen).toEqual(['/v1/chat/completions']);
    vi.unstubAllGlobals();
  });
});

describe('streamChat stream', () => {
  it('reports content deltas in order', async () => {
    const deltas: string[] = [];
    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () =>
        sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"A stream "}}]}\n\n', contentChunk('is a log.'), 'data: [DONE]\n\n']),
      onDelta: (delta) => {
        deltas.push(`${delta.channel}:${delta.text}`);
      },
    });
    expect(deltas).toEqual(['content:A stream ', 'content:is a log.']);
  });

  it('reports reasoning deltas on their own channel', async () => {
    const deltas: string[] = [];
    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => sseResponse([reasoningChunk('check the docs'), contentChunk('short answer'), 'data: [DONE]\n\n']),
      onDelta: (delta) => {
        deltas.push(`${delta.channel}:${delta.text}`);
      },
    });
    expect(deltas).toEqual(['reasoning:check the docs', 'content:short answer']);
  });

  it('survives a token split across two network chunks', async () => {
    let received = 0;
    const whole = encoder.encode(contentChunk('café'));
    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(whole.slice(0, whole.length - 6));
              controller.enqueue(whole.slice(whole.length - 6));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      onDelta: () => {
        received += 1;
      },
    });
    expect(received).toBe(1);
  });

  it('ignores the keepalives, the usage chunk and the finish chunk', async () => {
    const deltas: string[] = [];
    const chunks = [
      ': ping\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[]}\n\n',
      contentChunk('answer'),
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c2","choices":[],"usage":{"total_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    ];
    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => sseResponse(chunks),
      onDelta: (delta) => {
        deltas.push(delta.text);
      },
    });
    expect(deltas).toEqual(['answer']);
  });

  it('skips a payload that is not JSON instead of breaking the answer', async () => {
    const deltas: string[] = [];
    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => sseResponse(['data: not json\n\n', contentChunk('answer'), 'data: [DONE]\n\n']),
      onDelta: (delta) => {
        deltas.push(delta.text);
      },
    });
    expect(deltas).toEqual(['answer']);
  });

  it('stops reading at [DONE] and never waits for the socket', async () => {
    let opened = false;
    await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              opened = true;
              controller.enqueue(chunkOf('data: [DONE]\n\ndata: {"choices":[{"index":0,"delta":{"content":"too late"}}]}\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      onDelta: () => {
        throw new Error('nothing arrives after [DONE]');
      },
    });
    expect(opened).toBe(true);
  });
});

describe('streamChat failures', () => {
  it('reports the message the server chose for a rejected request', async () => {
    const failure = await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'model is busy' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      onDelta: () => undefined,
    }).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('model is busy');
    expect((failure as ApiError).status).toBe(429);
    expect(describeFailure(failure)).toBe('model is busy');
  });

  it('names the status when the server answers with plain text', async () => {
    const failure = await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => new Response('bad request line', { status: 400 }),
      onDelta: () => undefined,
    }).catch((reason: unknown) => reason);

    expect((failure as ApiError).message).toBe('ds4-server responded 400: bad request line');
  });

  it('names the status alone when the body is empty', async () => {
    const failure = await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => new Response('', { status: 503 }),
      onDelta: () => undefined,
    }).catch((reason: unknown) => reason);

    expect((failure as ApiError).message).toBe('ds4-server responded 503');
  });

  it('turns a broken network into a failure the user can read', async () => {
    const failure = await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => {
        throw new TypeError('Connection refused');
      },
      onDelta: () => undefined,
    }).catch((reason: unknown) => reason);

    expect(describeFailure(failure)).toBe('Connection refused');
  });

  it('still says something when the failure is not an error at all', async () => {
    const failure = await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () => {
        throw 'socket exploded';
      },
      onDelta: () => undefined,
    }).catch((reason: unknown) => reason);

    expect(describeFailure(failure)).toBe('socket exploded');
    expect(describeFailure({ object: 'no message here' })).toBe('the request failed without a message');
  });

  it('leaves nothing behind when the signal was aborted mid-stream', async () => {
    const controller = new AbortController();
    const texts: string[] = [];
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });
    controller.signal.addEventListener('abort', () => {
      streamController.error(new DOMException('aborted', 'AbortError'));
    });

    const promise = streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      signal: controller.signal,
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      onDelta: (delta) => {
        texts.push(delta.text);
        controller.abort();
      },
    });

    streamController.enqueue(chunkOf(contentChunk('partial ')));
    await expect(promise).resolves.toEqual({ finish: null, usage: null, stopped: true });
    expect(texts).toEqual(['partial ']);
  });

  it('reports a stream that died on its own without the user asking', async () => {
    const failure = await streamChat({
      model: 'alias',
      messages: conversation,
      origin: '',
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunkOf(contentChunk('partial ')));
              controller.error(new Error('socket closed'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      onDelta: () => undefined,
    }).catch((reason: unknown) => reason);

    expect(describeFailure(failure)).toBe('socket closed');
  });
});

describe('streamChat outcome', () => {
  const run = (payloads: readonly string[], thinking?: boolean) =>
    streamChat({
      model: 'alias',
      messages: [],
      origin: '',
      fetchImpl: async () => sseResponse(payloads),
      onDelta: () => undefined,
      ...(thinking === undefined ? {} : { thinking }),
    });
  const finishing = (reason: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 30 } })}\n\n`;

  it('reports the finish reason and the usage the server sent', async () => {
    const outcome = await run([finishing('length'), usage, 'data: [DONE]\n\n']);
    expect(outcome).toEqual({
      finish: 'length',
      usage: { promptTokens: 12, completionTokens: 30 },
      stopped: false,
    });
  });

  it('treats a finish reason of error as a failure, not a finished answer', async () => {
    await expect(run([finishing('error'), 'data: [DONE]\n\n'])).rejects.toThrow('ended this answer with an error');
  });

  it('treats a stream that closes with no ending as a failure', async () => {
    await expect(
      run([`data: ${JSON.stringify({ choices: [{ delta: { content: 'half a' } }] })}\n\n`]),
    ).rejects.toThrow('closed before the answer finished');
  });

  it('asks for thinking on or off only when told to', () => {
    expect(buildChatRequest('m', [], false).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(buildChatRequest('m', [], true).chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(buildChatRequest('m', []).chat_template_kwargs).toBeUndefined();
  });
});
