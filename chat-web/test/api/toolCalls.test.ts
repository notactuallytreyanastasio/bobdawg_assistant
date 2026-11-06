import { describe, expect, it } from 'vitest';
import { createCallCollector } from '../../src/api/toolCalls';

const fallback = () => {
  let issued = 0;
  return () => {
    issued += 1;
    return `made-${issued}`;
  };
};

describe('createCallCollector', () => {
  it('reads a call that arrives whole', () => {
    const collector = createCallCollector(fallback());
    collector.push([{ index: 0, id: 'c1', type: 'function', function: { name: 'plot', arguments: '{"code":"x"}' } }]);
    expect(collector.calls()).toEqual([{ id: 'c1', name: 'plot', arguments: '{"code":"x"}' }]);
  });

  it('joins fragments by index, and takes id and name when they were sent once', () => {
    const collector = createCallCollector(fallback());
    collector.push([{ index: 0, id: 'c1', function: { name: 'plot', arguments: '{"co' } }]);
    collector.push([{ index: 0, function: { arguments: 'de":' } }]);
    collector.push([{ index: 0, function: { arguments: '"x"}' } }]);
    expect(collector.calls()).toEqual([{ id: 'c1', name: 'plot', arguments: '{"code":"x"}' }]);
  });

  it('does not double a name or id that is repeated', () => {
    const collector = createCallCollector(fallback());
    collector.push([{ index: 0, id: 'c1', function: { name: 'plot', arguments: 'a' } }]);
    collector.push([{ index: 0, id: 'c1', function: { name: 'plot', arguments: 'b' } }]);
    expect(collector.calls()).toEqual([{ id: 'c1', name: 'plot', arguments: 'ab' }]);
  });

  it('keeps interleaved calls apart, in index order', () => {
    const collector = createCallCollector(fallback());
    collector.push([{ index: 1, id: 'c2', function: { name: 'b', arguments: '2' } }]);
    collector.push([{ index: 0, id: 'c1', function: { name: 'a', arguments: '1' } }]);
    collector.push([{ index: 1, function: { arguments: '2' } }]);
    expect(collector.calls().map((call) => call.id)).toEqual(['c1', 'c2']);
    expect(collector.calls()[1]?.arguments).toBe('22');
  });

  it('makes each missing id unique', () => {
    const collector = createCallCollector(fallback());
    collector.push([
      { index: 0, function: { name: 'plot', arguments: '{}' } },
      { index: 1, function: { name: 'plot', arguments: '{}' } },
    ]);
    expect(collector.calls().map((call) => call.id)).toEqual(['made-1', 'made-2']);
    expect(collector.calls().map((call) => call.id)).toEqual(['made-1', 'made-2']);
  });

  it('uses the position when the index is missing', () => {
    const collector = createCallCollector(fallback());
    collector.push([{ id: 'c1', function: { name: 'a', arguments: '1' } }, { id: 'c2', function: { name: 'b', arguments: '2' } }]);
    expect(collector.calls().map((call) => call.id)).toEqual(['c1', 'c2']);
  });

  it('passes over junk', () => {
    const collector = createCallCollector(fallback());
    collector.push('nope');
    collector.push([null, 7, { index: 'x' }]);
    collector.push(undefined);
    expect(collector.calls()).toEqual([]);
  });
});
