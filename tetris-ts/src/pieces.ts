// Tetromino geometry for the Super Rotation System.
//
// The reference describes unobstructed SRS rotation as a pure mathematical
// rotation about one point: the centre of a mino for J, L, S, T and Z, and a
// gridline intersection for I and O. That is exactly a matrix rotation inside
// a 3x3 box, and a 4x4 or 2x2 box respectively, so every orientation here is
// derived from the spawn matrix instead of being typed out by hand.

export type PieceKind = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z';

export type RotationState = 0 | 1 | 2 | 3;

export type Offset = { readonly x: number; readonly y: number };

export type Matrix = readonly (readonly boolean[])[];

export const PIECE_KINDS: readonly PieceKind[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

const F = false;
const T = true;

/**
 * Spawn orientations, one per piece. J, L and T spawn flat-side first, I, S and
 * Z spawn in their upper horizontal state, and the 3x3 boxes keep their bottom
 * row empty so those pieces float in the spawn state.
 */
const SPAWN_MATRICES = {
  I: [
    [F, F, F, F],
    [T, T, T, T],
    [F, F, F, F],
    [F, F, F, F],
  ],
  J: [
    [T, F, F],
    [T, T, T],
    [F, F, F],
  ],
  L: [
    [F, F, T],
    [T, T, T],
    [F, F, F],
  ],
  O: [
    [T, T],
    [T, T],
  ],
  S: [
    [F, T, T],
    [T, T, F],
    [F, F, F],
  ],
  T: [
    [F, T, F],
    [T, T, T],
    [F, F, F],
  ],
  Z: [
    [T, T, F],
    [F, T, T],
    [F, F, F],
  ],
} satisfies Record<PieceKind, Matrix>;

/** Bounding box side per piece: 3x3 rotates about a mino centre, 4x4 and 2x2 about a gridline intersection. */
const BOX_SIZES = { I: 4, J: 3, L: 3, O: 2, S: 3, T: 3, Z: 3 } satisfies Record<PieceKind, number>;

const NEXT_STATE: Record<RotationState, RotationState> = { 0: 1, 1: 2, 2: 3, 3: 0 };
const PREVIOUS_STATE: Record<RotationState, RotationState> = { 0: 3, 1: 0, 2: 1, 3: 2 };

function emptySquare(size: number): boolean[][] {
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y = y + 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x = x + 1) {
      row.push(false);
    }
    rows.push(row);
  }
  return rows;
}

/** Rotate a square matrix one step clockwise, mapping (x, y) to (size - 1 - y, x). */
export function rotateMatrixCW(matrix: Matrix): Matrix {
  const size = matrix.length;
  const out = emptySquare(size);
  for (let y = 0; y < size; y = y + 1) {
    for (let x = 0; x < size; x = x + 1) {
      if (matrix[y]?.[x] === true) {
        const targetRow = out[x];
        if (targetRow !== undefined) {
          targetRow[size - 1 - y] = true;
        }
      }
    }
  }
  return out;
}

function cellsOfMatrix(matrix: Matrix): Offset[] {
  const cells: Offset[] = [];
  for (let y = 0; y < matrix.length; y = y + 1) {
    const row = matrix[y];
    if (row === undefined) {
      continue;
    }
    for (let x = 0; x < row.length; x = x + 1) {
      if (row[x] === true) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

function matricesFor(kind: PieceKind): Record<RotationState, Matrix> {
  const spawn = SPAWN_MATRICES[kind];
  const clockwise = rotateMatrixCW(spawn);
  const reverse = rotateMatrixCW(clockwise);
  const counterclockwise = rotateMatrixCW(reverse);
  return { 0: spawn, 1: clockwise, 2: reverse, 3: counterclockwise };
}

const STATE_MATRICES = {
  I: matricesFor('I'),
  J: matricesFor('J'),
  L: matricesFor('L'),
  O: matricesFor('O'),
  S: matricesFor('S'),
  T: matricesFor('T'),
  Z: matricesFor('Z'),
} satisfies Record<PieceKind, Record<RotationState, Matrix>>;

const STATE_CELLS = {
  I: cellsForKind('I'),
  J: cellsForKind('J'),
  L: cellsForKind('L'),
  O: cellsForKind('O'),
  S: cellsForKind('S'),
  T: cellsForKind('T'),
  Z: cellsForKind('Z'),
} satisfies Record<PieceKind, Record<RotationState, readonly Offset[]>>;

function cellsForKind(kind: PieceKind): Record<RotationState, readonly Offset[]> {
  const matrices = STATE_MATRICES[kind];
  return {
    0: cellsOfMatrix(matrices[0]),
    1: cellsOfMatrix(matrices[1]),
    2: cellsOfMatrix(matrices[2]),
    3: cellsOfMatrix(matrices[3]),
  };
}

/** The occupied cells of a piece in a rotation state, relative to the top-left of its bounding box. */
export function cellsOf(kind: PieceKind, state: RotationState): readonly Offset[] {
  return STATE_CELLS[kind][state];
}

/** The bounding-box matrix of a piece in a rotation state. */
export function matrixOf(kind: PieceKind, state: RotationState): Matrix {
  return STATE_MATRICES[kind][state];
}

/** The spawn matrix of a piece, identical to matrixOf(kind, 0). */
export function spawnMatrixOf(kind: PieceKind): Matrix {
  return matrixOf(kind, 0);
}

export function boxSizeOf(kind: PieceKind): number {
  return BOX_SIZES[kind];
}

export function nextState(state: RotationState): RotationState {
  return NEXT_STATE[state];
}

export function prevState(state: RotationState): RotationState {
  return PREVIOUS_STATE[state];
}
