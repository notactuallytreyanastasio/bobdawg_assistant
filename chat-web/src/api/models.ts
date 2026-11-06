// The model listing is a name to show, an id to ask for and the context size to measure
// against, so a refused request or a body of the wrong shape answers with nothing instead
// of a failure the UI would have to explain. The page takes an empty answer as "not yet"
// and asks again.

import { platformFetch } from './chatClient';
import type { FetchLike } from './chatClient';

export type ModelListingOptions = {
  readonly origin: string;
  readonly fetchImpl?: FetchLike;
};

export type ModelInfo = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
};

type Listing = {
  readonly data?: readonly unknown[];
};

function infoOf(entry: unknown): ModelInfo | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { id, name, context_length: context } = entry as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly context_length?: unknown;
  };
  if (typeof id !== 'string') return null;
  return {
    id,
    name: typeof name === 'string' && name !== '' ? name : id,
    contextLength: typeof context === 'number' && context > 0 ? context : null,
  };
}

export async function fetchModels(options: ModelListingOptions): Promise<ModelInfo[]> {
  const send = options.fetchImpl ?? platformFetch;
  try {
    const response = await send(`${options.origin}/v1/models`);
    if (!response.ok) return [];
    const listing = (await response.json()) as Listing;
    const models: ModelInfo[] = [];
    for (const entry of listing.data ?? []) {
      const info = infoOf(entry);
      if (info !== null) models.push(info);
    }
    return models;
  } catch {
    return [];
  }
}
