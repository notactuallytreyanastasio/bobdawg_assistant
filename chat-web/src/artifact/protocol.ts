// What the frame says to the page, and what a finished run comes to. Everything that
// arrives here was written by a frame running model code, so nothing is taken on trust: a
// field is read only if it has the right type, and held to its limit before anyone sees it.

import {
  ERROR_CHARS,
  HEIGHT_MAX,
  HEIGHT_MIN,
  LOG_CHARS,
  REPORT_TEXT_CHARS,
} from './limits';

export type FrameReport = {
  readonly nodes: number;
  readonly svgs: number;
  readonly bbox: { readonly w: number; readonly h: number };
  // Shapes outside the axes, a path counting for its segments, and words past a title. The
  // frame stops counting at a few dozen.
  readonly marks: number;
  readonly nan: number;
  readonly text: string;
};

export type FrameMessage =
  | { readonly kind: 'alive' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string; readonly line: number | null }
  | { readonly kind: 'log'; readonly text: string }
  | { readonly kind: 'height'; readonly height: number }
  | ({ readonly kind: 'report' } & FrameReport);

export type RunError = {
  readonly message: string;
  readonly line: number | null;
  readonly source: string | null;
};

export type KillReason = 'silent' | 'reload' | 'flood';

export type RunReport = {
  readonly errors: readonly RunError[];
  readonly logs: readonly string[];
  readonly nodes: number;
  readonly svgs: number;
  readonly bbox: { readonly w: number; readonly h: number };
  readonly marks: number;
  readonly nanAttributes: number;
  readonly text: string;
  readonly timedOut: boolean;
  readonly blocked: boolean;
  readonly killed: KillReason | null;
  readonly truncated: boolean;
  // DATA is short and earlier messages were left out of it, so the data may be in those.
  readonly scant: boolean;
  // The page's own count of what is in DATA, which is what a row count is held against.
  readonly dataLines: number;
};

export type ArtifactRunner = (input: {
  readonly callId: string;
  readonly code: string;
  readonly messages: readonly string[];
  // How many earlier messages were sent with Plot off, which the reader is told at Run.
  readonly withheld: number;
  readonly signal: AbortSignal;
}) => Promise<RunReport>;

export const emptyReport: RunReport = {
  errors: [],
  logs: [],
  nodes: 0,
  svgs: 0,
  bbox: { w: 0, h: 0 },
  marks: 0,
  nanAttributes: 0,
  text: '',
  timedOut: false,
  blocked: false,
  killed: null,
  truncated: false,
  scant: false,
  dataLines: 0,
};

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function size(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function reportOf(data: Readonly<Record<string, unknown>>): FrameMessage | null {
  const box = data['bbox'];
  if (typeof box !== 'object' || box === null) return null;
  const { w: rawW, h: rawH } = box as { readonly w?: unknown; readonly h?: unknown };
  const nodes = count(data['nodes']);
  const svgs = count(data['svgs']);
  const marks = count(data['marks']);
  const nan = count(data['nan']);
  const w = size(rawW);
  const h = size(rawH);
  const text = data['text'];
  if (nodes === null || svgs === null || marks === null || nan === null || w === null || h === null) return null;
  if (typeof text !== 'string') return null;
  return { kind: 'report', nodes, svgs, bbox: { w, h }, marks, nan, text: text.slice(0, REPORT_TEXT_CHARS) };
}

export function parseFrameMessage(value: unknown): FrameMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Readonly<Record<string, unknown>>;
  switch (data['kind']) {
    case 'alive':
      return { kind: 'alive' };
    case 'ready':
      return { kind: 'ready' };
    case 'error': {
      const { message, line } = data;
      if (typeof message !== 'string') return null;
      return { kind: 'error', message: message.slice(0, ERROR_CHARS), line: count(line) };
    }
    case 'log': {
      const { text } = data;
      return typeof text === 'string' ? { kind: 'log', text: text.slice(0, LOG_CHARS) } : null;
    }
    case 'height': {
      const height = size(data['height']);
      if (height === null) return null;
      return { kind: 'height', height: Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.ceil(height))) };
    }
    case 'report':
      return reportOf(data);
    default:
      return null;
  }
}
