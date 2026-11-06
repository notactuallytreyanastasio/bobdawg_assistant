/**
 * Rotation tests pin three things: the round trip of a quarter turn, the exact
 * offsets of the published kick tables in this engine's y-down coordinates, and
 * the rule that the first fitting test wins.
 *
 * Sign check used throughout: the reference tables are written y-up, so a
 * reference (+1,-1) becomes (+1,+1) here, meaning one row deeper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBoard,
  type Board,
  type Cell,
  type Position,
} from '../src/board.ts';
import { PIECE_KINDS, type PieceKind, type RotationState } from '../src/pieces.ts';
import {
  kickTests,
  rotate,
  type RotationDirection,
} from '../src/rotation.ts';

const FILLER: PieceKind = 'Z';
const TRANSITIONS: readonly [RotationState, RotationState][] = [
  [0, 1],
  [1, 0],
  [1, 2],
  [2, 1],
  [2, 3],
  [3, 2],
  [3, 0],
  [0, 3],
];

function emptyRows(count: number): Cell[][] {
  const rows: Cell[][] = [];
  for (let y = 0; y < count; y = y + 1) {
    const row: Cell[] = [];
    for (let x = 0; x < 10; x = x + 1) {
      row.push(null);
    }
    rows.push(row);
  }
  return rows;
}

function boardWith(cells: readonly (readonly [number, number])[]): Board {
  const grid = emptyRows(22);
  for (const [x, y] of cells) {
    const row = grid[y];
    if (row !== undefined) {
      row[x] = FILLER;
    }
  }
  return { width: 10, height: 22, rows: grid };
}

function positionAt(x: number, y: number): Position {
  return { x, y };
}

test('every piece rotates clockwise in open space without moving', () => {
  const board = createBoard();
  for (const kind of PIECE_KINDS) {
    const spawn = positionAt(kind === 'O' ? 4 : 3, 0);
    const outcome = rotate(board, kind, 0, spawn, 'cw');
    assert.equal(outcome.kind, 'rotated', `${kind} must rotate in open space`);
    if (outcome.kind === 'rotated') {
      assert.equal(outcome.state, 1, `${kind} clockwise goes to state 1`);
      assert.deepEqual(outcome.position, spawn, `${kind} needs no kick in open space`);
    }
  }
});

test('counter-clockwise from the spawn state reaches the third state', () => {
  const board = createBoard();
  for (const kind of PIECE_KINDS) {
    const spawn = positionAt(kind === 'O' ? 4 : 3, 0);
    const outcome = rotate(board, kind, 0, spawn, 'ccw');
    assert.equal(outcome.kind, 'rotated');
    if (outcome.kind === 'rotated') {
      assert.equal(outcome.state, 3, `${kind} counter-clockwise goes to state 3`);
      assert.deepEqual(outcome.position, spawn);
    }
  }
});

test('a clockwise turn followed by a counter-clockwise turn is a round trip', () => {
  const board = createBoard();
  for (const kind of PIECE_KINDS) {
    const spawn = positionAt(kind === 'O' ? 4 : 3, 0);
    const forward = rotate(board, kind, 0, spawn, 'cw');
    assert.equal(forward.kind, 'rotated');
    if (forward.kind !== 'rotated') {
      continue;
    }
    const back = rotate(board, kind, forward.state, forward.position, 'ccw');
    assert.equal(back.kind, 'rotated');
    if (back.kind === 'rotated') {
      assert.equal(back.state, 0, `${kind} must return to the spawn state`);
      assert.deepEqual(back.position, spawn, `${kind} must return to the spawn column`);
    }
  }
});

test('the I piece wall kicks left away from the right wall', () => {
  const board = createBoard();
  const outcome = rotate(board, 'I', 1, positionAt(7, 10), 'cw');
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind === 'rotated') {
    assert.equal(outcome.state, 2);
    assert.deepEqual(outcome.position, { x: 6, y: 10 }, 'the published test shifts one cell left');
  }
});

test('the I piece wall kicks right away from the left wall', () => {
  const board = createBoard();
  // State one of the I piece occupies column two of its box, so x = -2 puts it
  // flush against the left wall with the rest of the box outside the field.
  const outcome = rotate(board, 'I', 1, positionAt(-2, 10), 'ccw');
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind === 'rotated') {
    assert.equal(outcome.state, 0);
    assert.deepEqual(outcome.position, { x: 0, y: 10 }, 'the second test shifts two cells right');
  }
});

test('the I piece kicks up and over an obstruction when the horizontal tests fail', () => {
  const board = boardWith([[6, 20]]);
  const outcome = rotate(board, 'I', 1, positionAt(7, 18), 'cw');
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind === 'rotated') {
    assert.equal(outcome.state, 2);
    assert.deepEqual(outcome.position, { x: 6, y: 16 }, 'the fourth test moves one left and two up');
  }
});

test('a rounded piece takes the published horizontal kick when the first test is blocked', () => {
  const board = boardWith([[4, 10]]);
  const outcome = rotate(board, 'T', 0, positionAt(3, 10), 'cw');
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind === 'rotated') {
    assert.equal(outcome.state, 1);
    assert.deepEqual(outcome.position, { x: 2, y: 10 }, 'the second test moves one cell left');
  }
});

test('the same piece falls through to the deeper test when the first two are blocked', () => {
  const board = boardWith([[4, 10], [3, 10]]);
  const outcome = rotate(board, 'T', 0, positionAt(3, 10), 'cw');
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind === 'rotated') {
    assert.equal(outcome.state, 1);
    assert.deepEqual(
      outcome.position,
      { x: 3, y: 12 },
      'the fourth test drops two rows deeper with no horizontal shift',
    );
  }
});

test('a rotation with no fitting test is reported blocked', () => {
  const board = boardWith([[4, 10], [3, 10], [4, 13], [3, 13]]);
  const outcome = rotate(board, 'T', 0, positionAt(3, 10), 'cw');
  assert.equal(outcome.kind, 'blocked');
});

test('the square piece rotates in place even against a wall', () => {
  const board = createBoard();
  const outcome = rotate(board, 'O', 0, positionAt(8, 19), 'cw');
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind === 'rotated') {
    assert.equal(outcome.state, 1);
    assert.deepEqual(outcome.position, { x: 8, y: 19 }, 'the square piece never kicks');
  }
});

test('every published transition carries five tests beginning with the identity offset', () => {
  const kicked: readonly PieceKind[] = ['I', 'J', 'L', 'S', 'T', 'Z'];
  for (const kind of kicked) {
    for (const [from, to] of TRANSITIONS) {
      const tests = kickTests(kind, from, to);
      assert.equal(tests.length, 5, `${kind} ${from}->${to} must carry five tests`);
      assert.deepEqual(tests[0], { x: 0, y: 0 }, `${kind} ${from}->${to} must try no move first`);
    }
  }
});

test('the square piece has one test per transition because its shape never changes', () => {
  for (const [from, to] of TRANSITIONS) {
    assert.deepEqual(kickTests('O', from, to), [{ x: 0, y: 0 }]);
  }
});

test('the negation of the reference sign convention survives into the stored offsets', () => {
  // The reference writes the third test of 0->R for the rounded pieces as
  // (-1,+1), one step up. Here it must be one row deeper-free, that is (-1,-1).
  assert.deepEqual(kickTests('T', 0, 1)[2], { x: -1, y: -1 });
  assert.deepEqual(kickTests('T', 1, 0)[2], { x: 1, y: 1 });
  // The fourth test of the I piece 0->R is (-2,-1) in the reference, one step up.
  assert.deepEqual(kickTests('I', 0, 1)[3], { x: -2, y: 1 });
  assert.deepEqual(kickTests('I', 1, 0)[3], { x: 2, y: -1 });
});

test('rotation never touches the board it was given', () => {
  const board = createBoard();
  const before = board.rows.map((row: readonly Cell[]): Cell[] => [...row]);
  rotate(board, 'T', 0, positionAt(3, 0), 'cw');
  assert.deepEqual(board.rows, before);
});

test('both directions reach every state through repeated turns', () => {
  const board = createBoard();
  const directions: readonly RotationDirection[] = ['cw', 'ccw'];
  for (const direction of directions) {
    let state: RotationState = 0;
    for (let turn = 0; turn < 4; turn = turn + 1) {
      const outcome = rotate(board, 'S', state, positionAt(3, 0), direction);
      assert.equal(outcome.kind, 'rotated');
      if (outcome.kind === 'rotated') {
        state = outcome.state;
      }
    }
    assert.equal(state, 0, `${direction} four times must return to the spawn state`);
  }
});
