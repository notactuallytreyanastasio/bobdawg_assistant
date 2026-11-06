/**
 * Rotation with the published wall-kick tables.
 *
 * The reference tables are written in a y-up coordinate system and use the
 * orientation letters L and R for the left and right states. This engine counts
 * states 0 to 3 clockwise from the spawn state and measures y downward, so the
 * y sign of every published offset is negated once, here, and nowhere else.
 * Physical direction is preserved by that negation: a published upward kick is
 * still an upward kick, it is just written with a negative number.
 */
import { type Board, type Position, canPlace } from './board.ts';
import {
  type Offset,
  type PieceKind,
  type RotationState,
  nextState,
  prevState,
} from './pieces.ts';

export type RotationDirection = 'cw' | 'ccw';

export type RotationOutcome =
  | { readonly kind: 'rotated'; readonly state: RotationState; readonly position: Position }
  | { readonly kind: 'blocked' };

type TransitionKey = '01' | '10' | '12' | '21' | '23' | '32' | '30' | '03';

interface TransitionTable {
  readonly '01': readonly Offset[];
  readonly '10': readonly Offset[];
  readonly '12': readonly Offset[];
  readonly '21': readonly Offset[];
  readonly '23': readonly Offset[];
  readonly '32': readonly Offset[];
  readonly '30': readonly Offset[];
  readonly '03': readonly Offset[];
}

const TRANSITION_KEYS: readonly TransitionKey[] = ['01', '10', '12', '21', '23', '32', '30', '03'];

function offset(x: number, y: number): Offset {
  return { x, y };
}

const ZERO: readonly Offset[] = [offset(0, 0)];

/**
 * The J, L, S, T and Z pieces share one table. Rows 0->R and 2->R are equal, as
 * the reference states, and so are 2->L and 0->L, R->0 and R->2, L->0 and L->2.
 */
const ROUNDED: TransitionTable = {
  // published 0->R: (0,0),(-1,0),(-1,+1),(0,-2),(-1,-2)
  '01': [offset(0, 0), offset(-1, 0), offset(-1, -1), offset(0, 2), offset(-1, 2)],
  // published R->0: (0,0),(+1,0),(+1,-1),(0,+2),(+1,+2)
  '10': [offset(0, 0), offset(1, 0), offset(1, 1), offset(0, -2), offset(1, -2)],
  // published R->2: (0,0),(+1,0),(+1,-1),(0,+2),(+1,+2)
  '12': [offset(0, 0), offset(1, 0), offset(1, 1), offset(0, -2), offset(1, -2)],
  // published 2->R: (0,0),(-1,0),(-1,+1),(0,-2),(-1,-2)
  '21': [offset(0, 0), offset(-1, 0), offset(-1, -1), offset(0, 2), offset(-1, 2)],
  // published 2->L: (0,0),(+1,0),(+1,+1),(0,-2),(+1,-2)
  '23': [offset(0, 0), offset(1, 0), offset(1, -1), offset(0, 2), offset(1, 2)],
  // published L->2: (0,0),(-1,0),(-1,-1),(0,+2),(-1,+2)
  '32': [offset(0, 0), offset(-1, 0), offset(-1, 1), offset(0, -2), offset(-1, -2)],
  // published L->0: (0,0),(-1,0),(-1,-1),(0,+2),(-1,+2)
  '30': [offset(0, 0), offset(-1, 0), offset(-1, 1), offset(0, -2), offset(-1, -2)],
  // published 0->L: (0,0),(+1,0),(+1,+1),(0,-2),(+1,-2)
  '03': [offset(0, 0), offset(1, 0), offset(1, -1), offset(0, 2), offset(1, 2)],
};

const STRAIGHT: TransitionTable = {
  // published 0->R: (0,0),(-2,0),(+1,0),(-2,-1),(+1,+2)
  '01': [offset(0, 0), offset(-2, 0), offset(1, 0), offset(-2, 1), offset(1, -2)],
  // published R->0: (0,0),(+2,0),(-1,0),(+2,+1),(-1,-2)
  '10': [offset(0, 0), offset(2, 0), offset(-1, 0), offset(2, -1), offset(-1, 2)],
  // published R->2: (0,0),(-1,0),(+2,0),(-1,+2),(+2,-1)
  '12': [offset(0, 0), offset(-1, 0), offset(2, 0), offset(-1, -2), offset(2, 1)],
  // published 2->R: (0,0),(+1,0),(-2,0),(+1,-2),(-2,+1)
  '21': [offset(0, 0), offset(1, 0), offset(-2, 0), offset(1, 2), offset(-2, -1)],
  // published 2->L: (0,0),(+2,0),(-1,0),(+2,+1),(-1,-2)
  '23': [offset(0, 0), offset(2, 0), offset(-1, 0), offset(2, -1), offset(-1, 2)],
  // published L->2: (0,0),(-2,0),(+1,0),(-2,-1),(+1,+2)
  '32': [offset(0, 0), offset(-2, 0), offset(1, 0), offset(-2, 1), offset(1, -2)],
  // published L->0: (0,0),(+1,0),(-2,0),(+1,-2),(-2,+1)
  '30': [offset(0, 0), offset(1, 0), offset(-2, 0), offset(1, 2), offset(-2, -1)],
  // published 0->L: (0,0),(-1,0),(+2,0),(-1,+2),(+2,-1)
  '03': [offset(0, 0), offset(-1, 0), offset(2, 0), offset(-1, -2), offset(2, 1)],
};

/** The square piece changes shape under no rotation, so it never needs a kick. */
const SQUARE: TransitionTable = {
  '01': ZERO,
  '10': ZERO,
  '12': ZERO,
  '21': ZERO,
  '23': ZERO,
  '32': ZERO,
  '30': ZERO,
  '03': ZERO,
};

const TABLE: Record<PieceKind, TransitionTable> = {
  I: STRAIGHT,
  J: ROUNDED,
  L: ROUNDED,
  O: SQUARE,
  S: ROUNDED,
  T: ROUNDED,
  Z: ROUNDED,
};

function transitionKey(from: RotationState, to: RotationState): TransitionKey | undefined {
  const written = `${from}${to}`;
  for (const key of TRANSITION_KEYS) {
    if (key === written) {
      return key;
    }
  }
  return undefined;
}

/**
 * The kick tests for one transition, in the order the engine must try them.
 * An undeclared pair of states falls back to the single identity test, which
 * makes a rotation between impossible states behave like a plain blocked
 * rotation instead of producing a wrong offset.
 */
export function kickTests(kind: PieceKind, from: RotationState, to: RotationState): readonly Offset[] {
  const table = TABLE[kind];
  const key = transitionKey(from, to);
  if (key === undefined) {
    return ZERO;
  }
  return table[key];
}

/**
 * Rotate a piece, trying every published offset in order and keeping the first
 * placement that fits. The returned position is where the rotated piece belongs;
 * the caller keeps the original when the outcome is blocked.
 */
export function rotate(
  board: Board,
  kind: PieceKind,
  state: RotationState,
  position: Position,
  direction: RotationDirection,
): RotationOutcome {
  const target = direction === 'cw' ? nextState(state) : prevState(state);
  for (const offset of kickTests(kind, state, target)) {
    const candidate = { x: position.x + offset.x, y: position.y + offset.y };
    if (canPlace(board, kind, target, candidate)) {
      return { kind: 'rotated', state: target, position: candidate };
    }
  }
  return { kind: 'blocked' };
}
