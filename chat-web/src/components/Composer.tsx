// The question box: what is typed stays here until it goes out. Enter sends and shift
// plus enter writes a line break. While an answer is arriving the button is about
// stopping rather than sending, and while the server is unknown nothing goes out at all.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { canSend } from '../chat/conversation';
import type { Conversation } from '../chat/conversation';
import { BulbIcon, ChartIcon, SendIcon, StopIcon } from './icons';

export type ComposerProps = {
  readonly conversation: Conversation;
  readonly ready: boolean;
  readonly notice?: string;
  readonly thinking?: boolean;
  readonly contextPercent?: number | null;
  readonly onThinking?: (thinking: boolean) => void;
  readonly plot?: boolean;
  readonly onPlot?: (plot: boolean) => void;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
};

// The box grows with what is written, up to here, and scrolls after that.
const MAX_HEIGHT = 240;

export function Composer({
  conversation,
  ready,
  notice,
  thinking,
  contextPercent = null,
  onThinking,
  plot,
  onPlot,
  onSend,
  onStop,
}: ComposerProps) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement | null>(null);
  const sendable = ready && canSend(conversation, text);

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // A box that was closed opens ready to type in.
  useEffect(() => {
    if (ready) box.current?.focus();
  }, [ready]);

  function submit(): void {
    if (!sendable) return;
    onSend(text.trim());
    setText('');
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape' && conversation.streaming) {
      onStop();
      return;
    }
    // Enter that confirms an input method's candidate belongs to the input method.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="dock">
      <form className="composer" onSubmit={onSubmit}>
        <textarea
          ref={box}
          className="question"
          rows={1}
          value={text}
          placeholder="Ask DwarfStar"
          aria-label="Your question"
          disabled={!ready}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="actions">
          {thinking === undefined || onThinking === undefined ? null : (
            <button
              className={thinking ? 'toggle on' : 'toggle'}
              type="button"
              aria-pressed={thinking}
              title={thinking ? 'The model reasons before answering' : 'The model answers straight away'}
              onClick={() => onThinking(!thinking)}
            >
              <BulbIcon />
              Thinking
            </button>
          )}
          {plot === undefined || onPlot === undefined ? null : (
            <button
              className={plot ? 'toggle on' : 'toggle'}
              type="button"
              aria-pressed={plot}
              title={
                plot
                  ? 'The model draws what you send as a chart. Its code runs in a sandbox when you press Run'
                  : 'Plain chat: no code runs'
              }
              onClick={() => onPlot(!plot)}
            >
              <ChartIcon />
              Plot
            </button>
          )}
          {notice === undefined ? null : <span className="hint">{notice}</span>}
          <span className="spacer" />
          {contextPercent === null ? null : (
            <span
              className={contextPercent >= 80 ? 'context full' : 'context'}
              title="How much of the model's context this conversation has used"
            >
              {contextPercent}% of context
            </span>
          )}
          {conversation.streaming ? (
            <button className="stop" type="button" aria-label="Stop" onClick={onStop}>
              <StopIcon />
            </button>
          ) : (
            <button className="send" type="submit" aria-label="Send" disabled={!sendable}>
              <SendIcon />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
