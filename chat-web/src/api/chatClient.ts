// The seam to ds4-server's chat endpoint. fetch is supplied by the caller in
// tests and defaults to the platform one, so the request shape, the stream
// parsing and the failures are all checked without a server.

import { idSequence, toWireMessages } from '../chat/message';
import type { ChatMessage, ToolCall, WireMessage } from '../chat/message';
import { createSseScanner } from './sse';
import { createCallCollector } from './toolCalls';
import type { DeltaChannel } from '../chat/conversation';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type Delta = {
  readonly channel: DeltaChannel;
  readonly text: string;
};

export type ChatRequest = {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly chat_template_kwargs?: { readonly enable_thinking: boolean };
  readonly tools?: readonly WireTool[];
};

export type WireTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
};

// What an assistant adds to a request. None of it lives in the transcript: the prompt and
// the tool list belong to the request, so a chat saved with them replays without them.
export type Tooling = {
  readonly system: string;
  readonly tools: readonly WireTool[];
  readonly clip?: (text: string) => string;
};

export type Usage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
};

// How a stream ended. finish is the server's finish_reason, and stays null when the reader
// stopped before the server said one.
export type StreamOutcome = {
  readonly finish: string | null;
  readonly usage: Usage | null;
  readonly stopped: boolean;
  readonly calls: readonly ToolCall[];
};

export type ChatStreamOptions = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly origin: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
  readonly thinking?: boolean;
  readonly tooling?: Tooling;
  readonly nextCallId?: () => string;
  readonly onDelta: (delta: Delta) => void;
};

// A refusal from the server that still has a body to read: the class holds the HTTP
// status and the message, so the caller reports what the server said, not that something
// broke on the way.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The browser's fetch, reached through globalThis rather than the bare name: a caller
// that supplies fetchImpl never sees it, so the tests run without any network.
export const platformFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

// The chat endpoint answers with chat.completion.chunk objects; only the delta
// of the first choice matters to a text UI.
type Chunk = {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: unknown;
      readonly reasoning_content?: unknown;
      readonly tool_calls?: unknown;
    };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
};

// The request for one turn: the transcript as the server expects it, with stream turned
// on so the text arrives while it is produced, and usage asked for so the page can say
// what the turn cost. Thinking stays on the server's default unless the caller chooses.
export function buildChatRequest(
  model: string,
  messages: readonly ChatMessage[],
  thinking?: boolean,
  tooling?: Tooling,
): ChatRequest {
  const wire = toWireMessages(messages, tooling?.clip);
  const request: ChatRequest = {
    model,
    messages: tooling === undefined ? wire : [{ role: 'system', content: tooling.system }, ...wire],
    stream: true,
    stream_options: { include_usage: true },
    ...(tooling === undefined ? {} : { tools: tooling.tools }),
  };
  return thinking === undefined
    ? request
    : { ...request, chat_template_kwargs: { enable_thinking: thinking } };
}

// Stop is the user's, not the stream's. The button aborts the caller's signal, and the
// stream answers with an exception whose type depends on the environment and on where in
// the stream the abort landed, so an aborted signal is the whole test. A stop is not a
// failure to show: nothing gets reported.
export function stoppedHere(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function describeFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'the request failed without a message';
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function deltaOf(chunk: Chunk): Delta | null {
  const first = chunk.choices?.[0];
  const delta = first?.delta;
  if (delta === undefined) return null;
  // The two channels never share a chunk here, and one delta per chunk keeps the
  // order the server wrote them in.
  const reasoning = textOf(delta.reasoning_content);
  if (reasoning !== null) return { channel: 'reasoning', text: reasoning };
  const content = textOf(delta.content);
  if (content !== null) return { channel: 'content', text: content };
  return null;
}

function chunkOf(payload: string): Chunk | null {
  try {
    return JSON.parse(payload) as Chunk;
  } catch {
    return null;
  }
}

function usageOf(chunk: Chunk): Usage | null {
  const prompt = chunk.usage?.prompt_tokens;
  const completion = chunk.usage?.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  return { promptTokens: prompt, completionTokens: completion };
}

async function apiErrorOf(response: Response): Promise<ApiError> {
  const body = await response.text().catch(() => '');
  const serverMessage = serverMessageOf(body);
  if (serverMessage !== null) return new ApiError(response.status, serverMessage);
  const line = body.split('\n')[0]?.trim() ?? '';
  return new ApiError(
    response.status,
    line === '' ? `ds4-server responded ${response.status}` : `ds4-server responded ${response.status}: ${line}`,
  );
}

function serverMessageOf(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const error = (parsed as { readonly error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  return textOf((error as { readonly message?: unknown }).message);
}

export async function streamChat(options: ChatStreamOptions): Promise<StreamOutcome> {
  const send = options.fetchImpl ?? platformFetch;
  const request = buildChatRequest(options.model, options.messages, options.thinking, options.tooling);
  let finish: string | null = null;
  let usage: Usage | null = null;
  const collector = createCallCollector(options.nextCallId ?? idSequence('call-'));
  // A call that was still arriving when the reader stopped is only half a call.
  const outcome = (stopped: boolean): StreamOutcome => ({
    finish,
    usage,
    stopped,
    calls: stopped ? [] : collector.calls(),
  });

  let response: Response;
  try {
    // One origin, one request shape: the page's origin (or VITE_API_BASE) plus the
    // endpoint path, so the dev proxy can keep the request same-origin and out of any
    // CORS handshake.
    response = await send(`${options.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (reason) {
    if (stoppedHere(options.signal)) return outcome(true);
    throw reason;
  }

  if (!response.ok) throw await apiErrorOf(response);

  const body = response.body;
  if (body === null) return outcome(false);

  const scanner = createSseScanner();
  const reader = body.getReader();
  let sawDone = false;
  const report = (payload: string): boolean => {
    // [DONE] is the server's last word; anything after it is not our turn.
    if (payload === '[DONE]') {
      sawDone = true;
      return false;
    }
    const chunk = chunkOf(payload);
    if (chunk === null) return true;
    const delta = deltaOf(chunk);
    if (delta !== null) options.onDelta(delta);
    collector.push(chunk.choices?.[0]?.delta?.tool_calls);
    finish = textOf(chunk.choices?.[0]?.finish_reason) ?? finish;
    usage = usageOf(chunk) ?? usage;
    return true;
  };

  try {
    let finished = false;
    while (!finished) {
      const seen = await reader.read();
      if (seen.done) break;
      for (const payload of scanner.push(seen.value)) {
        if (!report(payload)) {
          finished = true;
          break;
        }
      }
    }
    if (!finished) {
      for (const payload of scanner.close()) {
        if (!report(payload)) break;
      }
    }
  } catch (reason) {
    if (stoppedHere(options.signal)) return outcome(true);
    throw reason;
  } finally {
    // Even after a stop mid-stream, the socket still wants closing.
    void reader.cancel().catch(() => undefined);
  }

  // Both of these used to read as a finished answer: the words simply ended.
  if (finish === 'error') throw new Error('the server ended this answer with an error');
  if (finish === null && !sawDone) throw new Error('the connection closed before the answer finished');
  return outcome(false);
}
