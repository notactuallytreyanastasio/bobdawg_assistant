/**
 * Frame rendering. A frame is plain text built from the game state, so it can
 * be asserted line by line without a terminal. Only the visible field is drawn:
 * the hidden buffer rows exist to make spawning and top-out well-defined, not
 * to be watched. A cell is two characters wide because terminal cells are
 * roughly twice as tall as they are wide, and the ghost needs a glyph that is
 * distinguishable from a placed cell without needing colour.
 */
import {
  BUFFER_HEIGHT,
  FIELD_WIDTH,
  TOTAL_HEIGHT,
  type Board,
} from '../board.ts';
import { cellsOf, type Offset } from '../pieces.ts';
import { ghostPositionOf, type GameState } from '../game.ts';

export const CELL_EMPTY = '  ';
export const CELL_SOLID = '██';
export const CELL_GHOST = '░░';

const PANEL_WIDTH = 16;
const FIELD_LINE_WIDTH = FIELD_WIDTH * 2 + 4;
export const FRAME_WIDTH = FIELD_LINE_WIDTH + 1 + PANEL_WIDTH;

export type Glyph = 'empty' | 'stack' | 'ghost' | 'active';

function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

function stackCellsOf(board: Board): (readonly [number, number])[] {
  const cells: (readonly [number, number])[] = [];
  for (let y = 0; y < board.height; y = y + 1) {
    const row = board.rows[y];
    if (row === undefined) {
      continue;
    }
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      if (row[x] !== null) {
        cells.push([x, y]);
      }
    }
  }
  return cells;
}

function absoluteCells(
  kind: GameState['active']['kind'],
  state: GameState['active']['state'],
  x: number,
  y: number,
): (readonly [number, number])[] {
  return cellsOf(kind, state).map((offset: Offset): readonly [number, number] => [
    x + offset.x,
    y + offset.y,
  ]);
}

/** The visible rows of the field, top row first, as glyph names. */
function glyphsOf(state: GameState): Glyph[][] {
  const marks = new Map<string, Glyph>();
  for (const cell of stackCellsOf(state.board)) {
    marks.set(keyOf(cell[0], cell[1]), 'stack');
  }
  // A finished game shows the board it ended on. The piece left in the state is
  // the one that had nowhere to spawn, so drawing it would put two pieces in the
  // same cells. A ghost cell never overwrites a placed cell, and the active
  // piece is drawn last so it always covers its own ghost when the two touch.
  if (state.status === 'playing') {
    const ghost = ghostPositionOf(state);
    for (const cell of absoluteCells(state.active.kind, state.active.state, ghost.x, ghost.y)) {
      if (!marks.has(keyOf(cell[0], cell[1]))) {
        marks.set(keyOf(cell[0], cell[1]), 'ghost');
      }
    }
    for (const cell of absoluteCells(
      state.active.kind,
      state.active.state,
      state.active.position.x,
      state.active.position.y,
    )) {
      marks.set(keyOf(cell[0], cell[1]), 'active');
    }
  }

  const glyphs: Glyph[][] = [];
  for (let y = BUFFER_HEIGHT; y < TOTAL_HEIGHT; y = y + 1) {
    const row: Glyph[] = [];
    for (let x = 0; x < FIELD_WIDTH; x = x + 1) {
      row.push(marks.get(keyOf(x, y)) ?? 'empty');
    }
    glyphs.push(row);
  }
  return glyphs;
}

function glyphCell(glyph: Glyph): string {
  if (glyph === 'stack') {
    return CELL_SOLID;
  }
  if (glyph === 'active') {
    return CELL_SOLID;
  }
  if (glyph === 'ghost') {
    return CELL_GHOST;
  }
  return CELL_EMPTY;
}

function fieldLineOf(row: readonly Glyph[]): string {
  const cells = row.map(glyphCell);
  return `│ ${cells.join('')} │`;
}

function borderLine(top: boolean): string {
  const start = top ? '┌' : '└';
  const end = top ? '┐' : '┘';
  const dashes: string[] = [];
  for (let index = 0; index < FIELD_LINE_WIDTH - 2; index = index + 1) {
    dashes.push('─');
  }
  return `${start}${dashes.join('')}${end}`;
}

function pad(line: string): string {
  const width = [...line].length;
  const missing: string[] = [];
  for (let index = width; index < PANEL_WIDTH; index = index + 1) {
    missing.push(' ');
  }
  return `${line}${missing.join('')}`.slice(0, PANEL_WIDTH);
}

function spacesOf(width: number): string {
  const spaces: string[] = [];
  for (let index = 0; index < width; index = index + 1) {
    spaces.push(' ');
  }
  return spaces.join('');
}

function panelLinesOf(state: GameState): string[] {
  const preview = state.queue.slice(0, 7).join(' ');
  const hold = state.hold ?? '-';
  const streak = state.combo > 0 ? state.combo - 1 : 0;
  return [
    'NEXT',
    preview,
    '',
    `HOLD ${hold}`,
    '',
    `SCORE ${state.score}`,
    `LEVEL ${state.level}`,
    `LINES ${state.lines}`,
    `COMBO ${streak}`,
  ];
}

/** The text lines of one frame, top line first. */
export function frameOf(state: GameState): string[] {
  const glyphs = glyphsOf(state);
  const panel = panelLinesOf(state);
  const blank = pad('');
  const lines: string[] = [];

  lines.push(`${borderLine(true)} ${blank}`);
  for (let row = 0; row < glyphs.length; row = row + 1) {
    const label = panel[row - 1] ?? '';
    lines.push(`${fieldLineOf(glyphs[row] ?? [])} ${pad(label)}`);
  }
  lines.push(`${borderLine(false)} ${blank}`);

  const filler = `${spacesOf(FIELD_LINE_WIDTH)} `;
  lines.push(`${filler}${pad('')}`);
  lines.push(`${filler}${pad(state.status === 'over' ? 'GAME OVER   q quits' : '')}`);
  return lines;
}
