// The page's side of the decision graph. The token stays with ds4-server, which answers these
// from the deciduous server inside this repository's workspace.

import { platformFetch } from './chatClient';
import type { FetchLike } from './chatClient';

export type GraphTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
};

export type GraphAnswer = {
  readonly ok: boolean;
  readonly text: string;
};

function post(send: FetchLike, url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

function toolOf(value: unknown): GraphTool | null {
  if (typeof value !== 'object' || value === null) return null;
  const { name, description, inputSchema } = value as Readonly<Record<string, unknown>>;
  if (typeof name !== 'string' || name === '') return null;
  return {
    name,
    description: typeof description === 'string' ? description : '',
    parameters:
      typeof inputSchema === 'object' && inputSchema !== null
        ? (inputSchema as Readonly<Record<string, unknown>>)
        : { type: 'object', properties: {} },
  };
}

export async function listGraphTools(origin: string, fetchImpl?: FetchLike): Promise<readonly GraphTool[]> {
  try {
    const response = await post(fetchImpl ?? platformFetch, `${origin}/chat/graph/tools`, {});
    if (!response.ok) return [];
    const { tools } = (await response.json()) as { readonly tools?: unknown };
    return Array.isArray(tools) ? tools.flatMap((tool) => toolOf(tool) ?? []) : [];
  } catch {
    return [];
  }
}

export async function callGraphTool(
  origin: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  fetchImpl?: FetchLike,
): Promise<GraphAnswer> {
  try {
    const response = await post(fetchImpl ?? platformFetch, `${origin}/chat/graph/call`, { tool, args }, signal);
    if (!response.ok) return { ok: false, text: `the server answered ${response.status}` };
    const { ok, text } = (await response.json()) as { readonly ok?: unknown; readonly text?: unknown };
    return { ok: ok === true, text: typeof text === 'string' ? text : '' };
  } catch (failure) {
    return { ok: false, text: failure instanceof Error ? failure.message : 'the graph did not answer' };
  }
}
