import { describe, expect, it } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
  ERRORS_KEPT,
  FIRST_CONTACT_MS,
  LOGS_KEPT,
  MESSAGES_PER_SECOND,
  SILENCE_KILL_MS,
} from '../../src/artifact/limits';
import type { FrameMessage } from '../../src/artifact/protocol';
import { runReportOf, startSupervisor, stepSupervisor } from '../../src/artifact/supervisor';
import type { SupervisorState } from '../../src/artifact/supervisor';

const say = (state: SupervisorState, message: FrameMessage | null, now: number) =>
  stepSupervisor(state, { type: 'message', message }, now);
const tick = (state: SupervisorState, now: number) => stepSupervisor(state, { type: 'tick' }, now);

const report: FrameMessage = { kind: 'report', nodes: 3, svgs: 1, bbox: { w: 9, h: 9 }, marks: 3, nan: 0, text: 't' };
const start = startSupervisor(0);
const heard = say(start, { kind: 'alive' }, 10).state;

describe('stepSupervisor', () => {
  it('waits for first contact', () => {
    expect(tick(start, FIRST_CONTACT_MS).verdict).toBeNull();
    expect(tick(start, FIRST_CONTACT_MS + 1).verdict).toEqual({ type: 'kill', reason: 'silent' });
  });

  it('kills a frame that went quiet', () => {
    expect(tick(heard, 10 + SILENCE_KILL_MS).verdict).toBeNull();
    expect(tick(heard, 11 + SILENCE_KILL_MS).verdict).toEqual({ type: 'kill', reason: 'silent' });
  });

  it('counts any message as a sign of life', () => {
    const later = say(heard, { kind: 'log', text: 'x' }, 1000).state;
    expect(tick(later, 1000 + SILENCE_KILL_MS).verdict).toBeNull();
  });

  it('does not count a message that failed validation as a sign of life', () => {
    const later = say(heard, null, 1000).state;
    expect(tick(later, 11 + SILENCE_KILL_MS).verdict).toEqual({ type: 'kill', reason: 'silent' });
  });

  it('kills on a second ready', () => {
    const once = say(heard, { kind: 'ready' }, 20);
    expect(once.verdict).toBeNull();
    expect(say(once.state, { kind: 'ready' }, 30).verdict).toEqual({ type: 'kill', reason: 'reload' });
  });

  it('times the check out from the start, however lively the frame is', () => {
    const lively = say(start, { kind: 'alive' }, CHECK_TIMEOUT_MS).state;
    expect(tick(lively, CHECK_TIMEOUT_MS).verdict).toBeNull();
    expect(tick(lively, CHECK_TIMEOUT_MS + 1).verdict).toEqual({ type: 'timeout' });
  });

  it('has finished the check at the report, after ready', () => {
    const ready = say(heard, { kind: 'ready' }, 20).state;
    const done = say(ready, report, 30);
    expect(done.verdict).toEqual({ type: 'checked' });
    const lively = say(done.state, { kind: 'alive' }, CHECK_TIMEOUT_MS * 2).state;
    expect(tick(lively, CHECK_TIMEOUT_MS * 2 + 1).verdict).toBeNull();
  });

  it('ignores a report sent before ready, and a second report', () => {
    expect(say(heard, report, 20).verdict).toBeNull();
    const ready = say(heard, { kind: 'ready' }, 20).state;
    const done = say(ready, report, 30).state;
    expect(say(done, { ...report, nodes: 9 }, 40).verdict).toBeNull();
    expect(say(done, { ...report, nodes: 9 }, 40).state.report?.nodes).toBe(3);
  });

  it('kills past the budget, counting messages that failed validation', () => {
    let state = start;
    for (let sent = 0; sent < MESSAGES_PER_SECOND; sent += 1) {
      const step = say(state, sent % 2 === 0 ? null : { kind: 'alive' }, 100);
      expect(step.verdict).toBeNull();
      state = step.state;
    }
    expect(say(state, null, 100).verdict).toEqual({ type: 'kill', reason: 'flood' });
  });

  it('gives each second its own budget', () => {
    let state = start;
    for (let sent = 0; sent < MESSAGES_PER_SECOND; sent += 1) state = say(state, null, 100).state;
    expect(say(state, null, 1000).verdict).toBeNull();
  });

  it('keeps only so many errors and logs', () => {
    let state = start;
    for (let sent = 0; sent < 50; sent += 1) {
      state = say(state, { kind: 'error', message: `e${sent}`, line: null }, 1).state;
      state = say(state, { kind: 'log', text: `l${sent}` }, 1).state;
    }
    expect(state.errors).toHaveLength(ERRORS_KEPT);
    expect(state.logs).toHaveLength(LOGS_KEPT);
    expect(state.errors[0]?.message).toBe('e0');
  });
});

describe('runReportOf', () => {
  const code = 'first();\n  D3.svg();\nlast();';
  const failed = say(heard, { kind: 'error', message: 'D3 is not defined', line: 48 }, 20).state;

  it('turns a document line into a line of the code, with its source', () => {
    expect(runReportOf(failed, { code, codeLine: 47 }).errors).toEqual([
      { message: 'D3 is not defined', line: 2, source: 'D3.svg();' },
    ]);
  });

  it('gives no line for one outside the code', () => {
    for (const codeLine of [100, 40]) {
      expect(runReportOf(failed, { code, codeLine }).errors[0]).toMatchObject({ line: null, source: null });
    }
  });

  it('gives no line when the frame gave none', () => {
    const state = say(heard, { kind: 'error', message: 'm', line: null }, 20).state;
    expect(runReportOf(state, { code, codeLine: 1 }).errors[0]).toMatchObject({ line: null });
  });

  it('carries the frame report and the ending', () => {
    const ready = say(heard, { kind: 'ready' }, 20).state;
    const done = say(ready, report, 30).state;
    expect(runReportOf(done, { code, codeLine: 1, killed: 'flood' })).toMatchObject({
      nodes: 3,
      svgs: 1,
      bbox: { w: 9, h: 9 },
      nanAttributes: 0,
      text: 't',
      killed: 'flood',
      timedOut: false,
      blocked: false,
    });
  });
});
