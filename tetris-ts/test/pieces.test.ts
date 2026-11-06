import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PIECE_KINDS,
  boxSizeOf,
  cellsOf,
  matrixOf,
  nextState,
  prevState,
  rotateMatrixCW,
  spawnMatrixOf,
  type Offset,
  type PieceKind,
  type RotationState,
} from '../src/pieces.ts';

type Matrix = readonly (readonly boolean[])[];

const F = false;
const T = true;

// Spawn orientations transcribed from the SRS reference: every piece spawns
// horizontally, J/L/T flat-side first, I/S/Z in their upper horizontal state.
const SPAWN: Record<PieceKind, Matrix> = {
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
};

const BOX: Record<PieceKind, number> = { I: 4, J: 3, L: 3, O: 2, S: 3, T: 3, Z: 3 };

const STATES: readonly RotationState[] = [0, 1, 2, 3];
const NON_O = PIECE_KINDS.filter((kind: PieceKind): boolean => kind !== 'O');

function extentOf(cells: readonly Offset[]): { width: number; height: number } {
  const xs = cells.map((cell: Offset): number => cell.x);
  const ys = cells.map((cell: Offset): number => cell.y);
  return {
    width: Math.max(...xs) - Math.min(...xs) + 1,
    height: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

function keyOf(cells: readonly Offset[]): string {
  return cells.map((cell: Offset): string => `${cell.x},${cell.y}`).sort().join(' ');
}

test('the seven tetrominoes are present in canonical order', () => {
  assert.deepEqual([...PIECE_KINDS], ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
});

test('spawn orientation matches the SRS reference for every piece', () => {
  for (const kind of PIECE_KINDS) {
    assert.deepEqual(matrixOf(kind, 0), [...SPAWN[kind]].map((row: readonly boolean[]) => [...row]), `spawn matrix of ${kind}`);
    assert.deepEqual(matrixOf(kind, 0), [...spawnMatrixOf(kind)].map((row: readonly boolean[]) => [...row]), `spawn accessor of ${kind}`);
  }
});

test('every rotation state holds exactly four distinct cells', () => {
  for (const kind of PIECE_KINDS) {
    for (const state of STATES) {
      const cells = cellsOf(kind, state);
      assert.equal(cells.length, 4, `${kind} at state ${state} has ${cells.length} cells`);
      const unique = new Set(cells.map((cell: Offset): string => `${cell.x},${cell.y}`));
      assert.equal(unique.size, 4, `${kind} at state ${state} has overlapping cells`);
    }
  }
});

test('every cell lies inside the piece bounding box', () => {
  for (const kind of PIECE_KINDS) {
    const size = boxSizeOf(kind);
    assert.equal(size, BOX[kind], `box size of ${kind}`);
    for (const state of STATES) {
      for (const cell of cellsOf(kind, state)) {
        assert.ok(cell.x >= 0 && cell.x < size, `${kind} at state ${state} spills x=${cell.x}`);
        assert.ok(cell.y >= 0 && cell.y < size, `${kind} at state ${state} spills y=${cell.y}`);
      }
    }
  }
});

test('every piece spawns horizontally, spanning at least as wide as tall', () => {
  for (const kind of PIECE_KINDS) {
    const { width, height } = extentOf(cellsOf(kind, 0));
    assert.ok(width >= height, `${kind} spawns vertically: ${width}x${height}`);
  }
  assert.deepEqual(extentOf(cellsOf('I', 0)), { width: 4, height: 1 });
  assert.deepEqual(extentOf(cellsOf('O', 0)), { width: 2, height: 2 });
});

test('the I piece alternates horizontal and vertical through its states', () => {
  const axisOf = (kind: PieceKind, state: RotationState): 'horizontal' | 'vertical' | 'square' => {
    const { width, height } = extentOf(cellsOf(kind, state));
    return width > height ? 'horizontal' : height > width ? 'vertical' : 'square';
  };
  assert.equal(axisOf('I', 0), 'horizontal');
  assert.equal(axisOf('I', 1), 'vertical');
  assert.equal(axisOf('I', 2), 'horizontal');
  assert.equal(axisOf('I', 3), 'vertical');
});

test('the O piece keeps its cells in every state while every other piece changes', () => {
  const spawnKeys = PIECE_KINDS.map((kind: PieceKind): string => keyOf(cellsOf(kind, 0)));
  const first = spawnKeys[PIECE_KINDS.indexOf('O')];
  const changed = new Set<string>();
  for (const kind of NON_O) {
    for (const state of STATES) {
      const key = keyOf(cellsOf(kind, state));
      if (key !== keyOf(cellsOf(kind, 0))) changed.add(`${kind}:${state}`);
    }
  }
  assert.equal(first, keyOf(cellsOf('O', 2)), 'O must not move when rotated');
  assert.equal(changed.size, 3 * NON_O.length, 'every non-O piece must differ in states 1, 2 and 3');
});

test('four clockwise rotations return to the spawn state', () => {
  for (const kind of PIECE_KINDS) {
    const start = cellsOf(kind, 0);
    let state: RotationState = 0;
    for (let turn = 0; turn < 4; turn = turn + 1) {
      state = nextState(state);
    }
    assert.equal(state, 0);
    assert.deepEqual(cellsOf(kind, state), start, `${kind} did not survive four turns`);
    assert.equal(prevState(nextState(0)), 0);
  }
});

test('clockwise rotation of a matrix is a true rotation about the box centre', () => {
  const corner: Matrix = [[T, F, F], [F, F, F], [F, F, F]];
  assert.deepEqual([...rotateMatrixCW(corner)].map((row: readonly boolean[]) => [...row]), [
    [F, F, T],
    [F, F, F],
    [F, F, F],
  ]);
  const leftColumn: Matrix = [[T, F], [T, F]];
  assert.deepEqual([...rotateMatrixCW(leftColumn)].map((row: readonly boolean[]) => [...row]), [
    [T, T],
    [F, F],
  ]);
});

test('orientations are the spawn matrix rotated clockwise inside its own box', () => {
  const asRows = (matrix: Matrix): boolean[][] => [...matrix].map((row: readonly boolean[]) => [...row]);
  for (const kind of PIECE_KINDS) {
    let matrix = spawnMatrixOf(kind);
    for (let state = 1; state <= 3; state = state + 1) {
      matrix = rotateMatrixCW(matrix);
      const expected = asRows(matrix);
      assert.deepEqual(
        asRows(matrixOf(kind, state as RotationState)),
        expected,
        `${kind} at state ${state} is not the spawn matrix rotated ${state} times`,
      );
    }
    assert.deepEqual(asRows(rotateMatrixCW(matrix)), asRows(spawnMatrixOf(kind)), `${kind} box does not close`);
  }
});
