// The rules a running frame lives by, as a pure step over time: given what has happened and
// one more message or tick, what happens next. The clock is an argument, so every rule here
// is tested without waiting.

import {
  CHECK_TIMEOUT_MS,
  ERRORS_KEPT,
  FIRST_CONTACT_MS,
  LOGS_KEPT,
  MESSAGES_PER_SECOND,
  SILENCE_KILL_MS,
} from './limits';
import { emptyReport } from './protocol';
import type { FrameMessage, FrameReport, KillReason, RunError, RunReport } from './protocol';

const SOURCE_LINE_CHARS = 200;

type FrameError = { readonly message: string; readonly line: number | null };

export type SupervisorState = {
  readonly startedAt: number;
  readonly lastSeen: number | null;
  readonly readies: number;
  readonly windowStart: number;
  readonly windowCount: number;
  readonly errors: readonly FrameError[];
  readonly logs: readonly string[];
  readonly report: FrameReport | null;
};

// A message that failed validation arrives as null, and still counts against the budget.
export type SupervisorInput =
  | { readonly type: 'tick' }
  | { readonly type: 'message'; readonly message: FrameMessage | null };

export type Verdict =
  | { readonly type: 'kill'; readonly reason: KillReason }
  | { readonly type: 'timeout' }
  | { readonly type: 'checked' }
  | null;

export type Step = { readonly state: SupervisorState; readonly verdict: Verdict };

export function startSupervisor(now: number): SupervisorState {
  return {
    startedAt: now,
    lastSeen: null,
    readies: 0,
    windowStart: now,
    windowCount: 0,
    errors: [],
    logs: [],
    report: null,
  };
}

function tick(state: SupervisorState, now: number): Step {
  const kill: Verdict = { type: 'kill', reason: 'silent' };
  if (state.lastSeen === null && now - state.startedAt > FIRST_CONTACT_MS) return { state, verdict: kill };
  if (state.lastSeen !== null && now - state.lastSeen > SILENCE_KILL_MS) return { state, verdict: kill };
  if (state.report === null && now - state.startedAt > CHECK_TIMEOUT_MS) {
    return { state, verdict: { type: 'timeout' } };
  }
  return { state, verdict: null };
}

function counted(state: SupervisorState, now: number): SupervisorState {
  const fresh = now - state.windowStart >= 1000;
  return {
    ...state,
    windowStart: fresh ? now : state.windowStart,
    windowCount: fresh ? 1 : state.windowCount + 1,
  };
}

function kept<T>(list: readonly T[], item: T, limit: number): readonly T[] {
  return list.length < limit ? [...list, item] : list;
}

function received(state: SupervisorState, message: FrameMessage, now: number): Step {
  const seen = { ...state, lastSeen: now };
  switch (message.kind) {
    case 'ready':
      // One document loads once. A second load is the frame reloading itself, which would
      // otherwise restart its code with a clean slate as often as it liked.
      if (state.readies > 0) return { state: seen, verdict: { type: 'kill', reason: 'reload' } };
      return { state: { ...seen, readies: 1 }, verdict: null };
    case 'error': {
      const { message: text, line } = message;
      return { state: { ...seen, errors: kept(state.errors, { message: text, line }, ERRORS_KEPT) }, verdict: null };
    }
    case 'log':
      return { state: { ...seen, logs: kept(state.logs, message.text, LOGS_KEPT) }, verdict: null };
    case 'report': {
      if (state.readies === 0 || state.report !== null) return { state: seen, verdict: null };
      const { kind: _kind, ...report } = message;
      return { state: { ...seen, report }, verdict: { type: 'checked' } };
    }
    case 'alive':
    case 'height':
      return { state: seen, verdict: null };
  }
}

export function stepSupervisor(state: SupervisorState, input: SupervisorInput, now: number): Step {
  if (input.type === 'tick') return tick(state, now);
  const spent = counted(state, now);
  if (spent.windowCount > MESSAGES_PER_SECOND) {
    return { state: spent, verdict: { type: 'kill', reason: 'flood' } };
  }
  return input.message === null ? { state: spent, verdict: null } : received(spent, input.message, now);
}

// The frame's line numbers are for its whole document. The ones outside the code belong to
// the page's own scripts or are invented, and the model can do nothing with those.
function errorOf(error: FrameError, code: readonly string[], codeLine: number): RunError {
  const line = error.line === null ? 0 : error.line - codeLine + 1;
  const source = code[line - 1];
  if (line < 1 || source === undefined) return { message: error.message, line: null, source: null };
  return { message: error.message, line, source: source.trim().slice(0, SOURCE_LINE_CHARS) };
}

export type Ending = {
  readonly code: string;
  readonly codeLine: number;
  readonly timedOut?: boolean;
  readonly blocked?: boolean;
  readonly killed?: KillReason | null;
};

export function runReportOf(state: SupervisorState, ending: Ending): RunReport {
  const lines = ending.code.split('\n');
  const { report } = state;
  return {
    ...emptyReport,
    errors: state.errors.map((error) => errorOf(error, lines, ending.codeLine)),
    logs: state.logs,
    timedOut: ending.timedOut ?? false,
    blocked: ending.blocked ?? false,
    killed: ending.killed ?? null,
    ...(report === null
      ? {}
      : {
          nodes: report.nodes,
          svgs: report.svgs,
          bbox: report.bbox,
          marks: report.marks,
          nanAttributes: report.nan,
          text: report.text,
        }),
  };
}
