/**
 * The terminal owner. This module is one of the two in the source tree that may
 * reach the platform, and it exists to hold every side effect in one place: it
 * puts the terminal into raw mode, translates bytes with the key decoder,
 * writes whole frames, and puts the terminal back when the game ends. If no
 * terminal is attached it reports that rather than starting a game nobody can
 * control.
 */
import { stdin as input, stdout as output } from 'node:process';

import { QUIT, decodeKey, KEY_HELP, type KeySignal } from './keys.ts';

export type Term = {
  readonly render: (lines: readonly string[]) => void;
  readonly onKey: (handler: (signal: KeySignal) => void) => void;
  readonly close: () => void;
};

const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';
const CLEAR_REST = '\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const RESET = '\x1b[0m';

function isInputReady(stream: typeof input): stream is typeof input & {
  isTTY: true;
  setRawMode: (mode: boolean) => typeof input;
} {
  return stream.isTTY === true;
}

/** Put the terminal into raw mode, or report why the game cannot start. */
export function openTerm(): Term | null {
  if (!isInputReady(input)) {
    output.write(`${RESET}this game needs a terminal that supports raw mode\n`);
    return null;
  }
  const stream = input;
  const previousRaw = stream.isRaw === true;
  stream.setRawMode(true);
  stream.setEncoding('utf8');

  const handlers: ((signal: KeySignal) => void)[] = [];
  const onData = (chunk: string): void => {
    const signal = decodeKey(chunk);
    if (signal === null) {
      return;
    }
    for (const handler of handlers) {
      handler(signal);
    }
  };

  output.write(`${CLEAR}${HIDE_CURSOR}`);
  output.write(`${RESET}keys: ${KEY_HELP.join(' ')}\n`);
  stream.on('data', onData);
  stream.resume();

  return {
    render: (lines: readonly string[]): void => {
      output.write(`${HOME}${CLEAR_REST}${lines.join('\n')}${RESET}`);
    },
    onKey: (handler: (signal: KeySignal) => void): void => {
      handlers.push(handler);
    },
    close: (): void => {
      stream.off('data', onData);
      stream.pause();
      stream.setRawMode(previousRaw);
      output.write(`${SHOW_CURSOR}${RESET}`);
    },
  };
}

/** Report a quit signal, which the entry point turns into a shutdown. */
export function isQuit(signal: KeySignal): boolean {
  return signal === QUIT;
}
