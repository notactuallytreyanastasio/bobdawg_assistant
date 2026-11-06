/**
 * Shared fixtures for the suites. This file is never imported by the game, and
 * it deliberately holds no assertions: it only builds the data the suites need.
 */
import { FIELD_WIDTH, TOTAL_HEIGHT, type Board, type Cell } from '../src/board.ts';
import type { PieceKind } from '../src/pieces.ts';
import type { Random } from '../src/game.ts';

/** Occupied cells in fixtures are filled with an arbitrary kind. */
export const FILLER: PieceKind = 'Z';

export function emptyRows(height: number, width: number = FIELD_WIDTH): Cell[][] {
  const rows: Cell[][] = [];
  for (let y = 0; y < height; y = y + 1) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x = x + 1) {
      row.push(null);
    }
    rows.push(row);
  }
  return rows;
}

/** A full field with the listed cells occupied. Coordinates are absolute. */
export function boardWithCells(
  cells: readonly (readonly [number, number])[],
  filler: PieceKind = FILLER,
  height: number = TOTAL_HEIGHT,
): Board {
  const rows = emptyRows(height);
  for (const [x, y] of cells) {
    const row = rows[y];
    if (row !== undefined) {
      row[x] = filler;
    }
  }
  return { width: FIELD_WIDTH, height, rows };
}

/** Every cell of the listed rows, for a stack that has to be complete. */
export function cellsOfRows(rows: readonly number[]): (readonly [number, number])[] {
  const cells: (readonly [number, number])[] = [];
  for (const y of rows) {
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      cells.push([x, y]);
    }
  }
  return cells;
}

/** A generator that replays the given values and repeats the list when exhausted. */
export function randomSequence(values: readonly number[]): Random {
  let index = 0;
  return (): number => {
    const length = values.length;
    const value = length === 0 ? 0.5 : values[index % length] ?? 0.5;
    index = index + 1;
    return value;
  };
}

/** A text snapshot for asserting that a transition left the state untouched. */
export function snapshot(value: unknown): string {
  return JSON.stringify(value) ?? '';
}
