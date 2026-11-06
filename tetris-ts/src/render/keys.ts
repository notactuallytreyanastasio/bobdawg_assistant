/**
 * Key decoding. A raw-mode terminal delivers control sequences as bytes, so a
 * key is recognised by the sequence it spells rather than by a library. The
 * decoder returns an action, the quit signal, or nothing when the bytes are not
 * a key this game uses, which keeps unhandled input out of the state instead of
 * turning it into an error.
 */
import type { Action } from '../game.ts';

export const QUIT = 'quit';

export type KeySignal = Action | typeof QUIT;

type Key = {
  readonly sequence: string;
  readonly signal: KeySignal;
  readonly label: string;
};

const KEYS: readonly Key[] = [
  { sequence: '\x1b[D', signal: 'left', label: 'Left' },
  { sequence: '\x1b[C', signal: 'right', label: 'Right' },
  { sequence: '\x1b[B', signal: 'soft-drop', label: 'Down' },
  { sequence: '\x1b[A', signal: 'rotate-cw', label: 'Up' },
  { sequence: '\x1bOD', signal: 'left', label: 'Left' },
  { sequence: '\x1bOC', signal: 'right', label: 'Right' },
  { sequence: '\x1bOB', signal: 'soft-drop', label: 'Down' },
  { sequence: '\x1bOA', signal: 'rotate-cw', label: 'Up' },
  { sequence: ' ', signal: 'hard-drop', label: 'Space' },
  { sequence: 'x', signal: 'rotate-cw', label: 'x' },
  { sequence: 'z', signal: 'rotate-ccw', label: 'z' },
  { sequence: 'c', signal: 'hold', label: 'c' },
  { sequence: 'h', signal: 'hold', label: 'h' },
  { sequence: 'q', signal: QUIT, label: 'q' },
  { sequence: '\x03', signal: QUIT, label: 'Ctrl-C' },
];

/** The key names this game answers, for the help line. */
export const KEY_HELP: readonly string[] = [
  '←/→ move',
  '↑ rotate',
  '↓ soft drop',
  '␌ hard drop',
  'z rotate',
  'c hold',
  'q quit',
];

/** Recognise one key from a raw-mode chunk, or nothing when it is unused. */
export function decodeKey(chunk: string): KeySignal | null {
  for (const key of KEYS) {
    if (chunk === key.sequence) {
      return key.signal;
    }
  }
  for (const key of KEYS) {
    if (key.sequence.length > 1 && chunk.startsWith(key.sequence)) {
      return key.signal;
    }
  }
  return null;
}
