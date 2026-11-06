import { describe, expect, it } from 'vitest';
import { createSseScanner } from '../../src/api/sse';

const encoder = new TextEncoder();

function feed(text: string) {
  const scanner = createSseScanner();
  return scanner.push(encoder.encode(text));
}

describe('createSseScanner', () => {
  it('returns the payload of one whole event', () => {
    expect(feed('data: {"choices":[]}\n\n')).toEqual(['{"choices":[]}']);
  });

  it('waits for the line to finish before returning a payload', () => {
    const scanner = createSseScanner();
    expect(scanner.push(encoder.encode('data: hel'))).toEqual([]);
    expect(scanner.push(encoder.encode('lo\n'))).toEqual([]);
    expect(scanner.push(encoder.encode('\n'))).toEqual(['hello']);
  });

  it('joins several data lines of one event with newlines', () => {
    expect(feed('data: one\ndata: two\n\n')).toEqual(['one\ntwo']);
  });

  it('dispatches each event of a chunk that holds many', () => {
    expect(feed('data: a\n\ndata: b\n\ndata: c\n\n')).toEqual(['a', 'b', 'c']);
  });

  it('accepts carriage return line endings', () => {
    expect(feed('data: one\r\ndata: two\r\n\r\n')).toEqual(['one\ntwo']);
  });

  it('ignores comment lines a server sends to keep the socket alive', () => {
    expect(feed(': keepalive\n\n')).toEqual([]);
    expect(feed(': ping\n')).toEqual([]);
  });

  it('ignores event and id fields but still dispatches the payload', () => {
    expect(feed('event: ping\nid: 7\ndata: x\n\n')).toEqual(['x']);
  });

  it('dispatches nothing when an event has no data at all', () => {
    expect(feed('event: ping\n\n')).toEqual([]);
  });

  it('strips exactly one space after the field colon', () => {
    expect(feed('data:tight\n\n')).toEqual(['tight']);
    expect(feed('data:  spaced\n\n')).toEqual([' spaced']);
  });

  it('hands the [DONE] sentinel through untouched', () => {
    expect(feed('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });

  it('keeps a multi-byte token intact when it is split across chunks', () => {
    const whole = encoder.encode('data: café\n\n');
    const split = whole.indexOf(0xc3);
    const scanner = createSseScanner();
    expect(scanner.push(whole.slice(0, split + 1))).toEqual([]);
    expect(scanner.push(whole.slice(split + 1))).toEqual(['café']);
  });

  it('keeps a payload when a chunk ends inside a multi-byte token', () => {
    const whole = encoder.encode('data: 你好\n\n');
    const scanner = createSseScanner();
    expect(scanner.push(whole.slice(0, 8))).toEqual([]);
    expect(scanner.push(whole.slice(8))).toEqual(['你好']);
  });

  it('flushes an event that never received its blank line when the stream ends', () => {
    const scanner = createSseScanner();
    expect(scanner.push(encoder.encode('data: partial'))).toEqual([]);
    expect(scanner.close()).toEqual(['partial']);
    expect(scanner.close()).toEqual([]);
  });

  it('starts fresh after a flush, so a scanner can be reused', () => {
    const scanner = createSseScanner();
    scanner.push(encoder.encode('data: first\n\ndata: second\n'));
    expect(scanner.close()).toEqual(['second']);
    expect(scanner.push(encoder.encode('data: third\n\n'))).toEqual(['third']);
  });
});
