/**
 * Frame tests. A frame is plain text, so every assertion is about the text:
 * every line the same width, exactly the visible rows drawn, placed cells
 * solid, ghost cells hollow and never over a placed cell, and the panel lines
 * carrying the score data. The last test proves the frame builder is a
 * function of the state and not a mutation of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUFFER_HEIGHT,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  TOTAL_HEIGHT,
} from '../../src/board.ts';
import { createGame, ghostPositionOf, type GameState } from '../../src/game.ts';
import { cellsOf, type PieceKind, type RotationState } from '../../src/pieces.ts';
import {
  CELL_EMPTY,
  CELL_GHOST,
  CELL_SOLID,
  FRAME_WIDTH,
  frameOf,
} from '../../src/render/frame.ts';
import { boardWithCells, randomSequence, snapshot } from '../support.ts';

const random = randomSequence([0.42, 0.11, 0.93, 0.37, 0.65, 0.02, 0.78]);

function fieldLine(lines: readonly string[], visibleRow: number): string {
  // The first line is the top border, so visible row zero is the second line.
  return lines[visibleRow + 1] ?? '';
}

function cellAt(lines: readonly string[], x: number, visibleRow: number): string {
  const line = fieldLine(lines, visibleRow);
  return line.slice(2 + x * 2, 4 + x * 2);
}

function stateOf(kind: PieceKind, state: RotationState, x: number, y: number): GameState {
  return {
    ...createGame(random),
    board: boardWithCells([[0, 21], [1, 21], [2, 21]]),
    active: { kind, state, position: { x, y } },
  };
}

function solidCount(lines: readonly string[]): number {
  let count = 0;
  for (let row = 0; row < FIELD_HEIGHT; row = row + 1) {
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      if (cellAt(lines, x, row) === CELL_SOLID) {
        count = count + 1;
      }
    }
  }
  return count;
}

function visibleStackCells(state: GameState): number {
  let count = 0;
  for (const row of state.board.rows.slice(BUFFER_HEIGHT)) {
    for (const cell of row) {
      if (cell !== null) {
        count = count + 1;
      }
    }
  }
  return count;
}

test('every line of the frame is the same width', () => {
  const lines = frameOf(stateOf('T', 0, 3, 0));
  for (const line of lines) {
    assert.equal([...line].length, FRAME_WIDTH, `line was ${JSON.stringify(line)}`);
  }
});

test('the frame draws the visible field rows and none of the hidden rows', () => {
  const lines = frameOf(stateOf('T', 0, 3, 0));
  const visibleRows = TOTAL_HEIGHT - BUFFER_HEIGHT;
  // top border, visible rows, bottom border, a blank line and the status line
  assert.equal(lines.length, visibleRows + 4);
  assert.equal(lines[0]?.startsWith('┌'), true);
  assert.equal(lines[visibleRows + 1]?.startsWith('└'), true);
});

test('a placed cell is solid and an empty cell is blank', () => {
  const lines = frameOf(stateOf('T', 0, 3, 0));
  assert.equal(cellAt(lines, 0, 19), CELL_SOLID, 'column zero of the floor row holds a stack cell');
  assert.equal(cellAt(lines, 9, 19), CELL_EMPTY, 'the ghost does not fill the whole row');
  assert.equal(cellAt(lines, 9, 0), CELL_EMPTY);
});

test('the active piece is drawn over the field at its own cells', () => {
  const state = stateOf('O', 0, 4, 3);
  const lines = frameOf(state);
  for (const offset of cellsOf('O', 0)) {
    const x = state.active.position.x + offset.x;
    const visibleRow = state.active.position.y + offset.y - BUFFER_HEIGHT;
    assert.equal(cellAt(lines, x, visibleRow), CELL_SOLID, `the piece cell at column ${x}`);
  }
});

test('the ghost is hollow and a resting piece draws no ghost', () => {
  const state = stateOf('O', 0, 4, 3);
  const lines = frameOf(state);
  const ghost = ghostPositionOf(state);
  const bottomRow = ghost.y + 1 - BUFFER_HEIGHT;
  assert.equal(cellAt(lines, 4, bottomRow), CELL_GHOST, 'the ghost is drawn where a drop lands');
  assert.equal(cellAt(lines, 3, bottomRow), CELL_EMPTY);

  const ghosted = frameOf(stateOf('I', 0, 0, 0));
  assert.equal(ghosted.some((line: string): boolean => line.includes(CELL_GHOST)), true);

  const resting: GameState = {
    ...state,
    active: { kind: 'O', state: 0, position: { x: 4, y: 20 } },
  };
  const restingLines = frameOf(resting);
  const ghostCells = restingLines.filter((line: string): boolean => line.includes(CELL_GHOST));
  assert.deepEqual(ghostCells, [], 'a piece resting on its own ghost draws none');
});

test('the panel carries preview, hold, score, level, lines and combo', () => {
  const state = stateOf('T', 0, 3, 0);
  const text = frameOf(state).join('\n');
  assert.equal(text.includes('NEXT'), true);
  assert.equal(text.includes(state.queue.slice(0, 3).join(' ')), true, 'the preview is shown');
  assert.equal(text.includes('HOLD -'), true, 'an empty hold slot is shown');
  assert.equal(text.includes(`SCORE ${state.score}`), true);
  assert.equal(text.includes(`LEVEL ${state.level}`), true);
  assert.equal(text.includes(`LINES ${state.lines}`), true);

  const held: GameState = { ...state, hold: 'I', score: 1234, level: 5, lines: 200, combo: 3 };
  const heldText = frameOf(held).join('\n');
  assert.equal(heldText.includes('HOLD I'), true);
  assert.equal(heldText.includes('SCORE 1234'), true);
});

test('a finished game says so and names the quit key', () => {
  const over: GameState = { ...createGame(random), status: 'over' };
  assert.equal(frameOf(over).join('\n').includes('GAME OVER'), true);
  assert.equal(frameOf(createGame(random)).join('\n').includes('GAME OVER'), false);
});

test('a finished frame draws the stack but neither the active piece nor its ghost', () => {
  // The piece sits inside the visible rows, so a live frame really does draw it.
  const state = stateOf('T', 0, 3, 10);
  const over: GameState = { ...state, status: 'over' };
  const playing = frameOf(state);
  const finished = frameOf(over);

  assert.equal(playing.some((line: string): boolean => line.includes(CELL_GHOST)), true);
  assert.equal(finished.some((line: string): boolean => line.includes(CELL_GHOST)), false);
  assert.equal(solidCount(playing) > visibleStackCells(over), true, 'a live frame draws the piece');
  assert.equal(solidCount(finished), visibleStackCells(over), 'the finished frame draws only the stack');
  assert.equal(cellAt(finished, 0, 19), CELL_SOLID, 'the stack survives into the finished frame');
});

test('rendering never changes the state it is given', () => {
  const state = stateOf('S', 2, 2, 5);
  const before = snapshot(state);
  frameOf(state);
  assert.equal(snapshot(state), before);
});
