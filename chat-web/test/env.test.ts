import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiOrigin } from '../src/env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('apiOrigin', () => {
  it('stays on the page origin when nothing was configured', () => {
    expect(apiOrigin()).toBe('');
  });

  it('uses the configured server origin', () => {
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:9000');
    expect(apiOrigin()).toBe('http://127.0.0.1:9000');
  });

  it('drops a trailing slash so paths join cleanly', () => {
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:9000/');
    expect(apiOrigin()).toBe('http://127.0.0.1:9000');
  });

  it('treats a blank setting as no setting', () => {
    vi.stubEnv('VITE_API_BASE', '   ');
    expect(apiOrigin()).toBe('');
  });

  it('reads the setting on every call, so a rebuild is not needed', () => {
    vi.stubEnv('VITE_API_BASE', 'http://first');
    expect(apiOrigin()).toBe('http://first');
    vi.stubEnv('VITE_API_BASE', 'http://second');
    expect(apiOrigin()).toBe('http://second');
  });
});
