// The playfield: a ten-column grid of twenty visible rows plus a two-row
// hidden spawn buffer. Collision uses occupied cells only, never the bounding
// box, because the J, L, S, T and Z spawn state floats one row above its box
// floor and the I spawn sits two rows above it, so the box must be allowed to
// descend below the floor.

import { cellsOf, type PieceKind, type RotationState } from './pieces.ts';

export type Cell = PieceKind | null;

export type Position = { readonly x: number; readonly y: number };

export interface Board {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly (readonly Cell[])[];
}

export const FIELD_WIDTH = 10;
export const FIELD_HEIGHT = 20;
export const BUFFER_HEIGHT = 2;

export const TOTAL_WIDTH = FIELD_WIDTH;
export const TOTAL_HEIGHT = FIELD_HEIGHT + BUFFER_HEIGHT;

/**
 * Guideline spawn columns: I and O spawn centrally, the three-wide pieces spawn
 * rounded to the left, and every box starts at the top of the hidden buffer.
 */
export const SPAWN_POSITIONS: Record<PieceKind, Position> = {
  I: { x: 3, y: 0 },
  J: { x: 3, y: 0 },
  L: { x: 3, y: 0 },
  O: { x: 4, y: 0 },
  S: { x: 3, y: 0 },
  T: { x: 3, y: 0 },
  Z: { x: 3, y: 0 },
};

function emptyRowOf(width: number): Cell[] {
  const row: Cell[] = [];
  for (let x = 0; x < width; x = x + 1) {
    row.push(null);
  }
  return row;
}

function emptyRowsOf(count: number, width: number): Cell[][] {
  const rows: Cell[][] = [];
  for (let y = 0; y < count; y = y + 1) {
    rows.push(emptyRowOf(width));
  }
  return rows;
}

export function createBoard(width: number = TOTAL_WIDTH, height: number = TOTAL_HEIGHT): Board {
  return { width, height, rows: emptyRowsOf(height, width) };
}

/**
 * Whether a cell stops a piece. Side walls and the floor block, and so does any
 * occupied cell, but everything above the top of the field is free space, which
 * is what lets a piece rotate while its box is partly outside the field.
 */
export function isBlocked(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= board.width) {
    return true;
  }
  if (y >= board.height) {
    return true;
  }
  if (y < 0) {
    return false;
  }
  return board.rows[y]?.[x] !== null;
}

export function canPlace(board: Board, kind: PieceKind, state: RotationState, position: Position): boolean {
  for (const offset of cellsOf(kind, state)) {
    if (isBlocked(board, position.x + offset.x, position.y + offset.y)) {
      return false;
    }
  }
  return true;
}

/** Lock a piece into the field, returning a new board and leaving the input untouched. */
export function placePiece(board: Board, kind: PieceKind, state: RotationState, position: Position): Board {
  const rows: Cell[][] = board.rows.map((row: readonly Cell[]): Cell[] => [...row]);
  for (const offset of cellsOf(kind, state)) {
    const y = position.y + offset.y;
    const x = position.x + offset.x;
    const row = rows[y];
    if (y < 0 || row === undefined) {
      continue;
    }
    row[x] = kind;
  }
  return { width: board.width, height: board.height, rows };
}

export function rowIsFull(board: Board, y: number): boolean {
  const row = board.rows[y];
  if (row === undefined) {
    return false;
  }
  for (let x = 0; x < board.width; x = x + 1) {
    if (row[x] === null) {
      return false;
    }
  }
  return true;
}

/** Indexes of every full row, ascending from the bottom of the field upward. */
export function fullRowIndexes(board: Board): number[] {
  const indexes: number[] = [];
  for (let y = 0; y < board.height; y = y + 1) {
    if (rowIsFull(board, y)) {
      indexes.push(y);
    }
  }
  return indexes;
}

/** Remove every full row, shifting the stack above them down and keeping the field height. */
export function clearFullRows(board: Board): Board {
  const full = fullRowIndexes(board);
  if (full.length === 0) {
    return board;
  }
  const remaining: Cell[][] = [];
  for (let y = 0; y < board.height; y = y + 1) {
    const row = board.rows[y];
    if (row !== undefined && !full.includes(y)) {
      remaining.push([...row]);
    }
  }
  const rows = [...emptyRowsOf(board.height - remaining.length, board.width), ...remaining];
  return { width: board.width, height: board.height, rows };
}

/** How many rows a piece falls from a position before it rests. */
export function dropDistance(board: Board, kind: PieceKind, state: RotationState, position: Position): number {
  let distance = 0;
  while (
    distance < board.height &&
    canPlace(board, kind, state, { x: position.x, y: position.y + distance + 1 })
  ) {
    distance = distance + 1;
  }
  return distance;
}

/** Where a piece would be drawn as the ghost piece, and where it would lock on a hard drop. */
export function landingPosition(board: Board, kind: PieceKind, state: RotationState, position: Position): Position {
  return { x: position.x, y: position.y + dropDistance(board, kind, state, position) };
}
