import { describe, expect, it } from 'vitest';
import { loadD3 } from '../../src/artifact/d3Source';

describe('loadD3', () => {
  it('brings the whole of D3 7 as text', async () => {
    const source = await loadD3();
    expect(source).toContain('7.9.2');
    expect(source).toContain('scaleLinear');
    expect(source.length).toBeGreaterThan(100_000);
  });
});
