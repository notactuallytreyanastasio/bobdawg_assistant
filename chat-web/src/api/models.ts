// The model listing is only ever a name to show in the header and an id to ask
// for, so a refused request or a body of the wrong shape answers with nothing
// instead of a failure the UI would have to explain.

import { platformFetch } from './chatClient';
import type { FetchLike } from './chatClient';

export type ModelListingOptions = {
  readonly origin: string;
  readonly fetchImpl?: FetchLike;
};

type Listing = {
  readonly data?: readonly unknown[];
};

function idOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const id = (entry as { readonly id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

export async function fetchModelIds(options: ModelListingOptions): Promise<string[]> {
  const send = options.fetchImpl ?? platformFetch;
  try {
    const response = await send(`${options.origin}/v1/models`);
    if (!response.ok) return [];
    const listing = (await response.json()) as Listing;
    const ids: string[] = [];
    for (const entry of listing.data ?? []) {
      const id = idOf(entry);
      if (id !== null) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}
