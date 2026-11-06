// The page's side of a workspace: ask ds4-server for one, and send it tool calls. Where they
// run and how that is held is the server's business, in ds4_workspace.h. What comes back was
// written inside a sandbox, so it is read as a claim and used only as text for the model.

import { platformFetch } from './chatClient';
import type { FetchLike } from './chatClient';

export type WorkspaceAnswer = {
  readonly ok: boolean;
  readonly text: string;
};

const WORKSPACE_ID = /^[0-9a-f]{32}$/;

export const NO_WORKSPACES = 'this server has no workspaces: start it with --workspaces on, with Docker running';

function post(send: FetchLike, url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function createWorkspace(origin: string, fetchImpl?: FetchLike): Promise<string | null> {
  try {
    const response = await post(fetchImpl ?? platformFetch, `${origin}/chat/workspace`, {});
    if (!response.ok) return null;
    const { id } = (await response.json()) as { readonly id?: unknown };
    return typeof id === 'string' && WORKSPACE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function isWorkspaceId(value: string | null): value is string {
  return value !== null && WORKSPACE_ID.test(value);
}

export type WorkspaceCall = {
  readonly origin: string;
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly fetchImpl?: FetchLike;
};

function answerOf(value: unknown): WorkspaceAnswer {
  if (typeof value !== 'object' || value === null) return { ok: false, text: 'the sandbox gave no usable answer' };
  const { ok, text } = value as { readonly ok?: unknown; readonly text?: unknown };
  if (typeof ok !== 'boolean' || typeof text !== 'string') return { ok: false, text: 'the sandbox gave no usable answer' };
  return { ok, text };
}

export async function runInWorkspace(call: WorkspaceCall): Promise<WorkspaceAnswer> {
  const { origin, id, tool, args, signal } = call;
  const response = await post(call.fetchImpl ?? platformFetch, `${origin}/chat/workspace/run`, { id, tool, args }, signal);
  if (response.status === 404) return { ok: false, text: NO_WORKSPACES };
  if (response.status === 429) return { ok: false, text: 'the sandbox is busy with too many calls; try again' };
  if (!response.ok) return { ok: false, text: `the sandbox call failed with status ${response.status}` };
  try {
    return answerOf(await response.json());
  } catch {
    return { ok: false, text: 'the sandbox gave no usable answer' };
  }
}
