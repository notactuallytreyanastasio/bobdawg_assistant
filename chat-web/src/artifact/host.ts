// The only code that makes a frame. The element is built by hand rather than by React so
// that sandbox is set before it enters the page, and so that nothing can re-render it: a
// frame moved in the tree reloads and runs its code again.
//
// Hostile code is assumed on the other side. It can say anything, so what it says goes
// through the protocol and the supervisor, and only ever becomes text for the model and a
// status label. Kill means remove, and removal always comes before the next frame.

import { artifactDocument } from './document';
import { loadD3 } from './d3Source';
import { MIN_DRAW_HEIGHT, MIN_DRAW_WIDTH } from './limits';
import { parseFrameMessage } from './protocol';
import type { KillReason, RunReport } from './protocol';
import { runReportOf, startSupervisor, stepSupervisor } from './supervisor';
import type { Ending, SupervisorInput, SupervisorState } from './supervisor';

// The parent's policy, which a srcdoc frame inherits. It has to stay this one directive:
// a script-src added here would apply inside every frame and break all of them.
export const PARENT_POLICY = "frame-src 'none'";

const TICK_MS = 100;
const FALLBACK_WIDTH = 720;
const DRAW_RATIO = 0.65;

// Why the frame is gone, when it went by itself. 'hidden' is the tab going away after a check,
// which is tidiness rather than trouble.
export type FrameEnd = KillReason | 'timeout' | 'blocked' | 'hidden';

export type HostStatus = {
  readonly live: boolean;
  readonly checking: boolean;
  readonly ended: FrameEnd | null;
};

export type HostRun = {
  readonly code: string;
  readonly messages: readonly string[];
  readonly signal: AbortSignal;
};

export type ArtifactHost = {
  readonly run: (input: HostRun) => Promise<RunReport>;
  readonly remove: () => void;
  readonly status: () => HostStatus;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
};

export type HostTimers = {
  readonly setInterval: (run: () => void, ms: number) => number;
  readonly clearInterval: (timer: number) => void;
};

export type HostOptions = {
  readonly slot: HTMLElement;
  readonly doc: Document;
  readonly now: () => number;
  readonly timers: HostTimers;
  readonly d3?: () => Promise<string>;
};

// One run, from being asked for to its answer. It can outlive a frame: see place.
type Attempt = {
  readonly input: HostRun;
  readonly source: string;
  readonly settle: (report: RunReport) => void;
};

type Live = {
  readonly frame: HTMLIFrameElement;
  readonly attempt: Attempt;
  readonly code: string;
  readonly codeLine: number;
  readonly timer: number;
  readonly stopWatching: () => void;
  readonly releaseSignal: () => void;
  state: SupervisorState;
  // Present until the check is over and the run has its answer.
  settle: ((report: RunReport) => void) | null;
};

function requireParentPolicy(doc: Document): void {
  const tag = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (tag?.getAttribute('content') !== PARENT_POLICY) {
    throw new Error('this page has lost its frame policy, so no chart may run');
  }
}

function drawSize(slot: HTMLElement): { readonly width: number; readonly height: number } {
  const width = Math.max(MIN_DRAW_WIDTH, Math.round(slot.clientWidth) || FALLBACK_WIDTH);
  return { width, height: Math.max(MIN_DRAW_HEIGHT, Math.round(width * DRAW_RATIO)) };
}

export function createArtifactHost(options: HostOptions): ArtifactHost {
  const { slot, doc, now, timers } = options;
  const view = doc.defaultView;
  const d3 = options.d3 ?? loadD3;
  const listeners = new Set<() => void>();
  let live: Live | null = null;
  // A run waiting for the tab to come back.
  let held: Attempt | null = null;
  let ended: FrameEnd | null = null;
  // Each removal moves this on, so a run still waiting for D3 knows it is no longer wanted.
  let generation = 0;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function detach(current: Live): void {
    current.frame.remove();
    timers.clearInterval(current.timer);
    current.stopWatching();
    current.releaseSignal();
    live = null;
  }

  function finish(current: Live, ending: Omit<Ending, 'code' | 'codeLine'>, end: FrameEnd | null): void {
    detach(current);
    ended = end;
    current.settle?.(runReportOf(current.state, { code: current.code, codeLine: current.codeLine, ...ending }));
    notify();
  }

  function advance(current: Live, input: SupervisorInput): void {
    const { state, verdict } = stepSupervisor(current.state, input, now());
    current.state = state;
    if (verdict === null) return;
    if (verdict.type === 'kill') finish(current, { killed: verdict.reason }, verdict.reason);
    if (verdict.type === 'timeout') finish(current, { timedOut: true }, 'timeout');
    if (verdict.type === 'checked') {
      if (doc.visibilityState === 'hidden') {
        pause(current);
        return;
      }
      // The run this signal belonged to is over. Stopping the words that follow a good chart
      // should not take the chart away.
      current.releaseSignal();
      const settle = current.settle;
      current.settle = null;
      settle?.(runReportOf(state, { code: current.code, codeLine: current.codeLine }));
      notify();
    }
  }

  function onMessage(event: MessageEvent<unknown>): void {
    const current = live;
    // Only the window itself identifies a sender: an opaque origin reads as 'null' for
    // every sandboxed frame there is.
    if (current === null || event.source !== current.frame.contentWindow) return;
    const message = parseFrameMessage(event.data);
    advance(current, { type: 'message', message });
    if (live === current && message?.kind === 'height') current.frame.style.height = `${message.height}px`;
  }

  // A navigation the parent's policy stopped. The address in this event can hold the stolen
  // data, so it is not read at all.
  function onViolation(event: Event): void {
    const { effectiveDirective } = event as SecurityPolicyViolationEvent;
    if (live !== null && effectiveDirective === 'frame-src') finish(live, { blocked: true }, 'blocked');
  }

  // Nothing measured in a hidden tab can be believed: Chrome gives the frame no layout there,
  // so a good chart reads as an empty one, and timers are throttled until the watchdog would
  // call them a hang. So a check is never judged there, and the model is told nothing. It spends
  // no round, and repairs are long enough that switching tabs during one is the normal case.
  function pause(current: Live): void {
    detach(current);
    place(current.attempt);
    notify();
  }

  function onVisibility(): void {
    if (doc.visibilityState === 'hidden') {
      if (live === null) return;
      if (live.settle === null) finish(live, {}, 'hidden');
      else pause(live);
    } else if (held !== null) {
      const attempt = held;
      held = null;
      mount(attempt);
    }
  }

  function watch(): () => void {
    view?.addEventListener('message', onMessage);
    doc.addEventListener('securitypolicyviolation', onViolation);
    return () => {
      view?.removeEventListener('message', onMessage);
      doc.removeEventListener('securitypolicyviolation', onViolation);
    };
  }

  function remove(): void {
    generation += 1;
    if (held !== null) {
      const { input, settle } = held;
      held = null;
      input.signal.removeEventListener('abort', remove);
      settle(runReportOf(startSupervisor(now()), { code: input.code, codeLine: 0 }));
      notify();
    }
    if (live !== null) finish(live, {}, null);
    else if (ended !== null) {
      ended = null;
      notify();
    }
  }

  // The frame's whole life is inside the tab being visible, so its clocks start here. The
  // same attempt can come through more than once, and each time it gets a frame of its own.
  function mount(attempt: Attempt): void {
    const { input, source, settle } = attempt;
    const { html, codeLine } = artifactDocument({
      code: input.code,
      messages: input.messages,
      d3: source,
      ...drawSize(slot),
    });
    const frame = doc.createElement('iframe');
    // Exactly this and nothing more: sharing the page's origin would hand over its chats.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = 'Chart written by the model';
    frame.className = 'artifact-frame';
    frame.srcdoc = html;
    live = {
      frame,
      attempt,
      code: input.code,
      codeLine,
      timer: timers.setInterval(() => {
        if (live !== null) advance(live, { type: 'tick' });
      }, TICK_MS),
      stopWatching: watch(),
      releaseSignal: () => input.signal.removeEventListener('abort', remove),
      state: startSupervisor(now()),
      settle,
    };
    slot.appendChild(frame);
    notify();
  }

  // Stop reaches a run wherever it is, in a frame or waiting for one.
  function place(attempt: Attempt): void {
    attempt.input.signal.addEventListener('abort', remove);
    if (doc.visibilityState === 'hidden') held = attempt;
    else mount(attempt);
  }

  doc.addEventListener('visibilitychange', onVisibility);

  return {
    async run(input) {
      requireParentPolicy(doc);
      remove();
      const mine = generation;
      const source = await d3();
      if (mine !== generation || input.signal.aborted) {
        return runReportOf(startSupervisor(now()), { code: input.code, codeLine: 0 });
      }
      return new Promise((settle) => {
        place({ input, source, settle });
        notify();
      });
    },
    remove,
    status: () => ({ live: live !== null, checking: held !== null || live?.settle != null, ended }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      remove();
      doc.removeEventListener('visibilitychange', onVisibility);
      listeners.clear();
    },
  };
}
