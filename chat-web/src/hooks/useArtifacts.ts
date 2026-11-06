// When model code may run, which is only ever after the reader said so. A turn asks once,
// at its first call, and its repairs ride on that one Run; the next turn asks again, and
// nothing opened from the saved list runs at all until it is tapped. Stop is how the reader
// says no, so a run that is waiting for the grant ends when its signal does.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import { createArtifactHost } from '../artifact/host';
import type { ArtifactHost, HostStatus } from '../artifact/host';
import type { ArtifactRunner } from '../artifact/protocol';
import { plotCharacters } from '../chat/artifact';
import type { Artifact } from '../chat/artifact';
import { describeReport } from '../tools/plot';

export type PendingArtifact = {
  readonly callId: string;
  readonly code: string;
  readonly chars: number;
  readonly withheld: number;
};

export type HostFactory = (slot: HTMLElement) => ArtifactHost;

export type ArtifactsConfig = {
  // A check came back clean, so this call's chart should be shown.
  readonly onReveal: (callId: string) => void;
  readonly createHost?: HostFactory;
};

export type Artifacts = {
  readonly slot: RefObject<HTMLDivElement | null>;
  readonly runner: ArtifactRunner;
  readonly pending: PendingArtifact | null;
  readonly checking: boolean;
  readonly status: HostStatus;
  readonly grant: () => void;
  readonly beginTurn: () => void;
  readonly reset: () => void;
  readonly show: (artifact: Artifact) => void;
  readonly remove: () => void;
};

const idle: HostStatus = { live: false, checking: false, ended: null };

const platformHost: HostFactory = (slot) =>
  createArtifactHost({
    slot,
    doc: document,
    now: () => performance.now(),
    timers: {
      setInterval: (run, ms) => window.setInterval(run, ms),
      clearInterval: (timer) => window.clearInterval(timer),
    },
  });

export function useArtifacts(config: ArtifactsConfig): Artifacts {
  const slot = useRef<HTMLDivElement | null>(null);
  const host = useRef<ArtifactHost | null>(null);
  const granted = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const reveal = useRef(config.onReveal);
  reveal.current = config.onReveal;
  const make = useRef(config.createHost ?? platformHost);
  const [pending, setPending] = useState<PendingArtifact | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<HostStatus>(idle);

  // Made on first use, because the slot it fills belongs to a panel that mounts after this.
  const hostOf = useCallback((): ArtifactHost => {
    if (host.current !== null) return host.current;
    if (slot.current === null) throw new Error('there is nowhere on this page to draw');
    const made = make.current(slot.current);
    made.subscribe(() => setStatus(made.status()));
    host.current = made;
    return made;
  }, []);

  useEffect(
    () => () => {
      host.current?.dispose();
      host.current = null;
    },
    [],
  );

  const runner = useCallback<ArtifactRunner>(
    async (input) => {
      if (!granted.current) {
        setPending({
          callId: input.callId,
          code: input.code,
          chars: plotCharacters(input.messages),
          withheld: input.withheld,
        });
        try {
          await new Promise<void>((resolve, reject) => {
            release.current = resolve;
            input.signal.addEventListener('abort', () => reject(new Error('stopped by the reader')), { once: true });
          });
        } finally {
          release.current = null;
          setPending(null);
        }
      }
      const running = hostOf();
      // Committed first, because the frame is sized from the panel it is about to fill.
      flushSync(() => setChecking(true));
      try {
        const report = await running.run({ code: input.code, messages: input.messages, signal: input.signal });
        if (input.signal.aborted) return report;
        if (describeReport(report, input.drawing).ok) reveal.current(input.callId);
        else running.remove();
        return report;
      } finally {
        setChecking(false);
      }
    },
    [hostOf],
  );

  const grant = useCallback(() => {
    granted.current = true;
    release.current?.();
  }, []);

  const beginTurn = useCallback(() => {
    granted.current = false;
  }, []);

  const remove = useCallback(() => {
    host.current?.remove();
  }, []);

  const reset = useCallback(() => {
    granted.current = false;
    setPending(null);
    setChecking(false);
    host.current?.remove();
  }, []);

  // The reader tapped Run on a chart the transcript already holds. Nobody waits on the
  // answer, so a page that lost its policy simply shows no chart.
  const show = useCallback(
    (artifact: Artifact) => {
      const signal = new AbortController().signal;
      void hostOf()
        .run({ code: artifact.code, messages: artifact.messages, signal })
        .catch(() => undefined);
    },
    [hostOf],
  );

  return { slot, runner, pending, checking, status, grant, beginTurn, reset, show, remove };
}
