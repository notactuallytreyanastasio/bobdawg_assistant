import { describe, expect, it, vi } from 'vitest';
import { fetchModelIds } from '../../src/api/models';
import type { FetchLike } from '../../src/api/chatClient';

function jsonListing(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchModelIds', () => {
  it('keeps the loaded models in the order the server listed them', async () => {
    const fetchImpl: FetchLike = async () => jsonListing({ data: [{ id: 'deepseek-v4-flash' }, { id: 'other' }] });
    expect(await fetchModelIds({ origin: '', fetchImpl })).toEqual(['deepseek-v4-flash', 'other']);
  });

  it('skips entries that carry no usable id', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonListing({ data: [{ id: 'good' }, { id: 7 }, { id: undefined }, {}, { object: 'model' }] });
    expect(await fetchModelIds({ origin: '', fetchImpl })).toEqual(['good']);
  });

  it('gives nothing when the listing is empty or malformed', async () => {
    const empty: FetchLike = async () => jsonListing({ data: [] });
    const noData: FetchLike = async () => jsonListing({});
    const broken: FetchLike = async () => new Response('not json', { status: 200 });
    expect(await fetchModelIds({ origin: '', fetchImpl: empty })).toEqual([]);
    expect(await fetchModelIds({ origin: '', fetchImpl: noData })).toEqual([]);
    expect(await fetchModelIds({ origin: '', fetchImpl: broken })).toEqual([]);
  });

  it('gives nothing when the server refuses the request, without throwing', async () => {
    const fetchImpl: FetchLike = async () => new Response('unavailable', { status: 500 });
    expect(await fetchModelIds({ origin: '', fetchImpl })).toEqual([]);
  });

  it('asks the models endpoint with a plain GET, on the configured origin', async () => {
    const calls: { input: string; method: string | undefined }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input: String(input), method: init?.method });
      return jsonListing({ data: [{ id: 'alias' }] });
    };

    expect(await fetchModelIds({ origin: 'http://127.0.0.1:9000', fetchImpl })).toEqual(['alias']);
    expect(calls).toEqual([{ input: 'http://127.0.0.1:9000/v1/models', method: undefined }]);

    calls.length = 0;
    expect(await fetchModelIds({ origin: '', fetchImpl })).toEqual(['alias']);
    expect(calls).toEqual([{ input: '/v1/models', method: undefined }]);
  });

  it('falls back to the platform fetch when no implementation is supplied', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: string) => {
        seen.push(String(input));
        return jsonListing({ data: [{ id: 'alias' }] });
      },
    );

    expect(await fetchModelIds({ origin: '' })).toEqual(['alias']);
    expect(seen).toEqual(['/v1/models']);
    vi.unstubAllGlobals();
  });
});
