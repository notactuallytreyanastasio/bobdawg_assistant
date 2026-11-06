// Server-sent events over bytes, not text. A token is UTF-8, so a network chunk
// can end in the middle of a character, and decoding text per chunk would turn
// that into junk. Line feeds never occur inside a multi-byte sequence, so the
// scanner splits on bytes and decodes only whole lines.

const LF = 0x0a;
const CR = 0x0d;

export type SseScanner = {
  push(chunk: Uint8Array): string[];
  close(): string[];
};

function linesOf(
  bytes: Uint8Array,
  final: boolean,
): { lines: Uint8Array[]; rest: Uint8Array } {
  const lines: Uint8Array[] = [];
  let start = 0;
  let cursor = 0;
  while (cursor < bytes.length) {
    const marker = bytes[cursor];
    if (marker === LF) {
      lines.push(bytes.slice(start, cursor));
      cursor += 1;
      start = cursor;
    } else if (marker === CR) {
      const pair = cursor + 1 < bytes.length && bytes[cursor + 1] === LF;
      // A carriage return at the very end of a chunk is ambiguous: the next
      // chunk may hold the line feed of an \r\n pair, so the line waits.
      if (cursor + 1 === bytes.length && !final) {
        break;
      }
      lines.push(bytes.slice(start, cursor));
      cursor += pair ? 2 : 1;
      start = cursor;
    } else {
      cursor += 1;
    }
  }
  // Once the stream is over, whatever is left counts as a line: the socket ended
  // before the terminator arrived.
  if (final && start < bytes.length) {
    lines.push(bytes.slice(start));
    start = bytes.length;
  }
  return { lines, rest: bytes.slice(start) };
}

export function createSseScanner(): SseScanner {
  const decoder = new TextDecoder();
  let rest: Uint8Array = new Uint8Array(0);
  let data: string[] = [];

  function consume(bytes: Uint8Array, final: boolean): string[] {
    const combined = new Uint8Array(rest.length + bytes.length);
    combined.set(rest);
    combined.set(bytes, rest.length);
    const found = linesOf(combined, final);
    rest = found.rest;

    const payloads: string[] = [];
    for (const line of found.lines) {
      if (line.length === 0) {
        // A blank line ends the event. Without a data field there is nothing to
        // dispatch, which is what an event or keepalive on its own looks like.
        if (data.length > 0) {
          payloads.push(data.join('\n'));
          data = [];
        }
        continue;
      }
      const decoded = decoder.decode(line);
      if (decoded.startsWith(':')) continue;
      const colon = decoded.indexOf(':');
      const name = colon === -1 ? decoded : decoded.slice(0, colon);
      // event, id and retry are ignored: this client only follows the payload.
      if (name !== 'data') continue;
      let value = colon === -1 ? '' : decoded.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      data.push(value);
    }
    return payloads;
  }

  return {
    push: (chunk: Uint8Array): string[] => consume(chunk, false),
    close: (): string[] => {
      const payloads = consume(new Uint8Array(0), true);
      // A stream that ends without its final blank line still had something to
      // say, so the pending event is dispatched as it stands.
      if (data.length > 0) {
        payloads.push(data.join('\n'));
        data = [];
      }
      return payloads;
    },
  };
}
