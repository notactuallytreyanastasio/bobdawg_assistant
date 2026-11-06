// What the transcript holds, as it holds it: the questions, the answers with their thinking
// folded beside them, how each answer ended, and one status line while the model is still
// working. It follows new text until the reader scrolls away.

import { memo, useEffect, useState } from 'react';
import { canRetry } from '../chat/conversation';
import type { Conversation } from '../chat/conversation';
import { formatDuration, formatStats } from '../chat/format';
import type { ChatMessage } from '../chat/message';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { CopyButton } from './CopyButton';
import { DownIcon, RetryIcon } from './icons';
import { Markdown } from './Markdown';

export type TranscriptProps = {
  readonly conversation: Conversation;
  readonly onRetry?: () => void;
};

function statusOf(conversation: Conversation): string | null {
  if (!conversation.streaming) return null;
  const last = conversation.messages.at(-1);
  if (last === undefined || last.role !== 'assistant') return 'waiting';
  if (last.text !== '') return 'answering';
  return last.reasoning === '' ? 'waiting for the model' : 'thinking';
}

// A big model reading a long prompt can sit quiet for a while, and a count that moves is
// what tells the reader the page has not died.
function Status({ text }: { text: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  // Once words or thinking are visibly arriving, they say it better than a line can. The
  // text stays for a screen reader.
  const quiet = text === 'answering' || text === 'thinking';
  return (
    <p className={quiet ? 'status hidden' : 'status'} role="status">
      <span className="dots" aria-hidden="true"><i /><i /><i /></span>
      {text}
      {seconds >= 3 && !quiet ? <span className="elapsed"> · {seconds}s</span> : null}
    </p>
  );
}

function Thinking({ message, live }: { message: ChatMessage; live: boolean }) {
  const thought = message.stats?.thoughtMs ?? null;
  const label = live
    ? 'Thinking…'
    : thought === null || thought <= 0
      ? 'Thinking'
      : `Thought for ${formatDuration(thought)}`;
  return (
    <details className="reasoning">
      <summary>{label}</summary>
      <p className="pre">{message.reasoning}</p>
    </details>
  );
}

const ENDINGS = {
  stopped: 'Stopped',
  length: 'Cut off at the length limit',
} as const;

type EntryProps = {
  readonly message: ChatMessage;
  readonly live: boolean;
  readonly onRetry: (() => void) | undefined;
};

const Entry = memo(function Entry({ message, live, onRetry }: EntryProps) {
  if (message.role === 'user') {
    return (
      <li className="entry user">
        <b className="role">You</b>
        <p className="pre">{message.text}</p>
      </li>
    );
  }
  const stats = formatStats(message.stats);
  return (
    <li className={live ? 'entry assistant live' : 'entry assistant'}>
      <b className="role">Model</b>
      {message.reasoning === '' ? null : (
        <Thinking message={message} live={live && message.text === ''} />
      )}
      {message.text === '' ? null : <Markdown text={message.text} />}
      {message.ending === null ? null : <p className="ending">{ENDINGS[message.ending]}</p>}
      {live ? null : (
        <div className="tools">
          {message.text === '' ? null : <CopyButton text={message.text} />}
          {onRetry === undefined ? null : (
            <button className="tool" type="button" onClick={onRetry}>
              <RetryIcon />
              <span>Retry</span>
            </button>
          )}
          {stats === '' ? null : <span className="stats">{stats}</span>}
        </div>
      )}
    </li>
  );
});

export function Transcript({ conversation, onRetry }: TranscriptProps) {
  const { messages, streaming } = conversation;
  const last = messages.at(-1);
  const status = statusOf(conversation);
  const retry = canRetry(conversation) ? onRetry : undefined;
  const view = useStickToBottom(`${last?.text.length}:${last?.reasoning.length}:${status}`, messages.length);

  return (
    <section className="transcript">
      <div className="scroller" ref={view.scroller} onScroll={view.onScroll}>
        <div className="column" ref={view.content}>
          <ul className="entries">
            {messages.map((message, index) => {
              const newest = index === messages.length - 1;
              return (
                <Entry
                  key={message.id}
                  message={message}
                  live={newest && streaming}
                  onRetry={newest ? retry : undefined}
                />
              );
            })}
          </ul>
          {status === null ? null : <Status text={status} />}
          {last?.role === 'user' && retry !== undefined ? (
            <div className="tools">
              <button className="tool" type="button" onClick={retry}>
                <RetryIcon />
                <span>Retry</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {view.pinned ? null : (
        <button className="jump" type="button" aria-label="Jump to latest" onClick={view.jump}>
          <DownIcon />
        </button>
      )}
    </section>
  );
}
