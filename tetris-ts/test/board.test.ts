import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUFFER_HEIGHT,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  SPAWN_POSITIONS,
  TOTAL_HEIGHT,
  TOTAL_WIDTH,
  canPlace,
  clearFullRows,
  createBoard,
  dropDistance,
  fullRowIndexes,
  isBlocked,
  landingPosition,
  placePiece,
  rowIsFull,
  type Board,
  type Cell,
  type Position,
} from '../src/board.ts';
import { PIECE_KINDS, cellsOf, type PieceKind, type RotationState } from '../src/pieces.ts';

function rowsOf(board: Board): readonly (readonly Cell[])[] {
  return board.rows;
}

function emptyRow(width: number): Cell[] {
  const row: Cell[] = [];
  for (let x = 0; x < width; x = x + 1) {
    row.push(null);
  }
  return row;
}

function boardFromRows(rows: readonly (readonly Cell[])[]): Board {
  return {
    width: rows[0]?.length ?? FIELD_WIDTH,
    height: rows.length,
    rows: rows.map((row: readonly Cell[]): Cell[] => [...row]),
  };
}

function emptyRows(count: number): Cell[][] {
  const rows: Cell[][] = [];
  for (let y = 0; y < count; y = y + 1) {
    rows.push(emptyRow(FIELD_WIDTH));
  }
  return rows;
}

function occupiedCells(board: Board): Position[] {
  const out: Position[] = [];
  for (let y = 0; y < board.height; y = y + 1) {
    for (let x = 0; x < board.width; x = x + 1) {
      if (board.rows[y]?.[x] !== null && board.rows[y]?.[x] !== undefined) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function absoluteCells(kind: PieceKind, state: RotationState, position: Position): Position[] {
  return [...cellsOf(kind, state)].map((offset): Position => ({ x: position.x + offset.x, y: position.y + offset.y }));
}

function fieldWithFilled(rows: readonly number[]): Board {
  const grid = emptyRows(TOTAL_HEIGHT);
  for (const y of rows) {
    const row = grid[y];
    if (row === undefined) {
      continue;
    }
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      row[x] = 'Z';
    }
  }
  return boardFromRows(grid);
}

function boardWithCells(cells: readonly Position[]): Board {
  const grid = emptyRows(TOTAL_HEIGHT);
  for (const cell of cells) {
    const row = grid[cell.y];
    if (row === undefined) {
      continue;
    }
    row[cell.x] = 'J';
  }
  return boardFromRows(grid);
}

test('the field is ten wide and twenty tall with a two-row hidden buffer', () => {
  assert.equal(FIELD_WIDTH, 10);
  assert.equal(FIELD_HEIGHT, 20);
  assert.equal(BUFFER_HEIGHT, 2);
  assert.equal(TOTAL_WIDTH, 10);
  assert.equal(TOTAL_HEIGHT, 22);

  const board = createBoard();
  assert.equal(rowsOf(board).length, TOTAL_HEIGHT);
  for (const row of rowsOf(board)) {
    assert.equal(row.length, TOTAL_WIDTH);
  }
  assert.deepEqual(occupiedCells(board), []);
});

test('every piece spawns at the guideline column with its whole shape inside the buffer', () => {
  for (const kind of PIECE_KINDS) {
    const position = SPAWN_POSITIONS[kind];
    const cells = absoluteCells(kind, 0, position);
    const xs = cells.map((cell: Position): number => cell.x);
    const ys = cells.map((cell: Position): number => cell.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);

    assert.ok(Math.max(...ys) <= BUFFER_HEIGHT - 1, `${kind} spawns below the buffer`);
    if (kind === 'O') {
      assert.equal(minX, 4, 'O spawns centrally');
      assert.equal(maxX, 5);
    } else if (kind === 'I') {
      assert.equal(minX, 3, 'I spawns centrally across four columns');
      assert.equal(maxX, 6);
    } else {
      assert.equal(minX, 3, `${kind} spawns rounded to the left`);
      assert.equal(maxX, 5);
    }
  }
});

test('the walls and the floor block, while empty space and the space above the field do not', () => {
  const board = createBoard();
  assert.equal(isBlocked(board, -1, 5), true, 'the left wall blocks');
  assert.equal(isBlocked(board, TOTAL_WIDTH, 5), true, 'the right wall blocks');
  assert.equal(isBlocked(board, 0, TOTAL_HEIGHT), true, 'the floor blocks');
  assert.equal(isBlocked(board, 5, TOTAL_HEIGHT + 4), true, 'below the floor blocks');
  assert.equal(isBlocked(board, 5, -1), false, 'above the field does not block');
  assert.equal(isBlocked(board, 5, -6), false, 'well above the field does not block');
  assert.equal(isBlocked(board, 5, 10), false, 'empty field space does not block');

  const withCell = boardWithCells([{ x: 5, y: 10 }]);
  assert.equal(isBlocked(withCell, 5, 10), true);
});

test('every piece is placeable at its spawn position on an empty field', () => {
  const board = createBoard();
  for (const kind of PIECE_KINDS) {
    assert.equal(canPlace(board, kind, 0, SPAWN_POSITIONS[kind]), true, `${kind} at spawn`);
  }
});

test('placement is rejected when a cell overlaps the stack, a wall or the floor', () => {
  const stack = boardWithCells([{ x: 4, y: 10 }, { x: 5, y: 10 }]);
  assert.equal(canPlace(stack, 'O', 0, { x: 4, y: 9 }), false, 'O over two stacked cells');
  assert.equal(canPlace(stack, 'O', 0, { x: 6, y: 9 }), true, 'O beside the stack');

  assert.equal(canPlace(createBoard(), 'O', 0, { x: -1, y: 9 }), false, 'left wall');
  assert.equal(canPlace(createBoard(), 'O', 0, { x: 9, y: 9 }), false, 'right wall');
  assert.equal(canPlace(createBoard(), 'O', 0, { x: 4, y: TOTAL_HEIGHT - 1 }), false, 'floor');
});

test('cells above the top of the field are allowed, which is what lets true rotation work', () => {
  const board = createBoard();
  assert.equal(canPlace(board, 'T', 0, { x: 3, y: -1 }), true, 'partly above the field');
  assert.equal(canPlace(board, 'T', 0, { x: 3, y: -2 }), true, 'entirely above the field');
  assert.equal(canPlace(board, 'I', 1, { x: 3, y: -2 }), true, 'a tall vertical I reaching above the field');
});

test('locking a piece marks its cells with the piece kind and leaves the old board untouched', () => {
  const board = createBoard();
  const before = JSON.stringify(rowsOf(board));
  const placed = placePiece(board, 'T', 0, { x: 3, y: 19 });
  const expectedCells = absoluteCells('T', 0, { x: 3, y: 19 });

  assert.notEqual(placed, board, 'placePiece must return a new board');
  assert.equal(JSON.stringify(rowsOf(board)), before, 'the input board was mutated');
  assert.deepEqual(occupiedCells(placed), expectedCells);
  for (const cell of expectedCells) {
    assert.equal(placed.rows[cell.y]?.[cell.x], 'T');
  }
});

test('full rows are detected and reported bottom-up in ascending order', () => {
  assert.equal(rowIsFull(createBoard(), TOTAL_HEIGHT - 1), false);

  const board = fieldWithFilled([20, 21]);
  assert.equal(rowIsFull(board, 20), true);
  assert.equal(rowIsFull(board, 21), true);
  assert.equal(rowIsFull(board, 19), false);
  assert.deepEqual(fullRowIndexes(board), [20, 21]);

  const single = fieldWithFilled([15]);
  assert.deepEqual(fullRowIndexes(single), [15]);

  const partial = boardWithCells([{ x: 0, y: 21 }, { x: 1, y: 21 }]);
  assert.deepEqual(fullRowIndexes(partial), []);
});

test('clearing rows removes exactly the full ones and shifts everything above down', () => {
  const grid = emptyRows(TOTAL_HEIGHT);
  const bottom = grid[21];
  const above = grid[20];
  const hanging = grid[10];
  if (bottom !== undefined && above !== undefined && hanging !== undefined) {
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      bottom[x] = 'Z';
    }
    above[0] = 'L';
    hanging[3] = 'S';
  }
  const board = boardFromRows(grid);
  const cleared = clearFullRows(board);

  assert.equal(cleared.height, TOTAL_HEIGHT);
  assert.equal(cleared.rows[TOTAL_HEIGHT - 1]?.[0], 'L', 'the row above the cleared line drops to the floor');
  assert.equal(cleared.rows[11]?.[3], 'S', 'every row above a cleared line drops by one');
  assert.equal(cleared.rows[10]?.[3], null, 'the space it vacated is empty');
  assert.equal(cleared.rows[21]?.[3], null, 'the cleared row is gone');
  assert.deepEqual(fullRowIndexes(cleared), []);
});

test('two non-adjacent lines clear with their own independent shift', () => {
  const grid = emptyRows(TOTAL_HEIGHT);
  const top = grid[0];
  const middle = grid[11];
  for (const y of [10, 12]) {
    const row = grid[y];
    if (row === undefined) {
      continue;
    }
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      row[x] = 'Z';
    }
  }
  if (top !== undefined && middle !== undefined) {
    top[8] = 'J';
    middle[2] = 'T';
  }
  const board = boardFromRows(grid);
  assert.deepEqual(fullRowIndexes(board), [10, 12]);

  const cleared = clearFullRows(board);
  assert.equal(cleared.height, TOTAL_HEIGHT);
  assert.equal(cleared.rows[2]?.[8], 'J', 'rows above both cleared lines drop by two');
  assert.equal(cleared.rows[12]?.[2], 'T', 'a row between the two lines drops by one');
  assert.equal(cleared.rows[13]?.[2], null, 'rows below the lowest cleared line do not move');
  assert.deepEqual(fullRowIndexes(cleared), []);
});

test('four simultaneous lines clear in one call and shift the stack by four', () => {
  const grid = emptyRows(TOTAL_HEIGHT);
  const marker = grid[15];
  if (marker !== undefined) {
    marker[7] = 'T';
  }
  for (const y of [18, 19, 20, 21]) {
    const row = grid[y];
    if (row === undefined) {
      continue;
    }
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      row[x] = 'I';
    }
  }
  const board = boardFromRows(grid);
  assert.deepEqual(fullRowIndexes(board), [18, 19, 20, 21]);

  const cleared = clearFullRows(board);
  assert.equal(cleared.rows[19]?.[7], 'T', 'the stack above a tetris drops four rows');
  assert.equal(cleared.rows[21]?.[7], null);
  assert.deepEqual(fullRowIndexes(cleared), []);
});

test('drop distance measures how far a piece falls before it rests', () => {
  const board = createBoard();
  const distance = dropDistance(board, 'T', 0, SPAWN_POSITIONS.T);
  assert.equal(distance, TOTAL_HEIGHT - 2, 'a floating spawn state rests with its box floor on the field floor');

  const resting = { x: SPAWN_POSITIONS.T.x, y: SPAWN_POSITIONS.T.y + distance };
  assert.equal(canPlace(board, 'T', 0, resting), true);
  assert.equal(canPlace(board, 'T', 0, { x: resting.x, y: resting.y + 1 }), false, 'one further step must be blocked');
});

test('the landing position is where the ghost piece would be drawn', () => {
  const board = fieldWithFilled([TOTAL_HEIGHT - 1]);
  const landing = landingPosition(board, 'T', 0, SPAWN_POSITIONS.T);
  assert.equal(landing.y, TOTAL_HEIGHT - 3, 'the piece rests on top of a full floor row');
  assert.equal(canPlace(board, 'T', 0, landing), true);
  assert.equal(canPlace(board, 'T', 0, { x: landing.x, y: landing.y + 1 }), false);
  assert.equal(dropDistance(board, 'T', 0, SPAWN_POSITIONS.T), landing.y - SPAWN_POSITIONS.T.y);
});

test('a resting piece leaves exactly the gap below it that the stack allows', () => {
  const grid = emptyRows(TOTAL_HEIGHT);
  const floorRow = grid[TOTAL_HEIGHT - 1];
  if (floorRow !== undefined) {
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      if (x !== 4 && x !== 5) {
        floorRow[x] = 'S';
      }
    }
  }
  const board = boardFromRows(grid);
  const landing = landingPosition(board, 'O', 0, { x: 4, y: SPAWN_POSITIONS.O.y });
  assert.equal(landing.y, TOTAL_HEIGHT - 2, 'O drops through the gap to the floor');
  assert.equal(board.rows[TOTAL_HEIGHT - 1]?.[4], null, 'the gap stays open under a resting O');
  assert.equal(board.rows[TOTAL_HEIGHT - 1]?.[5], null, 'the gap stays open under a resting O');
});
