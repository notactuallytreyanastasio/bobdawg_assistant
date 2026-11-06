// What the transcript holds, as it holds it: the questions, the answers with their thinking
// folded beside them, how each answer ended, and one status line while the model is still
// working. It follows new text until the reader scrolls away.

import { memo, useEffect, useState } from 'react';
import { artifactsOf, consentText } from '../chat/artifact';
import type { Artifact } from '../chat/artifact';
import { canRetry } from '../chat/conversation';
import { stepsOf } from '../chat/steps';
import type { Step } from '../chat/steps';
import type { Conversation } from '../chat/conversation';
import { formatDuration, formatStats } from '../chat/format';
import type { ChatMessage } from '../chat/message';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { CopyButton } from './CopyButton';
import { ChartIcon, CodeIcon, DownIcon, PlayIcon, RetryIcon } from './icons';
import { Markdown } from './Markdown';

export type TranscriptProps = {
  readonly conversation: Conversation;
  readonly onRetry?: () => void;
  // The call waiting for the reader's Run, if there is one.
  readonly pending?: PendingRun | null;
  readonly onRun?: () => void;
  readonly onCode?: (callId: string) => void;
  readonly onOpen?: (key: string) => void;
};

export type PendingRun = {
  readonly callId: string;
  readonly chars: number;
  readonly withheld: number;
};

function statusOf(conversation: Conversation, pending: boolean): string | null {
  if (!conversation.streaming) return null;
  const last = conversation.messages.at(-1);
  if (pending) return 'waiting for you to run it';
  if (last?.role === 'tool' || (last?.role === 'assistant' && last.calls.length > 0)) return 'running the code';
  if (last === undefined || last.role !== 'assistant') return 'waiting';
  if (last.text !== '') return 'answering';
  const previous = conversation.messages.at(-2);
  if (last.reasoning === '' && previous?.result?.ok === false) return 'fixing the code';
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
  // The box scrolls on its own once it is full, so it follows the thinking the way the
  // transcript follows the answer. Opened while the model is thinking, it starts at the newest
  // line; opened afterwards, it starts at the top, where a reader begins.
  const view = useStickToBottom(message.reasoning.length, null);
  return (
    <details
      className="reasoning"
      onToggle={(event) => {
        if (live && event.currentTarget.open) view.jump();
      }}
    >
      <summary>{label}</summary>
      <div className="pre" ref={view.scroller} onScroll={view.onScroll}>
        {message.reasoning}
      </div>
    </details>
  );
}

const ENDINGS = {
  stopped: 'Stopped',
  length: 'Cut off at the length limit',
  gaveup: 'Gave up',
  capped: 'Out of rounds: the last chart ran, but the model never saw the result',
} as const;

const CARD_STATUS = {
  ok: 'Ran without errors',
  failed: 'Did not work',
  unchecked: 'Not run',
} as const;

type CardActions = {
  readonly pending: PendingRun | null;
  readonly onRun: (() => void) | undefined;
  readonly onCode: ((callId: string) => void) | undefined;
  readonly onOpen: ((key: string) => void) | undefined;
};

function Card({ artifact, pending, onRun, onCode, onOpen }: { readonly artifact: Artifact } & CardActions) {
  const waiting = pending?.callId === artifact.callId && artifact.status === 'unchecked';
  return (
    <div className="card">
      <button className="open-chart" type="button" onClick={() => onOpen?.(artifact.key)}>
        <ChartIcon />
        <span className="name">{artifact.title}</span>
        <span className="state">{CARD_STATUS[artifact.status]}</span>
      </button>
      {waiting ? (
        <>
          <p className="consent">{consentText(pending.chars, pending.withheld)}</p>
          <div className="choices">
            <button className="run" type="button" onClick={onRun}>
              <PlayIcon />
              Run
            </button>
            <button className="tool" type="button" onClick={() => onCode?.(artifact.callId)}>
              <CodeIcon />
              <span>Code</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// A failed attempt is worth keeping and not worth the space, like thinking.
function FailedCard({ artifact, ...actions }: { readonly artifact: Artifact } & CardActions) {
  return (
    <details className="reasoning">
      <summary>Attempt that did not work</summary>
      <Card artifact={artifact} {...actions} />
      <p className="pre">{artifact.detail}</p>
    </details>
  );
}

type EntryProps = CardActions & {
  readonly message: ChatMessage;
  readonly live: boolean;
  // A later round of the same turn, which needs no name of its own.
  readonly continued: boolean;
  readonly artifacts: readonly Artifact[];
  readonly steps: readonly Step[];
  readonly onRetry: (() => void) | undefined;
};

// Cards are rebuilt on every delta, and only what they show should cost a render: without
// this every answer on the page would parse its markdown again per word.
function sameEntry(a: EntryProps, b: EntryProps): boolean {
  const sameCard = (card: Artifact, index: number) => {
    const other = b.artifacts[index];
    return card.key === other?.key && card.status === other.status && card.detail === other.detail;
  };
  const sameStep = (step: Step, index: number) => {
    const other = b.steps[index];
    return step.key === other?.key && step.ok === other.ok && step.output === other.output;
  };
  return (
    a.message === b.message &&
    a.steps.length === b.steps.length &&
    a.steps.every(sameStep) &&
    a.live === b.live &&
    a.continued === b.continued &&
    a.onRetry === b.onRetry &&
    a.pending === b.pending &&
    a.onRun === b.onRun &&
    a.onCode === b.onCode &&
    a.onOpen === b.onOpen &&
    a.artifacts.length === b.artifacts.length &&
    a.artifacts.every(sameCard)
  );
}

// One thing the model did in its workspace. Open while it runs, because that is when anyone
// is watching; a finished step folds away like thinking does.
function StepRow({ step }: { readonly step: Step }) {
  const state = step.ok === null ? 'step running' : step.ok ? 'step' : 'step failed';
  return (
    <details className={state}>
      <summary>
        <code>{step.label}</code>
      </summary>
      {step.detail === '' ? null : <pre className="step-text">{step.detail}</pre>}
      {step.output === '' ? null : <pre className="step-text">{step.output}</pre>}
    </details>
  );
}

const Entry = memo(function Entry({ message, live, continued, artifacts, steps, onRetry, ...actions }: EntryProps) {
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
      {continued ? null : <b className="role">Model</b>}
      {message.reasoning === '' ? null : (
        <Thinking message={message} live={live && message.text === ''} />
      )}
      {message.text === '' ? null : <Markdown text={message.text} />}
      {artifacts.map((artifact) =>
        artifact.status === 'failed' ? (
          <FailedCard key={artifact.key} artifact={artifact} {...actions} />
        ) : (
          <Card key={artifact.key} artifact={artifact} {...actions} />
        ),
      )}
      {steps.map((step) => (
        <StepRow key={step.key} step={step} />
      ))}
      {message.ending === null ? null : <p className="ending">{ENDINGS[message.ending]}</p>}
      {live || (message.text === '' && onRetry === undefined && stats === '') ? null : (
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
}, sameEntry);

export function Transcript({ conversation, onRetry, pending = null, onRun, onCode, onOpen }: TranscriptProps) {
  const { messages, streaming } = conversation;
  const last = messages.at(-1);
  const status = statusOf(conversation, pending !== null);
  const retry = canRetry(conversation) ? onRetry : undefined;
  const asked = messages.filter((message) => message.role === 'user').length;
  const view = useStickToBottom(`${messages.length}:${last?.text.length}:${last?.reasoning.length}:${status}`, asked);
  // A turn can end on a tool message, and those are not shown: the answer before it is the
  // one that carries the live marks and the Retry.
  const newestAnswer = messages.findLastIndex((message) => message.role === 'assistant');
  const newestShown = last?.role === 'tool' ? newestAnswer : messages.length - 1;
  const artifacts = artifactsOf(messages);

  return (
    <section className="transcript">
      <div className="scroller" ref={view.scroller} onScroll={view.onScroll}>
        <div className="column" ref={view.content}>
          <ul className="entries">
            {messages.map((message, index) => {
              if (message.role === 'tool') return null;
              const newest = index === newestShown;
              return (
                <Entry
                  key={message.id}
                  message={message}
                  live={newest && streaming}
                  continued={messages[index - 1]?.role === 'tool'}
                  artifacts={artifacts.filter((artifact) => artifact.key.startsWith(`${message.id}/`))}
                  steps={stepsOf(messages, index)}
                  pending={pending}
                  onRun={onRun}
                  onCode={onCode}
                  onOpen={onOpen}
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
