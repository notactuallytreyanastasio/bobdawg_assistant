// Turning a page into a link. Sharing is the one thing here that puts the reader's data
// somewhere others can get at it, so it takes a second press after saying so, and only a page
// that ran can be shared. The panel gives this a key per artifact, so a link never outlives
// the page it belongs to.

import { useState } from 'react';
import type { ShareResult } from '../api/sharePage';
import { plotCharacters, shareConsentText } from '../chat/artifact';
import type { Artifact } from '../chat/artifact';
import { CopyButton } from './CopyButton';

export type ShareBarProps = {
  readonly artifact: Artifact;
  readonly onShare: () => Promise<ShareResult>;
};

type Step = 'idle' | 'asking' | 'sending' | ShareResult;

const FAILURES = {
  off: 'This server keeps no shared pages. Start it with --share-dir.',
  full: 'The server is holding as many shared pages as it will keep.',
  large: 'This page is too large to share.',
  failed: 'The page could not be shared.',
} as const;

export function ShareBar({ artifact, onShare }: ShareBarProps) {
  const [step, setStep] = useState<Step>('idle');

  async function share(): Promise<void> {
    setStep('sending');
    setStep(await onShare());
  }

  if (artifact.status !== 'ok') return null;
  if (step === 'idle') {
    return (
      <div className="share">
        <button className="tool" type="button" onClick={() => setStep('asking')}>
          Share as a page
        </button>
      </div>
    );
  }
  if (step === 'asking' || step === 'sending') {
    return (
      <div className="share">
        <p>{shareConsentText(plotCharacters(artifact.messages))}</p>
        <button className="tool" type="button" disabled={step === 'sending'} onClick={() => void share()}>
          {step === 'sending' ? 'Sharing…' : 'Put it on the server'}
        </button>
        <button className="tool" type="button" disabled={step === 'sending'} onClick={() => setStep('idle')}>
          Cancel
        </button>
      </div>
    );
  }
  if (step.kind === 'shared') {
    return (
      <div className="share">
        <a href={step.url} target="_blank" rel="noopener noreferrer">
          {step.url}
        </a>
        <CopyButton text={step.url} label="Copy link" />
      </div>
    );
  }
  return (
    <div className="share">
      <p role="status">{FAILURES[step.kind]}</p>
    </div>
  );
}
