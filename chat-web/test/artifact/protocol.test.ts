import { describe, expect, it } from 'vitest';
import {
  ERROR_CHARS,
  HEIGHT_MAX,
  HEIGHT_MIN,
  LOG_CHARS,
  REPORT_TEXT_CHARS,
} from '../../src/artifact/limits';
import { parseFrameMessage } from '../../src/artifact/protocol';

const report = { kind: 'report', nodes: 5, svgs: 1, bbox: { w: 10, h: 20 }, marks: 2, nan: 0, text: 'hi' };

describe('parseFrameMessage', () => {
  it('reads the bare messages', () => {
    expect(parseFrameMessage({ kind: 'alive', extra: 1 })).toEqual({ kind: 'alive' });
    expect(parseFrameMessage({ kind: 'ready' })).toEqual({ kind: 'ready' });
  });

  it('reads an error and clamps it', () => {
    expect(parseFrameMessage({ kind: 'error', message: 'x'.repeat(9000), line: 4 })).toEqual({
      kind: 'error',
      message: 'x'.repeat(ERROR_CHARS),
      line: 4,
    });
  });

  it('takes a bad line as no line, and refuses a bad message', () => {
    expect(parseFrameMessage({ kind: 'error', message: 'm', line: 'x' })).toEqual({ kind: 'error', message: 'm', line: null });
    expect(parseFrameMessage({ kind: 'error', message: 'm', line: -2 })).toEqual({ kind: 'error', message: 'm', line: null });
    expect(parseFrameMessage({ kind: 'error', message: 7 })).toBeNull();
  });

  it('reads a log and clamps it', () => {
    expect(parseFrameMessage({ kind: 'log', text: 'y'.repeat(9000) })).toEqual({ kind: 'log', text: 'y'.repeat(LOG_CHARS) });
    expect(parseFrameMessage({ kind: 'log', text: {} })).toBeNull();
  });

  it('clamps a height to the two ends', () => {
    expect(parseFrameMessage({ kind: 'height', height: 1 })).toEqual({ kind: 'height', height: HEIGHT_MIN });
    expect(parseFrameMessage({ kind: 'height', height: 1e9 })).toEqual({ kind: 'height', height: HEIGHT_MAX });
    expect(parseFrameMessage({ kind: 'height', height: 300.2 })).toEqual({ kind: 'height', height: 301 });
  });

  it('refuses a height that is not a size', () => {
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -4, '9', null]) {
      expect(parseFrameMessage({ kind: 'height', height })).toBeNull();
    }
  });

  it('reads a report and clamps its text', () => {
    expect(parseFrameMessage(report)).toEqual(report);
    const long = parseFrameMessage({ ...report, text: 'z'.repeat(9000) });
    expect(long).toMatchObject({ text: 'z'.repeat(REPORT_TEXT_CHARS) });
  });

  it.each([
    ['nodes', { nodes: 'x' }],
    ['nodes below zero', { nodes: -1 }],
    ['svgs', { svgs: Number.NaN }],
    ['marks', { marks: 'x' }],
    ['nan', { nan: null }],
    ['bbox', { bbox: null }],
    ['bbox width', { bbox: { w: 'x', h: 1 } }],
    ['bbox height', { bbox: { w: 1, h: Number.POSITIVE_INFINITY } }],
    ['text', { text: 9 }],
  ])('refuses a report with a bad %s', (_field, bad) => {
    expect(parseFrameMessage({ ...report, ...bad })).toBeNull();
  });

  it('returns null for junk', () => {
    for (const junk of [null, undefined, 3, 'alive', [], {}, { kind: 'nope' }, { kind: 7 }]) {
      expect(parseFrameMessage(junk)).toBeNull();
    }
  });
});
