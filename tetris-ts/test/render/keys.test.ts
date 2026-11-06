/**
 * Key tests. A raw terminal delivers bytes, so these tests feed bytes and
 * assert the action they become. Control sequences are written with escapes so
 * the test file says exactly what the terminal sends, including the two arrow
 * prefixes a terminal may use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Action } from '../../src/game.ts';
import { QUIT, decodeKey, KEY_HELP } from '../../src/render/keys.ts';

const ARROWS: readonly (readonly [string, Action])[] = [
  ['\x1b[D', 'left'],
  ['\x1b[C', 'right'],
  ['\x1b[B', 'soft-drop'],
  ['\x1b[A', 'rotate-cw'],
  ['\x1bOD', 'left'],
  ['\x1bOC', 'right'],
  ['\x1bOB', 'soft-drop'],
  ['\x1bOA', 'rotate-cw'],
];

test('every arrow sequence becomes its action', () => {
  for (const [sequence, action] of ARROWS) {
    assert.equal(decodeKey(sequence), action, JSON.stringify(sequence));
  }
});

test('space drops hard, and the letters rotate and hold', () => {
  assert.equal(decodeKey(' '), 'hard-drop');
  assert.equal(decodeKey('x'), 'rotate-cw');
  assert.equal(decodeKey('z'), 'rotate-ccw');
  assert.equal(decodeKey('c'), 'hold');
  assert.equal(decodeKey('h'), 'hold');
});

test('q and control-c quit', () => {
  assert.equal(decodeKey('q'), QUIT);
  assert.equal(decodeKey('\x03'), QUIT);
});

test('an unused key becomes nothing rather than a wrong action', () => {
  assert.equal(decodeKey('j'), null);
  assert.equal(decodeKey('\x1b'), null);
  assert.equal(decodeKey('\x1b['), null);
  assert.equal(decodeKey(''), null);
});

test('a chunk carrying a sequence plus more still reads the sequence', () => {
  assert.equal(decodeKey('\x1b[D\x1b[C'), 'left');
});

test('the help line names the keys the decoder answers', () => {
  assert.equal(KEY_HELP.length > 0, true);
  assert.equal(KEY_HELP.some((entry: string): boolean => entry.includes('hard drop')), true);
});
