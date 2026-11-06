// The chart beside the chat. This element is always mounted, at one place in the tree, and
// the slot inside it holds no React children: the frame in there is the host's, and a node
// that moves is a frame that reloads. Everything that changes here changes by class.

import type { RefObject } from 'react';
import type { ShareResult } from '../api/sharePage';
import type { FrameEnd } from '../artifact/host';
import { consentText, plotCharacters } from '../chat/artifact';
import type { Artifact } from '../chat/artifact';
import { BLOCKED_BANNER } from '../tools/plot';
import { CopyButton } from './CopyButton';
import { ShareBar } from './ShareBar';
import { CloseIcon, CodeIcon, ChartIcon, ExpandIcon, LeftIcon, PlayIcon, RightIcon, StopIcon } from './icons';

export type PanelTab = 'preview' | 'code';

export type ArtifactPanelProps = {
  readonly slot: RefObject<HTMLDivElement | null>;
  readonly artifact: Artifact | null;
  readonly position: { readonly index: number; readonly count: number };
  readonly tab: PanelTab;
  readonly checking: boolean;
  readonly live: boolean;
  readonly ended: FrameEnd | null;
  readonly full: boolean;
  // Nothing can be run by hand while a turn is using the one frame there is.
  readonly busy: boolean;
  readonly onTab: (tab: PanelTab) => void;
  readonly onRun: () => void;
  readonly onStop: () => void;
  readonly onClose: () => void;
  readonly onFull: (full: boolean) => void;
  readonly onStep: (step: -1 | 1) => void;
  readonly onShare: () => Promise<ShareResult>;
};

// Only a label. The frame's claims go into it, so it never says more than this.
const STATUS = {
  ok: 'Ran without errors',
  failed: 'Did not work',
  unchecked: 'Not run',
} as const;

const ENDED = {
  blocked: BLOCKED_BANNER,
  silent: 'This chart stopped answering and was removed.',
  reload: 'This chart reloaded itself and was removed.',
  flood: 'This chart sent too many messages and was removed.',
  timeout: 'This chart did not finish in time and was removed.',
  hidden: 'This chart was stopped while the tab was hidden.',
} as const;

function classOf(open: boolean, checking: boolean, full: boolean): string {
  if (checking) return 'panel checking';
  if (!open) return 'panel';
  return full ? 'panel open full' : 'panel open';
}

export function ArtifactPanel(props: ArtifactPanelProps) {
  const { slot, artifact, position, tab, checking, live, ended, full, busy } = props;
  const { onTab, onRun, onStop, onClose, onFull, onStep, onShare } = props;
  const showing = tab === 'preview';
  return (
    <aside className={classOf(artifact !== null, checking, full)} aria-label="Chart">
      <header className="panel-head">
        <div className="panel-title">
          <b>{artifact?.title ?? 'Chart'}</b>
          {artifact === null ? null : <span className="state">{STATUS[artifact.status]}</span>}
        </div>
        <div className="panel-tools">
          <button className={showing ? 'tab on' : 'tab'} type="button" aria-pressed={showing} onClick={() => onTab('preview')}>
            <ChartIcon />
            Preview
          </button>
          <button className={showing ? 'tab' : 'tab on'} type="button" aria-pressed={!showing} onClick={() => onTab('code')}>
            <CodeIcon />
            Code
          </button>
          {artifact === null ? null : <CopyButton text={artifact.code} label="Copy code" />}
          <span className="spacer" />
          <button className="square" type="button" aria-label="Previous attempt" disabled={position.index <= 0} onClick={() => onStep(-1)}>
            <LeftIcon />
          </button>
          <button
            className="square"
            type="button"
            aria-label="Next attempt"
            disabled={position.index >= position.count - 1}
            onClick={() => onStep(1)}
          >
            <RightIcon />
          </button>
          <button className="square" type="button" aria-label="Full view" aria-pressed={full} onClick={() => onFull(!full)}>
            <ExpandIcon />
          </button>
          <button className="square" type="button" aria-label="Stop the chart" disabled={!live} onClick={onStop}>
            <StopIcon />
          </button>
          <button className="square" type="button" aria-label="Close the chart" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </header>
      <p className="panel-notice">
        Written by the model and running in a sandbox. Do not type anything private into it. Running without errors does
        not make the numbers right, so check them against your data.
      </p>
      {artifact === null ? null : <ShareBar key={artifact.key} artifact={artifact} onShare={onShare} />}
      {ended === null ? null : (
        <p className={ended === 'blocked' ? 'panel-ended bad' : 'panel-ended'} role="status">
          {ENDED[ended]}
        </p>
      )}
      <div className={showing ? 'panel-body' : 'panel-body behind'}>
        <div ref={slot} className="slot" />
        {live || checking || artifact === null ? null : (
          <div className="placeholder">
            <p>{consentText(plotCharacters(artifact.messages), artifact.withheld)}</p>
            <button className="run" type="button" disabled={busy} onClick={onRun}>
              <PlayIcon />
              Run
            </button>
          </div>
        )}
      </div>
      {showing ? null : <pre className="panel-code">{artifact?.code ?? ''}</pre>}
    </aside>
  );
}
