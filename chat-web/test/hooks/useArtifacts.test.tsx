import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactHost, HostRun, HostStatus } from '../../src/artifact/host';
import { emptyReport } from '../../src/artifact/protocol';
import type { RunReport } from '../../src/artifact/protocol';
import type { Artifact } from '../../src/chat/artifact';
import { useArtifacts } from '../../src/hooks/useArtifacts';

const drawn: RunReport = { ...emptyReport, nodes: 5, svgs: 1, marks: 5, bbox: { w: 9, h: 9 } };
const failed: RunReport = { ...emptyReport, errors: [{ message: 'boom', line: null, source: null }] };

function fakeHost(answers: readonly RunReport[]) {
  const runs: HostRun[] = [];
  const removed = vi.fn();
  const listeners = new Set<() => void>();
  let status: HostStatus = { live: false, checking: false, ended: null };
  const host: ArtifactHost = {
    run: async (input) => {
      runs.push(input);
      return answers[runs.length - 1] ?? drawn;
    },
    remove: removed,
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  };
  const set = (next: HostStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  return { host, runs, removed, set };
}

function mount(answers: readonly RunReport[] = []) {
  const fake = fakeHost(answers);
  const onReveal = vi.fn();
  const view = renderHook(() => useArtifacts({ onReveal, createHost: () => fake.host }));
  view.result.current.slot.current = document.createElement('div');
  return { ...fake, onReveal, view };
}

const input = (signal = new AbortController().signal, callId = 'c1') => ({
  callId,
  code: 'draw()',
  messages: ['one', 'two'],
  withheld: 1,
  signal,
});

const artifact: Artifact = {
  key: 'a1/c1',
  callId: 'c1',
  title: 'Chart',
  code: 'draw()',
  messages: ['one'],
  withheld: 0,
  status: 'ok',
  detail: '',
};

describe('useArtifacts', () => {
  it('waits for Run, and says what would run', async () => {
    const { view, runs } = mount();
    let finished = false;
    void view.result.current.runner(input()).then(() => (finished = true));
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    expect(view.result.current.pending).toEqual({ callId: 'c1', code: 'draw()', chars: 8, withheld: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(runs).toHaveLength(0);
    expect(finished).toBe(false);
  });

  it('runs on the grant, and reveals a clean check', async () => {
    const { view, runs, onReveal } = mount();
    const run = view.result.current.runner(input());
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    await act(async () => {
      view.result.current.grant();
      await run;
    });
    expect(runs).toHaveLength(1);
    expect(view.result.current.pending).toBeNull();
    expect(onReveal).toHaveBeenCalledWith('c1');
    expect(view.result.current.checking).toBe(false);
  });

  it('needs no second click for a repair in the same turn', async () => {
    const { view, runs, removed, onReveal } = mount([failed, drawn]);
    const first = view.result.current.runner(input());
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    await act(async () => {
      view.result.current.grant();
      await first;
    });
    expect(removed).toHaveBeenCalledOnce();
    expect(onReveal).not.toHaveBeenCalled();
    await act(async () => {
      await view.result.current.runner(input(undefined, 'c2'));
    });
    expect(runs).toHaveLength(2);
    expect(onReveal).toHaveBeenCalledWith('c2');
  });

  it('asks again on the next turn', async () => {
    const { view, runs } = mount();
    const first = view.result.current.runner(input());
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    await act(async () => {
      view.result.current.grant();
      await first;
    });
    act(() => view.result.current.beginTurn());
    void view.result.current.runner(input(undefined, 'c2'));
    await waitFor(() => expect(view.result.current.pending?.callId).toBe('c2'));
    expect(runs).toHaveLength(1);
  });

  it('ends a wait for Run when the turn is stopped, and nothing runs', async () => {
    const { view, runs } = mount();
    const controller = new AbortController();
    const run = view.result.current.runner(input(controller.signal));
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    await act(async () => {
      controller.abort();
      await expect(run).rejects.toThrow('stopped by the reader');
    });
    expect(view.result.current.pending).toBeNull();
    expect(runs).toHaveLength(0);
  });

  it('runs nothing by itself', () => {
    const { runs } = mount();
    expect(runs).toHaveLength(0);
  });

  it('runs a saved chart only when shown, and that needs no turn', async () => {
    const { view, runs } = mount();
    await act(async () => view.result.current.show(artifact));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ code: 'draw()', messages: ['one'] });
  });

  it('forgets the grant and takes the frame down on reset', async () => {
    const { view, removed, runs } = mount();
    const first = view.result.current.runner(input());
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    await act(async () => {
      view.result.current.grant();
      await first;
    });
    act(() => view.result.current.reset());
    expect(removed).toHaveBeenCalled();
    void view.result.current.runner(input(undefined, 'c2'));
    await waitFor(() => expect(view.result.current.pending?.callId).toBe('c2'));
    expect(runs).toHaveLength(1);
  });

  it('follows the host, so a tab that hid shows the placeholder', async () => {
    const { view, set } = mount();
    await act(async () => view.result.current.show(artifact));
    act(() => set({ live: true, checking: false, ended: null }));
    expect(view.result.current.status.live).toBe(true);
    act(() => set({ live: false, checking: false, ended: 'hidden' }));
    expect(view.result.current.status).toEqual({ live: false, checking: false, ended: 'hidden' });
  });

  it('does not reveal a run that was stopped', async () => {
    const { view, onReveal } = mount();
    const controller = new AbortController();
    const first = view.result.current.runner(input(controller.signal));
    await waitFor(() => expect(view.result.current.pending).not.toBeNull());
    await act(async () => {
      view.result.current.grant();
      controller.abort();
      await first.catch(() => undefined);
    });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('fails plainly with nowhere to draw', async () => {
    const { view } = mount();
    view.result.current.slot.current = null;
    view.result.current.grant();
    await expect(view.result.current.runner(input())).rejects.toThrow('nowhere');
  });
});
