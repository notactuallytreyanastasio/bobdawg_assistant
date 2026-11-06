// The question box: what is typed stays here until it goes out. Enter sends and shift
// plus enter writes a line break. While an answer is arriving the button is about
// stopping rather than sending, and while the server is unknown nothing goes out at all.

import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { canSend } from '../chat/conversation';
import type { Conversation } from '../chat/conversation';

export type ComposerProps = {
  readonly conversation: Conversation;
  readonly ready: boolean;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
};

export function Composer({ conversation, ready, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const sendable = ready && canSend(conversation, text);

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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="question"
        rows={3}
        value={text}
        placeholder="Ask ds4"
        disabled={!ready}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="actions">
        {conversation.streaming ? (
          <button className="stop" type="button" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="send" type="submit" disabled={!sendable}>
            Send
          </button>
        )}
        {ready ? null : <span className="hint">waiting for the model name</span>}
      </div>
    </form>
  );
}
