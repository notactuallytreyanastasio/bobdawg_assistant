// Handing a finished page to ds4-server, which keeps it and answers with where. The document
// goes up whole, D3 and data included, so a link needs nothing from the chat that made it. The
// server trusts none of it: ds4_share.h says how a shared page is held.

import { platformFetch } from './chatClient';
import type { FetchLike } from './chatClient';
import { sharedDocument } from '../artifact/document';
import { loadD3 } from '../artifact/d3Source';
import type { Artifact } from '../chat/artifact';

export type ShareResult =
  | { readonly kind: 'shared'; readonly url: string }
  // A server started without --share-dir, which is a setting and not a failure.
  | { readonly kind: 'off' }
  | { readonly kind: 'full' }
  | { readonly kind: 'large' }
  | { readonly kind: 'failed' };

export type ShareOptions = {
  readonly origin: string;
  readonly artifact: Artifact;
  readonly fetchImpl?: FetchLike;
  readonly d3?: () => Promise<string>;
};

const SHARED_PATH = /^\/chat\/shared\/[0-9a-f]{32}$/;

function pathOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { path } = body as { readonly path?: unknown };
  return typeof path === 'string' && SHARED_PATH.test(path) ? path : null;
}

export async function sharePage(options: ShareOptions): Promise<ShareResult> {
  const { origin, artifact } = options;
  const send = options.fetchImpl ?? platformFetch;
  try {
    const d3 = await (options.d3 ?? loadD3)();
    const response = await send(`${origin}/chat/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: artifact.title,
        page: sharedDocument({ code: artifact.code, messages: artifact.messages, d3 }),
      }),
    });
    if (response.status === 404) return { kind: 'off' };
    if (response.status === 507) return { kind: 'full' };
    if (response.status === 413) return { kind: 'large' };
    if (!response.ok) return { kind: 'failed' };
    const path = pathOf(await response.json());
    if (path === null) return { kind: 'failed' };
    // A page served from one origin and asking another still gets a link that opens.
    return { kind: 'shared', url: `${origin === '' ? window.location.origin : origin}${path}` };
  } catch {
    return { kind: 'failed' };
  }
}
