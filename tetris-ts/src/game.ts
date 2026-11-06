/**
 * The game state and the one function that changes it.
 *
 * Everything here is pure: the state is plain data, the random source arrives as
 * an argument so a test can replay a sequence, and the clock lives with whoever
 * calls tick. An action on a finished game returns the state untouched, so the
 * terminal layer never has to guard its own input loop.
 */
import {
  BUFFER_HEIGHT,
  SPAWN_POSITIONS,
  type Board,
  type Position,
  canPlace,
  clearFullRows,
  createBoard,
  fullRowIndexes,
  landingPosition,
  placePiece,
} from './board.ts';
import { PIECE_KINDS, cellsOf, type PieceKind, type RotationState } from './pieces.ts';
import { rotate, type RotationDirection } from './rotation.ts';

export type Random = () => number;

export type Action =
  | 'left'
  | 'right'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'soft-drop'
  | 'hard-drop'
  | 'hold'
  | 'tick';

export type GameStatus = 'playing' | 'over';

export type ActivePiece = {
  readonly kind: PieceKind;
  readonly state: RotationState;
  readonly position: Position;
};

export type GameState = {
  readonly board: Board;
  readonly active: ActivePiece;
  readonly queue: readonly PieceKind[];
  readonly bag: readonly PieceKind[];
  readonly hold: PieceKind | null;
  readonly holdUsed: boolean;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly combo: number;
  readonly status: GameStatus;
};

export const PREVIEW_SIZE = 7;
export const LINES_PER_LEVEL = 40;
export const MAX_LEVEL = 15;
export const SOFT_DROP_POINTS = 1;
export const HARD_DROP_POINTS = 2;
export const COMBO_BONUS_UNIT = 50;
const BASE_INTERVAL_MS = 800;
const INTERVAL_DECAY = 0.85;
const MIN_INTERVAL_MS = 50;
const LINE_SCORES: readonly number[] = [0, 100, 300, 500, 800];

/** The level the given number of cleared lines has reached, clamped at the top. */
export function levelOf(lines: number): number {
  return Math.min(MAX_LEVEL, Math.floor(lines / LINES_PER_LEVEL) + 1);
}

/** Milliseconds between gravity steps at a level, shrinking geometrically to a floor. */
export function gravityIntervalMs(level: number): number {
  return Math.max(
    MIN_INTERVAL_MS,
    Math.round(BASE_INTERVAL_MS * Math.pow(INTERVAL_DECAY, Math.max(0, level - 1))),
  );
}

/** Fisher-Yates over the piece kinds, driven by the injected generator. */
function shuffle(random: Random): PieceKind[] {
  const result: PieceKind[] = [...PIECE_KINDS];
  for (let index = result.length - 1; index > 0; index = index - 1) {
    const drawn = random();
    const other = Math.min(index, Math.max(0, Math.floor(drawn * (index + 1))));
    const left = result[index];
    const right = result[other];
    if (left === undefined || right === undefined) {
      continue;
    }
    result[index] = right;
    result[other] = left;
  }
  return result;
}

type Drawn = {
  readonly kind: PieceKind;
  readonly bag: readonly PieceKind[];
};

/** Take the next kind from the bag, refilling with a fresh shuffle when empty. */
function draw(bag: readonly PieceKind[], random: Random): Drawn {
  const source = bag.length === 0 ? shuffle(random) : bag;
  const first = source[0];
  // A fresh shuffle always yields seven kinds, so the fallback keeps this total
  // without pretending an impossible empty bag is a legal game event.
  const kind: PieceKind = first === undefined ? 'O' : first;
  return { kind, bag: source.slice(1) };
}

/** Grow the queue to the preview size, drawing from the bag as needed. */
function refill(
  queue: readonly PieceKind[],
  bag: readonly PieceKind[],
  random: Random,
): { queue: readonly PieceKind[]; bag: readonly PieceKind[] } {
  const next: PieceKind[] = [...queue];
  let remaining = bag;
  while (next.length < PREVIEW_SIZE) {
    const drawn = draw(remaining, random);
    next.push(drawn.kind);
    remaining = drawn.bag;
  }
  return { queue: next, bag: remaining };
}

function spawnInto(
  kind: PieceKind,
  queue: readonly PieceKind[],
  bag: readonly PieceKind[],
  board: Board,
  random: Random,
): { active: ActivePiece; queue: readonly PieceKind[]; bag: readonly PieceKind[]; status: GameStatus } {
  const filled = refill(queue, bag, random);
  const position = SPAWN_POSITIONS[kind];
  const active: ActivePiece = { kind, state: 0, position };
  return {
    active,
    queue: filled.queue,
    bag: filled.bag,
    status: canPlace(board, kind, 0, position) ? 'playing' : 'over',
  };
}

/** Deal the first piece and fill the preview, giving a state ready to play. */
export function createGame(random: Random, board: Board = createBoard()): GameState {
  const first = draw([], random);
  const spawned = spawnInto(first.kind, [], first.bag, board, random);
  return {
    board,
    active: spawned.active,
    queue: spawned.queue,
    bag: spawned.bag,
    hold: null,
    holdUsed: false,
    score: 0,
    lines: 0,
    level: levelOf(0),
    combo: 0,
    status: spawned.status,
  };
}

/** Where a hard drop would land the active piece, which is the ghost piece. */
export function ghostPositionOf(state: GameState): Position {
  return landingPosition(state.board, state.active.kind, state.active.state, state.active.position);
}

function moveBy(state: GameState, dx: number, dy: number): GameState {
  const candidate: Position = {
    x: state.active.position.x + dx,
    y: state.active.position.y + dy,
  };
  if (!canPlace(state.board, state.active.kind, state.active.state, candidate)) {
    return state;
  }
  return { ...state, active: { ...state.active, position: candidate } };
}

function turn(state: GameState, direction: RotationDirection): GameState {
  const outcome = rotate(
    state.board,
    state.active.kind,
    state.active.state,
    state.active.position,
    direction,
  );
  if (outcome.kind === 'blocked') {
    return state;
  }
  return {
    ...state,
    active: { ...state.active, state: outcome.state, position: outcome.position },
  };
}

/**
 * Lock the active piece into the stack, clear rows, score the lock and deal the
 * next piece. The game ends when the lock sits entirely in the hidden buffer
 * rows, or when the next piece has nowhere to spawn.
 */
function lockPiece(state: GameState, extraPoints: number, random: Random): GameState {
  const piece = state.active;
  const cells = cellsOf(piece.kind, piece.state);
  const lockedOut = cells.every((offset) => piece.position.y + offset.y < BUFFER_HEIGHT);
  const placed = placePiece(state.board, piece.kind, piece.state, piece.position);
  const cleared = fullRowIndexes(placed).length;
  const board = clearFullRows(placed);

  const level = state.level;
  const lineScore = cleared === 0 ? 0 : (LINE_SCORES[cleared] ?? 0) * level;
  const combo = cleared === 0 ? 0 : state.combo + 1;
  const comboBonus = cleared === 0 ? 0 : COMBO_BONUS_UNIT * Math.max(0, combo - 1) * level;
  const lines = state.lines + cleared;

  const nextKind = state.queue[0];
  if (nextKind === undefined) {
    // The queue is refilled to the preview size at every spawn, so this cannot
    // happen; ending the game keeps the function total rather than throwing.
    return { ...state, board, score: state.score + extraPoints, status: 'over' };
  }

  const spawned = spawnInto(nextKind, state.queue.slice(1), state.bag, board, random);
  const status: GameStatus = lockedOut || spawned.status === 'over' ? 'over' : 'playing';
  return {
    board,
    active: spawned.active,
    queue: spawned.queue,
    bag: spawned.bag,
    hold: state.hold,
    holdUsed: false,
    score: state.score + extraPoints + lineScore + comboBonus,
    lines,
    level: levelOf(lines),
    combo,
    status,
  };
}

function swapHold(state: GameState, random: Random): GameState {
  if (state.holdUsed) {
    return state;
  }
  const swapped: PieceKind | null = state.hold === null ? null : state.hold;
  const stored = state.active.kind;
  if (swapped === null) {
    const nextKind = state.queue[0];
    if (nextKind === undefined) {
      return { ...state, hold: stored, holdUsed: true };
    }
    const spawned = spawnInto(nextKind, state.queue.slice(1), state.bag, state.board, random);
    return {
      ...state,
      active: spawned.active,
      queue: spawned.queue,
      bag: spawned.bag,
      hold: stored,
      holdUsed: true,
      status: spawned.status,
    };
  }
  const position = SPAWN_POSITIONS[swapped];
  const active: ActivePiece = { kind: swapped, state: 0, position };
  const fits = canPlace(state.board, swapped, 0, position);
  return {
    ...state,
    active,
    hold: stored,
    holdUsed: true,
    status: fits ? state.status : 'over',
  };
}

/** Apply one player action. Every action on a finished game returns the state. */
export function applyAction(state: GameState, action: Action, random: Random): GameState {
  if (state.status === 'over') {
    return state;
  }
  switch (action) {
    case 'left': {
      return moveBy(state, -1, 0);
    }
    case 'right': {
      return moveBy(state, 1, 0);
    }
    case 'rotate-cw': {
      return turn(state, 'cw');
    }
    case 'rotate-ccw': {
      return turn(state, 'ccw');
    }
    case 'soft-drop': {
      const moved = moveBy(state, 0, 1);
      if (moved === state) {
        return state;
      }
      return { ...moved, score: moved.score + SOFT_DROP_POINTS };
    }
    case 'hard-drop': {
      const landing = ghostPositionOf(state);
      const distance = landing.y - state.active.position.y;
      const dropped: GameState = {
        ...state,
        active: { ...state.active, position: landing },
      };
      return lockPiece(dropped, distance * HARD_DROP_POINTS, random);
    }
    case 'tick': {
      const moved = moveBy(state, 0, 1);
      if (moved === state) {
        return lockPiece(state, 0, random);
      }
      return moved;
    }
    case 'hold': {
      return swapHold(state, random);
    }
  }
}
