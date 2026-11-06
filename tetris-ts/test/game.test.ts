/**
 * Game-state tests. Each one drives the single action function and asserts the
 * exact numbers, so scoring, gravity pacing and the top-out rules are pinned as
 * data rather than as a story about how the game should feel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBoard,
  canPlace,
  dropDistance,
  fullRowIndexes,
  landingPosition,
  type Board,
} from '../src/board.ts';
import { PIECE_KINDS, cellsOf, type PieceKind, type RotationState } from '../src/pieces.ts';
import {
  applyAction,
  createGame,
  gravityIntervalMs,
  ghostPositionOf,
  levelOf,
  type Action,
  type GameState,
} from '../src/game.ts';
import { boardWithCells, cellsOfRows, randomSequence, snapshot } from './support.ts';

const random = randomSequence([0.42, 0.11, 0.93, 0.37, 0.65, 0.02, 0.78]);

function queueOf(first: PieceKind, rest: PieceKind[] = []): PieceKind[] {
  const queue: PieceKind[] = [first];
  for (const kind of rest) {
    queue.push(kind);
  }
  while (queue.length < 7) {
    queue.push('O');
  }
  return queue;
}

function stackExcept(rows: readonly number[], column: number): Board {
  const cells = cellsOfRows(rows).filter((cell: readonly [number, number]): boolean => {
    return cell[0] !== column;
  });
  return boardWithCells(cells);
}

function activeOf(kind: PieceKind, state: RotationState, x: number, y: number): GameState['active'] {
  return { kind, state, position: { x, y } };
}

function rowsThrough(from: number, to: number): number[] {
  const rows: number[] = [];
  for (let row = from; row <= to; row = row + 1) {
    rows.push(row);
  }
  return rows;
}

function columnsOf(state: GameState): number[] {
  return cellsOf(state.active.kind, state.active.state).map((offset) => state.active.position.x + offset.x);
}

test('a new game starts with a piece in play, seven pieces in view and nothing scored', () => {
  const state = createGame(random);
  assert.equal(state.status, 'playing');
  assert.equal(state.queue.length, 7, 'the preview shows the whole bag');
  assert.equal(state.hold, null);
  assert.equal(state.score, 0);
  assert.equal(state.lines, 0);
  assert.equal(state.level, 1);
  assert.equal(state.combo, 0);
  assert.equal(
    canPlace(state.board, state.active.kind, state.active.state, state.active.position),
    true,
    'the starting piece must fit at its spawn position',
  );
});

test('every kind appears exactly once in the first run of spawns', () => {
  let state = createGame(random);
  const kinds: PieceKind[] = [];
  for (let spawn = 0; spawn < 7; spawn = spawn + 1) {
    kinds.push(state.active.kind);
    state = applyAction(state, 'hard-drop', random);
  }
  const distinct = new Set<PieceKind>(kinds);
  assert.equal(distinct.size, PIECE_KINDS.length, 'a bag must deal seven different kinds');
  for (const kind of PIECE_KINDS) {
    assert.equal(distinct.has(kind), true, `${kind} must appear in the first bag`);
  }
});

test('left and right move one column at a time and stop at the walls', () => {
  let state = createGame(random);
  state = applyAction(state, 'right', random);
  const spawn = createGame(random).active;
  const movedColumns = columnsOf(state);
  const spawnColumns = cellsOf(spawn.kind, spawn.state).map((offset) => spawn.position.x + offset.x);
  assert.equal(
    Math.min(...movedColumns) - Math.min(...spawnColumns),
    1,
    'right must move exactly one column',
  );

  for (let step = 0; step < 12; step = step + 1) {
    state = applyAction(state, 'left', random);
  }
  assert.equal(Math.min(...columnsOf(state)), 0, 'a piece must come to rest against the left wall');
  for (let step = 0; step < 24; step = step + 1) {
    state = applyAction(state, 'right', random);
  }
  assert.equal(Math.max(...columnsOf(state)), 9, 'a piece must come to rest against the right wall');
});

test('soft drop moves one row for one point and does nothing once the piece rests', () => {
  const state = createGame(random);
  const moved = applyAction(state, 'soft-drop', random);
  assert.equal(moved.active.position.y, state.active.position.y + 1);
  assert.equal(moved.score, state.score + 1, 'a soft drop row is worth one point');

  let resting = moved;
  const remaining = dropDistance(resting.board, resting.active.kind, resting.active.state, resting.active.position);
  for (let step = 0; step < remaining; step = step + 1) {
    resting = applyAction(resting, 'soft-drop', random);
  }
  const scoreWhenResting = resting.score;
  const stuck = applyAction(resting, 'soft-drop', random);
  assert.deepEqual(stuck.active, resting.active, 'a resting piece must not slide down');
  assert.equal(stuck.score, scoreWhenResting, 'a refused soft drop must not pay');
});

test('hard drop lands the piece, pays two points per row and spawns the next piece', () => {
  const state = createGame(random);
  const dropped = applyAction(state, 'hard-drop', random);
  const landing = landingPosition(state.board, state.active.kind, state.active.state, state.active.position);
  const distance = landing.y - state.active.position.y;
  assert.equal(distance > 0, true, 'the spawn position must leave room to fall');
  assert.equal(dropped.score, state.score + distance * 2);
  assert.equal(dropped.active.kind, state.queue[0], 'the previewed next piece must spawn');
  assert.equal(dropped.queue.length, 7, 'the preview must be refilled');
  assert.equal(fullRowIndexes(dropped.board).length, 0);
  for (const offset of cellsOf(state.active.kind, state.active.state)) {
    assert.equal(
      dropped.board.rows[landing.y + offset.y]?.[landing.x + offset.x],
      state.active.kind,
      'the locked piece must be part of the stack',
    );
  }
});

test('a tick lowers the piece, and a tick on a resting piece locks it', () => {
  const state = createGame(random);
  const ticked = applyAction(state, 'tick', random);
  assert.equal(ticked.active.position.y, state.active.position.y + 1);

  let resting = ticked;
  const remaining = dropDistance(ticked.board, ticked.active.kind, ticked.active.state, ticked.active.position);
  for (let step = 0; step < remaining; step = step + 1) {
    resting = applyAction(resting, 'tick', random);
  }
  const kindInPlay = resting.active.kind;
  const preview = resting.queue[0];
  const locked = applyAction(resting, 'tick', random);
  assert.equal(locked.active.kind, preview, 'locking must spawn the previewed piece');
  assert.notEqual(locked.active.kind, kindInPlay);
  assert.equal(locked.queue.length, 7, 'the preview must be refilled');
});

test('a completed row clears and scores one hundred times the level', () => {
  const board = stackExcept([21], 0);
  const state: GameState = {
    ...createGame(random),
    board,
    queue: queueOf('T'),
    active: activeOf('I', 1, -2, 0),
  };
  const dropped = applyAction(state, 'hard-drop', random);
  assert.equal(dropped.lines, 1);
  assert.equal(dropped.score, 136, 'one hundred for the line plus thirty-six for eighteen rows');
  assert.equal(dropped.combo, 1);
  assert.deepEqual(fullRowIndexes(dropped.board), []);
});

test('four completed rows at once score eight hundred times the level', () => {
  const board = stackExcept([18, 19, 20, 21], 0);
  const state: GameState = {
    ...createGame(random),
    board,
    queue: queueOf('T'),
    active: activeOf('I', 1, -2, 0),
  };
  const dropped = applyAction(state, 'hard-drop', random);
  assert.equal(dropped.lines, 4);
  assert.equal(dropped.score, 836, 'eight hundred for the tetris plus thirty-six for the drop');
  assert.deepEqual(fullRowIndexes(dropped.board), []);
});

test('consecutive clearing locks build a combo and a blank lock resets it', () => {
  const board = stackExcept([21], 0);
  const first: GameState = {
    ...createGame(random),
    board,
    queue: queueOf('T'),
    active: activeOf('I', 1, -2, 0),
  };
  const cleared = applyAction(first, 'hard-drop', random);
  const again: GameState = {
    ...cleared,
    board,
    queue: queueOf('T'),
    active: activeOf('I', 1, -2, 0),
  };
  const combo = applyAction(again, 'hard-drop', random);
  assert.equal(combo.combo, 2);
  assert.equal(combo.score, 322, 'the second line pays fifty times the streak times the level');

  const blank: GameState = {
    ...combo,
    board: createBoard(),
    queue: queueOf('T'),
    active: activeOf('O', 0, 4, 0),
  };
  const blanked = applyAction(blank, 'hard-drop', random);
  assert.equal(blanked.combo, 0, 'a lock that clears nothing ends the streak');
  assert.equal(blanked.score - combo.score, 40, 'twenty rows of hard drop pay two points each');
});

test('hold swaps the piece in play and refuses a second hold in the same piece', () => {
  const state: GameState = { ...createGame(random), queue: queueOf('T', ['J']) };
  const held = applyAction(state, 'hold', random);
  assert.equal(held.hold, state.active.kind, 'the swapped piece goes to the slot');
  assert.equal(held.active.kind, 'T', 'the slot stays empty and the preview spawns');

  const refused = applyAction(held, 'hold', random);
  assert.deepEqual(refused.active, held.active, 'a second hold must be refused');
  assert.deepEqual(refused.queue, held.queue);

  const locked = applyAction(refused, 'hard-drop', random);
  assert.equal(locked.hold, held.hold, 'the slot survives the lock');
  assert.equal(locked.active.kind, 'J', 'the next queue head was dealt');
  const swapped = applyAction(locked, 'hold', random);
  assert.equal(swapped.active.kind, state.active.kind, 'the allowance returns with the next piece');
  assert.equal(swapped.hold, 'J', 'the piece just played goes into the slot');
});

test('a rotation action uses the kick system and a blocked rotation changes nothing', () => {
  const state = createGame(random);
  const turned = applyAction(state, 'rotate-cw', random);
  assert.equal(turned.active.state, 1);
  const turnedBack = applyAction(turned, 'rotate-ccw', random);
  assert.deepEqual(turnedBack.active, state.active);

  const blocked: GameState = {
    ...createGame(random),
    board: boardWithCells([[4, 10], [3, 10], [4, 13], [3, 13]]),
    queue: queueOf('T'),
    active: activeOf('T', 0, 3, 10),
  };
  const refused = applyAction(blocked, 'rotate-cw', random);
  assert.deepEqual(refused.active, blocked.active, 'a refused rotation must leave the piece alone');
});

test('a spawn into the stack ends the game', () => {
  const state: GameState = {
    ...createGame(random),
    board: stackExcept(rowsThrough(0, 1), 9),
    queue: queueOf('O'),
    active: activeOf('O', 0, 4, 2),
  };
  const dropped = applyAction(state, 'hard-drop', random);
  assert.equal(dropped.status, 'over');
});

test('locking a piece entirely inside the buffer rows ends the game', () => {
  const state: GameState = {
    ...createGame(random),
    board: stackExcept(rowsThrough(2, 21), 9),
    queue: queueOf('O'),
    active: activeOf('O', 0, 4, 0),
  };
  const dropped = applyAction(state, 'hard-drop', random);
  assert.equal(dropped.status, 'over');
});

test('every action on a finished game changes nothing', () => {
  const finished: GameState = { ...createGame(random), status: 'over' };
  const actions: readonly Action[] = [
    'left',
    'right',
    'soft-drop',
    'hard-drop',
    'tick',
    'rotate-cw',
    'rotate-ccw',
    'hold',
  ];
  for (const action of actions) {
    assert.deepEqual(applyAction(finished, action, random), finished, `${action} must be refused`);
  }
});

test('the level rises every forty lines and the gravity interval keeps shrinking', () => {
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(39), 1);
  assert.equal(levelOf(40), 2);
  assert.equal(levelOf(41), 2);
  assert.equal(levelOf(560), 15);
  assert.equal(levelOf(600), 15, 'the level must stop rising at the top level');

  assert.equal(gravityIntervalMs(1), 800);
  let previous = gravityIntervalMs(1);
  for (let level = 2; level <= 15; level = level + 1) {
    const interval = gravityIntervalMs(level);
    assert.equal(interval < previous, true, `level ${level} must fall faster than level ${level - 1}`);
    assert.equal(interval >= 50, true, `level ${level} must stay playable`);
    previous = interval;
  }
});

test('the ghost position is where a hard drop would lock the piece', () => {
  const boards: readonly Board[] = [
    createBoard(),
    boardWithCells([[4, 14], [5, 15], [6, 16], [7, 17]]),
  ];
  for (const board of boards) {
    const state: GameState = {
      ...createGame(random),
      board,
      queue: queueOf('T'),
      active: activeOf('S', 0, 3, 0),
    };
    const ghost = ghostPositionOf(state);
    const expected = landingPosition(board, state.active.kind, state.active.state, state.active.position);
    assert.deepEqual(ghost, expected);
    const dropped = applyAction(state, 'hard-drop', random);
    for (const offset of cellsOf(state.active.kind, state.active.state)) {
      assert.equal(
        dropped.board.rows[ghost.y + offset.y]?.[ghost.x + offset.x],
        state.active.kind,
        'the ghost must mark exactly where the piece locks',
      );
    }
  }
});

test('an action never changes the state it was given', () => {
  const state = createGame(random);
  const before = snapshot(state);
  const actions: readonly Action[] = ['left', 'right', 'tick', 'soft-drop', 'rotate-cw', 'hold'];
  for (const action of actions) {
    applyAction(state, action, random);
  }
  assert.equal(snapshot(state), before, 'the previous state must survive every action');
  assert.equal(snapshot(state.board), snapshot(createGame(random).board));
});
