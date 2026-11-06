// The transcript in plain data: what a message is, and how it becomes a wire
// message. Nothing here touches React or fetch, so the rules the UI depends on
// are testable on their own.

export type Role = 'user' | 'assistant';

// Why an answer ended early, when it did. A finished answer has no ending to report:
// 'stopped' is the reader pressing Stop, 'length' is the server's token limit.
export type Ending = 'stopped' | 'length';

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
};

export type WireMessage = {
  readonly role: Role;
  readonly content: string;
};

// ids are handed out by a sequence owned by the caller, so a test can say in
// advance what the transcript will contain.
export function idSequence(prefix: string): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `${prefix}${issued}`;
  };
}

export function userMessage(id: string, text: string): ChatMessage {
  return { id, role: 'user', text, reasoning: '', ending: null, stats: null };
}

// A new answer starts empty: streaming fills it in, and toWireMessages drops it
// if nothing ever arrived.
export function assistantMessage(id: string): ChatMessage {
  return { id, role: 'assistant', text: '', reasoning: '', ending: null, stats: null };
}

export function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.text !== '')
    .map((message) => ({ role: message.role, content: message.text }));
}
