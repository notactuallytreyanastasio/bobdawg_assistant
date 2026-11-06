import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARENT_POLICY, createArtifactHost } from '../../src/artifact/host';
import type { ArtifactHost, HostTimers } from '../../src/artifact/host';
import {
  CHECK_TIMEOUT_MS,
  HEIGHT_MIN,
  MESSAGES_PER_SECOND,
  MIN_DRAW_HEIGHT,
  MIN_DRAW_WIDTH,
  SILENCE_KILL_MS,
} from '../../src/artifact/limits';

type Rig = {
  readonly host: ArtifactHost;
  readonly slot: HTMLElement;
  readonly advance: (ms: number) => void;
};

function policy(content = PARENT_POLICY): void {
  const tag = document.createElement('meta');
  tag.setAttribute('http-equiv', 'Content-Security-Policy');
  tag.setAttribute('content', content);
  document.head.appendChild(tag);
}

function rig(): Rig {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  let clock = 1000;
  const ticks = new Map<number, () => void>();
  const timers: HostTimers = {
    setInterval: (run) => {
      ticks.set(ticks.size + 1, run);
      return ticks.size;
    },
    clearInterval: (timer) => {
      ticks.delete(timer);
    },
  };
  const host = createArtifactHost({ slot, doc: document, now: () => clock, timers, d3: async () => 'var d3={};' });
  return {
    host,
    slot,
    advance: (ms) => {
      clock += ms;
      for (const run of [...ticks.values()]) run();
    },
  };
}

const input = (signal = new AbortController().signal) => ({ code: 'draw();', messages: ['data'], signal });

function frameIn(slot: HTMLElement): HTMLIFrameElement {
  const frame = slot.querySelector('iframe');
  if (frame === null) throw new Error('no frame');
  return frame;
}

function say(frame: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
}

function violation(directive: string, blockedURI: string): void {
  const event = new Event('securitypolicyviolation');
  Object.assign(event, { effectiveDirective: directive, blockedURI });
  document.dispatchEvent(event);
}

const report = { kind: 'report', nodes: 4, svgs: 1, bbox: { w: 9, h: 9 }, marks: 4, nan: 0, text: 'hello' };

async function started(rigged: Rig, signal?: AbortSignal): Promise<{ run: Promise<unknown>; frame: HTMLIFrameElement }> {
  const run = rigged.host.run(input(signal));
  await vi.waitFor(() => expect(rigged.slot.querySelector('iframe')).not.toBeNull());
  return { run, frame: frameIn(rigged.slot) };
}

// Long enough for a run to get past waiting for D3 and reach wherever it will wait next.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function checked(frame: HTMLIFrameElement): void {
  say(frame, { kind: 'alive' });
  say(frame, { kind: 'ready' });
  say(frame, report);
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function sizeOf(frame: HTMLIFrameElement): { readonly width: number; readonly height: number } {
  const found = /"width":(\d+),"height":(\d+)/.exec(frame.srcdoc);
  if (found === null) throw new Error('no size in the frame');
  return { width: Number(found[1]), height: Number(found[2]) };
}

describe('the size a chart is told to draw at', () => {
  async function sizeAt(clientWidth: number): Promise<{ readonly width: number; readonly height: number }> {
    policy();
    const rigged = rig();
    Object.defineProperty(rigged.slot, 'clientWidth', { value: clientWidth });
    const { frame } = await started(rigged);
    return sizeOf(frame);
  }

  // Margins written for a chart about 600 wide turned its scale upside down at 331 by 215.
  it('never goes below the floor, however narrow the panel', async () => {
    await expect(sizeAt(331)).resolves.toEqual({ width: MIN_DRAW_WIDTH, height: MIN_DRAW_HEIGHT });
  });

  it('follows a panel wider than the floor', async () => {
    await expect(sizeAt(1000)).resolves.toEqual({ width: 1000, height: 650 });
  });

  it('leaves room for hand-written margins', () => {
    expect(MIN_DRAW_WIDTH).toBeGreaterThanOrEqual(640);
    expect(MIN_DRAW_HEIGHT).toBeGreaterThanOrEqual(416);
  });
});

describe('createArtifactHost', () => {
  it('refuses to run without the parent policy', async () => {
    const { host, slot } = rig();
    await expect(host.run(input())).rejects.toThrow('frame policy');
    expect(slot.querySelector('iframe')).toBeNull();
  });

  it('refuses to run with a different policy', async () => {
    policy("frame-src 'self'");
    await expect(rig().host.run(input())).rejects.toThrow('frame policy');
  });

  it('sets sandbox, exactly, before the frame enters the page', async () => {
    policy();
    const rigged = rig();
    const seen: (string | null)[] = [];
    const original = rigged.slot.appendChild.bind(rigged.slot);
    vi.spyOn(rigged.slot, 'appendChild').mockImplementation((node) => {
      seen.push((node as HTMLElement).getAttribute('sandbox'));
      return original(node);
    });
    const { frame } = await started(rigged);
    expect(seen).toEqual(['allow-scripts']);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toContain('draw();');
    expect(frame.getAttribute('src')).toBeNull();
  });

  it('answers with what the frame reported, and leaves it running', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    say(frame, { kind: 'log', text: 'hi' });
    checked(frame);
    await expect(run).resolves.toMatchObject({ nodes: 4, svgs: 1, text: 'hello', logs: ['hi'], killed: null });
    expect(rigged.host.status()).toEqual({ live: true, checking: false, ended: null });
    expect(rigged.slot.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('says it is checking until the report', async () => {
    policy();
    const rigged = rig();
    const { frame } = await started(rigged);
    expect(rigged.host.status().checking).toBe(true);
    checked(frame);
    expect(rigged.host.status().checking).toBe(false);
  });

  it('ignores messages from any other window', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    const stranger = document.createElement('iframe');
    document.body.appendChild(stranger);
    window.dispatchEvent(new MessageEvent('message', { data: report, source: stranger.contentWindow }));
    window.dispatchEvent(new MessageEvent('message', { data: { kind: 'ready' } }));
    expect(rigged.host.status().checking).toBe(true);
    checked(frame);
    await run;
  });

  it('removes the old frame before making a new one, and keeps one', async () => {
    policy();
    const rigged = rig();
    const first = await started(rigged);
    const order: string[] = [];
    const remove = first.frame.remove.bind(first.frame);
    vi.spyOn(first.frame, 'remove').mockImplementation(() => {
      order.push('remove');
      remove();
    });
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((name: string) => {
      order.push(`create ${name}`);
      return create(name);
    });
    void rigged.host.run(input());
    await vi.waitFor(() => expect(order).toContain('create iframe'));
    expect(order).toEqual(['remove', 'create iframe']);
    expect(rigged.slot.querySelectorAll('iframe')).toHaveLength(1);
    await expect(first.run).resolves.toBeDefined();
  });

  it('kills on silence, and the frame is gone', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    say(frame, { kind: 'alive' });
    rigged.advance(SILENCE_KILL_MS + 1);
    await expect(run).resolves.toMatchObject({ killed: 'silent' });
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status()).toEqual({ live: false, checking: false, ended: 'silent' });
  });

  it('kills a reload', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    say(frame, { kind: 'ready' });
    say(frame, { kind: 'ready' });
    await expect(run).resolves.toMatchObject({ killed: 'reload' });
    expect(rigged.slot.querySelector('iframe')).toBeNull();
  });

  it('kills a flood, valid or not', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    for (let sent = 0; sent <= MESSAGES_PER_SECOND; sent += 1) say(frame, 'junk');
    await expect(run).resolves.toMatchObject({ killed: 'flood' });
  });

  it('times the check out', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    for (let at = 0; at <= CHECK_TIMEOUT_MS; at += 1000) {
      say(frame, { kind: 'alive' });
      rigged.advance(1000);
    }
    await expect(run).resolves.toMatchObject({ timedOut: true });
    expect(rigged.slot.querySelector('iframe')).toBeNull();
  });

  it('keeps watching after the check', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    checked(frame);
    await run;
    rigged.advance(SILENCE_KILL_MS + 1);
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status().ended).toBe('silent');
  });

  it('sets the frame height the protocol allows', async () => {
    policy();
    const rigged = rig();
    const { frame } = await started(rigged);
    say(frame, { kind: 'height', height: 1 });
    expect(frame.style.height).toBe(`${HEIGHT_MIN}px`);
  });

  it('removes the frame on a stop', async () => {
    policy();
    const rigged = rig();
    const controller = new AbortController();
    const { run } = await started(rigged, controller.signal);
    controller.abort();
    await expect(run).resolves.toBeDefined();
    expect(rigged.slot.querySelector('iframe')).toBeNull();
  });

  it('keeps a checked chart when the turn is stopped afterwards', async () => {
    policy();
    const rigged = rig();
    const controller = new AbortController();
    const { run, frame } = await started(rigged, controller.signal);
    checked(frame);
    await run;
    controller.abort();
    expect(rigged.slot.querySelector('iframe')).not.toBeNull();
  });

  it('never makes a frame for a stop that came while D3 loaded', async () => {
    policy();
    const rigged = rig();
    const controller = new AbortController();
    const run = rigged.host.run(input(controller.signal));
    controller.abort();
    await run;
    expect(rigged.slot.querySelector('iframe')).toBeNull();
  });

  it('kills on a blocked navigation, and the address goes nowhere', async () => {
    policy();
    const rigged = rig();
    const { run } = await started(rigged);
    violation('frame-src', 'http://evil.test/?d=the-stolen-secret');
    const finished = await run;
    expect(finished).toMatchObject({ blocked: true });
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status().ended).toBe('blocked');
    expect(JSON.stringify([finished, rigged.host.status()])).not.toContain('stolen');
  });

  it('kills on a blocked navigation after the check too', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    checked(frame);
    await run;
    violation('frame-src', 'http://evil.test/');
    expect(rigged.host.status()).toEqual({ live: false, checking: false, ended: 'blocked' });
  });

  it('pays no attention to other violations', async () => {
    policy();
    const rigged = rig();
    await started(rigged);
    violation('img-src', 'http://evil.test/');
    expect(rigged.host.status().live).toBe(true);
  });

  function hide(state: DocumentVisibilityState): void {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('tears down when the tab hides after the check', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    checked(frame);
    await run;
    hide('hidden');
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status().ended).toBe('hidden');
  });

  it('makes no frame while the tab is hidden, and runs when it comes back', async () => {
    policy();
    const rigged = rig();
    hide('hidden');
    const run = rigged.host.run(input());
    await flush();
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status()).toMatchObject({ live: false, checking: true, ended: null });
    hide('visible');
    checked(frameIn(rigged.slot));
    expect(await run).toMatchObject({ svgs: 1, nodes: 4 });
  });

  it('never judges a check the tab hid in the middle of, and starts it again on return', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    hide('hidden');
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status().ended).toBeNull();
    hide('visible');
    const again = frameIn(rigged.slot);
    expect(again).not.toBe(frame);
    checked(again);
    expect(await run).toMatchObject({ svgs: 1, nodes: 4 });
  });

  it('drops a report that lands while the tab is hidden, because nothing there was measured', async () => {
    policy();
    const rigged = rig();
    const { run, frame } = await started(rigged);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    say(frame, { kind: 'ready' });
    say(frame, { ...report, nodes: 0, svgs: 0, marks: 0, bbox: { w: 0, h: 0 } });
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    hide('visible');
    checked(frameIn(rigged.slot));
    expect(await run).toMatchObject({ svgs: 1, nodes: 4 });
  });

  it('gives a held run no time limit, because no clock has started', async () => {
    policy();
    const rigged = rig();
    hide('hidden');
    const run = rigged.host.run(input());
    await flush();
    rigged.advance(CHECK_TIMEOUT_MS * 100);
    hide('visible');
    rigged.advance(1);
    expect(rigged.host.status().live).toBe(true);
    checked(frameIn(rigged.slot));
    expect(await run).toMatchObject({ timedOut: false, killed: null });
  });

  it('lets Stop end a held run, and no frame comes after it', async () => {
    policy();
    const rigged = rig();
    const stop = new AbortController();
    hide('hidden');
    const run = rigged.host.run(input(stop.signal));
    await flush();
    stop.abort();
    expect(await run).toMatchObject({ nodes: 0, killed: null });
    hide('visible');
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    expect(rigged.host.status().checking).toBe(false);
  });

  it('gives up a held run when it is disposed, and stops listening', async () => {
    policy();
    const rigged = rig();
    hide('hidden');
    const run = rigged.host.run(input());
    await flush();
    rigged.host.dispose();
    await run;
    hide('visible');
    expect(rigged.slot.querySelector('iframe')).toBeNull();
  });

  it('tells listeners, and stops when asked', async () => {
    policy();
    const rigged = rig();
    const heard = vi.fn();
    const stop = rigged.host.subscribe(heard);
    await started(rigged);
    expect(heard).toHaveBeenCalled();
    heard.mockClear();
    stop();
    rigged.host.remove();
    expect(heard).not.toHaveBeenCalled();
  });

  it('clears the ending when asked to remove', async () => {
    policy();
    const rigged = rig();
    const { frame } = await started(rigged);
    say(frame, { kind: 'ready' });
    say(frame, { kind: 'ready' });
    rigged.host.remove();
    expect(rigged.host.status().ended).toBeNull();
  });

  it('stops listening once disposed', async () => {
    policy();
    const rigged = rig();
    const { frame } = await started(rigged);
    rigged.host.dispose();
    expect(rigged.slot.querySelector('iframe')).toBeNull();
    say(frame, report);
    expect(rigged.host.status().live).toBe(false);
  });
});
