import { describe, expect, it } from 'vitest';
import source from '../../../src/artifact/frame/lockdown.js?raw';

describe('lockdown', () => {
  it('parses', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('captures what it guards with before it deletes anything', () => {
    const captured = source.indexOf('var apply=Reflect.apply');
    const firstDelete = source.indexOf('delete o[k]');
    expect(captured).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeGreaterThan(captured);
    expect(source.indexOf('var ce=Document.prototype.createElement')).toBeLessThan(firstDelete);
  });

  it('refuses the tags that reach out and creates the default policy', () => {
    expect(source).toContain('iframe');
    expect(source).toContain("createPolicy('default'");
    expect(source).not.toContain('</script');
  });
});
