// The transcript in plain data: what a message is, and how it becomes a wire
// message. Nothing here touches React or fetch, so the rules the UI depends on
// are testable on their own.

export type Role = 'user' | 'assistant' | 'tool';

// Why an answer ended early, when it did. A finished answer has no ending to report:
// 'stopped' is the reader pressing Stop, 'length' is the server's token limit, 'gaveup' is a
// tool loop that ended with no working chart, and 'capped' is one whose last round ran clean
// with no round left for the model to look at the result or say anything about it.
export type Ending = 'stopped' | 'length' | 'gaveup' | 'capped';

// A call the model made. The arguments stay the raw text it wrote, because the server
// replays the conversation and a reparsed copy would differ from what was generated.
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

export type ToolOutcome = {
  readonly callId: string;
  readonly ok: boolean;
};

// What a finished turn cost, where the server and the clock could say. Any field can be
// null: a stopped stream never reaches the usage chunk.
export type TurnStats = {
  readonly outputTokens: number | null;
  readonly contextTokens: number | null;
  readonly tokensPerSecond: number | null;
  readonly thoughtMs: number | null;
};

export type ChatMessage = {
  readonly id: string;
  readonly role: Role;
  readonly text: string;
  // The reasoning channel the server keeps beside the answer. It is never sent
  // back and never shown as part of the answer.
  readonly reasoning: string;
  readonly ending: Ending | null;
  readonly stats: TurnStats | null;
  readonly calls: readonly ToolCall[];
  // Set on a tool message: which call it answers. Its text is what the model is told.
  readonly result: ToolOutcome | null;
  // Set on a question sent with Plot on. Only these texts ever reach a running chart.
  readonly plot: boolean;
};

export type WireToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
};

export type WireMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly tool_calls?: readonly WireToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

// ids are handed out by a sequence owned by the caller, so a test can say in
// advance what the transcript will contain.
export function idSequence(prefix: string): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `${prefix}${issued}`;
  };
}

const blank = { reasoning: '', ending: null, stats: null, calls: [], result: null } as const;

export function userMessage(id: string, text: string, plot = false): ChatMessage {
  return { ...blank, id, role: 'user', text, plot };
}

// A new answer starts empty: streaming fills it in, and toWireMessages drops it
// if nothing ever arrived.
export function assistantMessage(id: string): ChatMessage {
  return { ...blank, id, role: 'assistant', text: '', plot: false };
}

export function toolMessage(id: string, callId: string, ok: boolean, text: string): ChatMessage {
  return { ...blank, id, role: 'tool', text, result: { callId, ok }, plot: false };
}

// The tool messages straight after an assistant message, which are the only place its
// results can be: a server may reuse a call id in a later turn, so matching by id across
// the whole transcript could pair a call with an answer to a different one.
export function toolBlockAfter(messages: readonly ChatMessage[], index: number): readonly ChatMessage[] {
  const block: ChatMessage[] = [];
  for (const message of messages.slice(index + 1)) {
    if (message.role !== 'tool') break;
    block.push(message);
  }
  return block;
}

function wireCall(call: ToolCall): WireToolCall {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
}

// A call without its result, or a result without its call, is a conversation the server's
// template cannot render, and one is exactly what a stop or a closed tab leaves behind. So
// only complete pairs go out, and the rest of the message stands without them.
function wireAnswer(messages: readonly ChatMessage[], index: number, message: ChatMessage): WireMessage[] {
  const block = toolBlockAfter(messages, index);
  const pairs = message.calls.flatMap((call) => {
    const result = block.find((entry) => entry.result?.callId === call.id);
    return result === undefined ? [] : [{ call, result }];
  });
  if (pairs.length === 0) {
    return message.text === '' ? [] : [{ role: 'assistant', content: message.text }];
  }
  return [
    { role: 'assistant', content: message.text, tool_calls: pairs.map((pair) => wireCall(pair.call)) },
    ...pairs.map(({ call, result }): WireMessage => ({ role: 'tool', tool_call_id: call.id, content: result.text })),
  ];
}

// clip is what an assistant does to a long paste on its way to the model. The chart still
// gets all of it; the model only needs enough to see the shape.
export function toWireMessages(
  messages: readonly ChatMessage[],
  clip?: (text: string) => string,
): WireMessage[] {
  return messages.flatMap((message, index): WireMessage[] => {
    if (message.role === 'tool') return [];
    if (message.role === 'assistant') return wireAnswer(messages, index, message);
    const text = message.plot && clip !== undefined ? clip(message.text) : message.text;
    return [{ role: 'user', content: text }];
  });
}
