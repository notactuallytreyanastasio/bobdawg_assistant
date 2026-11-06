// What a tool is, and running one without letting it break the turn. Whatever goes wrong
// here is something the model should hear about, so every failure comes back as a result
// rather than an exception, and the call still gets the answer the server's template needs.

import type { WireTool } from '../api/chatClient';
import { TOOL_RESULT_CHARS } from '../artifact/limits';
import type { ChatMessage, ToolCall } from '../chat/message';

export type ToolResult = {
  readonly ok: boolean;
  readonly text: string;
  // The turn ends here: this is not something the model should try to repair.
  readonly fatal?: boolean;
};

export type ToolContext = {
  readonly callId: string;
  readonly messages: readonly ChatMessage[];
  readonly signal: AbortSignal;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  // How much of an answer the model gets, when that is not TOOL_RESULT_CHARS.
  readonly resultChars?: number;
  readonly run: (args: Readonly<Record<string, unknown>>, context: ToolContext) => Promise<ToolResult>;
};

// Enough for a first try and four repairs. A sixth request never goes out, so nothing the
// model asks for after this can run.
export const MAX_ROUNDS = 5;

// What the model is told about a call past the first in a reply. A round is one call: the
// reader agreed to one program, and the cap on rounds is only a cap if calls cannot pile up
// inside a round.
export const ONE_CALL_LINE = 'not run: one call per reply. Send it again if it is still wanted.';

// The page's own line, which goes above anything the running code wrote. The model has no other
// way to know what a call costs, and without this it spent whole turns on debug runs. The result
// of the last round reaches it only if the chat goes on, so the warning comes one round early.
export function roundLine(round: number, max: number, thing = 'chart'): string {
  if (round >= max) return `Round ${max} of ${max}: no rounds left.`;
  if (round === max - 1) {
    return `Round ${round} of ${max}: your next call is your last, and you will not see its result. Send the whole finished ${thing}, not a test.`;
  }
  return `Round ${round} of ${max}.`;
}

const STOPPED: ToolResult = { ok: false, text: 'stopped by the reader' };

export function toWireTools(tools: readonly ToolDefinition[]): readonly WireTool[] {
  return tools.map(({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
}

function argumentsOf(raw: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function stopOf(signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
  });
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : 'the tool failed without a message';
}

async function attempt(
  tools: readonly ToolDefinition[],
  call: ToolCall,
  context: ToolContext,
): Promise<ToolResult> {
  if (context.signal.aborted) return STOPPED;
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) {
    const known = tools.map((candidate) => candidate.name).join(', ');
    return { ok: false, text: `there is no tool called ${call.name}; the tools are: ${known}` };
  }
  const args = argumentsOf(call.arguments);
  if (args === null) {
    return { ok: false, text: 'the arguments were not a JSON object; send them again as one' };
  }
  try {
    // A stop answers straight away even if the tool never does.
    return await Promise.race([tool.run(args, context), stopOf(context.signal)]);
  } catch (reason) {
    return context.signal.aborted ? STOPPED : { ok: false, text: messageOf(reason) };
  }
}

export async function runToolCall(
  tools: readonly ToolDefinition[],
  call: ToolCall,
  context: ToolContext,
): Promise<ToolResult> {
  const result = await attempt(tools, call, context);
  const limit = tools.find((tool) => tool.name === call.name)?.resultChars ?? TOOL_RESULT_CHARS;
  if (result.text.length <= limit) return result;
  // The model has to know it did not see everything, or it reasons from half a file.
  const hidden = result.text.length - limit;
  return { ...result, text: `${result.text.slice(0, limit)}\n[cut here: ${hidden} more characters not shown]` };
}
