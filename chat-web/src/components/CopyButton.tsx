// A button that copies some text and says so for a moment.

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import { CheckIcon, CopyIcon } from './icons';

export type CopyButtonProps = {
  readonly text: string;
  readonly label?: string;
};

const CONFIRM_MS = 1500;

export function CopyButton({ text, label = 'Copy' }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    const copied = await copyText(text);
    setState(copied ? 'copied' : 'failed');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), CONFIRM_MS);
  }

  const shown = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  return (
    <button className="tool" type="button" onClick={() => void copy()}>
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      <span>{shown}</span>
    </button>
  );
}
