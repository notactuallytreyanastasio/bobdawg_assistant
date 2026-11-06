// The two panes beside the chat when the model works in its sandbox: its thinking, and what it
// changed. A line joins a change to the thought behind it, across the gutter the changes keep
// on their left so that it never runs over text. Everything counts as accepted. Highlighting
// code opens a box under it for a question, a comment or a rejection, and that note goes into
// the chat. The bars
// between the panes drag to any width, within what keeps all three readable.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { DEFAULT_WORK_SIZES } from '../chat/storage';
import type { WorkSizes } from '../chat/storage';
import type { Change, Note, NoteKind, Work } from '../chat/work';
import { useStickToBottom } from '../hooks/useStickToBottom';

export type WorkPanesProps = {
  readonly work: Work;
  readonly notes: readonly Note[];
  // The newest thought is still being written.
  readonly live: boolean;
  // Notes waiting for the model to finish its turn.
  readonly queued: number;
  readonly onNote: (note: Omit<Note, 'id'>) => void;
  readonly sizes: WorkSizes;
  readonly onSizes: (sizes: WorkSizes) => void;
};

const KEY_STEP = 24;

// The stylesheet holds the limits, so a narrower window cannot squeeze the changes away.
export function paneWidths(sizes: WorkSizes): CSSProperties | undefined {
  const widths: Record<string, string> = {};
  if (sizes.thinking !== null) widths['--work-thinking'] = `${sizes.thinking}px`;
  if (sizes.chat !== null) widths['--work-chat'] = `${sizes.chat}px`;
  return Object.keys(widths).length === 0 ? undefined : (widths as CSSProperties);
}

// A bar reports the width its pane should be, measured from the side the pane sits on.
function PaneBar({ side, label, measure, onWidth, onReset }: {
  readonly side: 'thinking' | 'chat';
  readonly label: string;
  readonly measure: (x: number) => number;
  readonly onWidth: (width: number) => void;
  readonly onReset: () => void;
}) {
  function drag(event: PointerEvent<HTMLDivElement>): void {
    // Without this the drag would highlight the text it crosses.
    event.preventDefault();
    const move = (moved: globalThis.MouseEvent) => onWidth(measure(moved.clientX));
    const stop = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', stop);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', stop);
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    onWidth(measure(box.left + (event.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP)));
  }

  return (
    <div
      className={`work-bar ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={drag}
      onKeyDown={nudge}
      onDoubleClick={onReset}
    />
  );
}

const LABELS: Readonly<Record<NoteKind, string>> = { comment: 'Note', reject: 'Rejected' };

type Lines = { readonly change: Change; readonly first: number; readonly last: number };

// The lines a highlight touches, inside the change it began in. The range is asked rather than
// its end points, because a triple click ends on the row after the one it chose.
export function linesOfSelection(selection: Selection | null, changes: readonly Change[]): Lines | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const element = (node: Node | null) => (node instanceof Element ? node : (node?.parentElement ?? null));
  const start = element(selection.anchorNode);
  if (start === null || start.closest('.work-note') !== null) return null;
  const card = start.closest<HTMLElement>('[data-change]');
  const change = changes.find((entry) => entry.key === card?.dataset['change']);
  if (card === null || change === undefined) return null;
  const range = selection.getRangeAt(0);
  const rows = [...card.querySelectorAll<HTMLElement>('[data-line]')]
    .filter((row) => range.intersectsNode(row))
    .map((row) => Number(row.dataset['line']));
  const first = rows[0];
  const last = rows.at(-1);
  return first === undefined || last === undefined ? null : { change, first, last };
}

function codeOf(lines: Lines): string {
  return lines.change.lines
    .slice(lines.first, lines.last + 1)
    .map((line) => line.text)
    .join('\n');
}

// The chat sits just past these panes, so its far edge is theirs plus its own width.
function sizeOfChat(panes: HTMLElement | null): number {
  const chat = panes?.nextElementSibling;
  return chat === null || chat === undefined ? 0 : chat.getBoundingClientRect().width;
}

const MARKS = { add: '+', del: '-', same: ' ' } as const;

function NoteBox({ count, text, onText, onCancel, onSend }: {
  readonly count: number;
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly onCancel: () => void;
  readonly onSend: (kind: NoteKind) => void;
}) {
  return (
    <div className="work-note open">
      <b>{count === 1 ? '1 line' : `${count} lines`} selected</b>
      <textarea
        aria-label="Your note"
        placeholder="Ask a question, leave a comment, or add some color"
        autoFocus
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey && text.trim() !== '') {
            event.preventDefault();
            onSend('comment');
          }
        }}
      />
      <div className="work-note-row">
        <button className="tool reject" type="button" onClick={() => onSend('reject')}>
          <span>Reject</span>
        </button>
        <span className="spacer" />
        <button className="tool" type="button" onClick={onCancel}>
          <span>Cancel</span>
        </button>
        <button className="tool go" type="button" disabled={text.trim() === ''} onClick={() => onSend('comment')}>
          <span>Send to chat</span>
        </button>
      </div>
    </div>
  );
}

function ChangeCard({ change, notes, draft, text, selected, onSelect, onText, onCancel, onSend }: {
  readonly change: Change;
  readonly notes: readonly Note[];
  readonly draft: Lines | null;
  readonly text: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onText: (text: string) => void;
  readonly onCancel: () => void;
  readonly onSend: (kind: NoteKind) => void;
}) {
  const state = change.ok === null ? 'Running' : change.ok ? null : 'Did not apply';
  return (
    <article className={selected ? 'work-change selected' : 'work-change'} data-change={change.key} onClick={onSelect}>
      <header className="work-why">
        <h3>
          <code>{change.path}</code>
          {change.whole ? <span className="state">New or rewritten file</span> : null}
          {state === null ? null : <span className="state">{state}</span>}
        </h3>
        {change.why === '' ? null : <p>{change.why}</p>}
        {change.goal === '' ? null : <p className="goal">For: {change.goal}</p>}
      </header>
      <div className="work-diff">
        {change.lines.map((line, index) => {
          const held = notes.filter((note) => index >= note.first && index <= note.last);
          const chosen = draft !== null && index >= draft.first && index <= draft.last;
          const marked = held.some((note) => note.kind === 'reject')
            ? 'struck'
            : chosen
              ? 'chosen'
              : held.length > 0
                ? 'marked'
                : '';
          return (
            <div key={index}>
              <div className={`work-line ${line.kind} ${marked}`} data-line={index}>
                {MARKS[line.kind]} {line.text}
              </div>
              {notes
                .filter((note) => note.last === index)
                .map((note) => (
                  <div className={`work-note ${note.kind}`} key={note.id}>
                    <b>{LABELS[note.kind]}</b>
                    {note.text === '' ? 'No reason given' : note.text}
                  </div>
                ))}
              {draft?.last === index ? (
                <NoteBox
                  count={draft.last - draft.first + 1}
                  text={text}
                  onText={onText}
                  onCancel={onCancel}
                  onSend={onSend}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function WorkPanes({ work, notes, live, queued, onNote, sizes, onSizes }: WorkPanesProps) {
  const { thoughts, changes } = work;
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<Lines | null>(null);
  const [text, setText] = useState('');
  const [line, setLine] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const view = useStickToBottom(`${thoughts.length}:${thoughts.at(-1)?.text.length}`, null);
  // Until the reader picks one, the newest change is the one in view.
  const selected = changes.find((change) => change.key === picked) ?? changes.at(-1) ?? null;

  const draw = useCallback(() => {
    const root = box.current;
    const find = (name: string, key: string | undefined) =>
      [...(root?.querySelectorAll<HTMLElement>(`[data-${name}]`) ?? [])].find((node) => node.dataset[name] === key);
    const from = find('thought', selected?.thought);
    const to = find('change', selected?.key);
    if (root === null || from === undefined || to === undefined) {
      setLine('');
      return;
    }
    const frame = root.getBoundingClientRect();
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const within = (y: number) => Math.min(Math.max(y, frame.top + 44), frame.bottom - 20) - frame.top;
    const startX = a.right - frame.left;
    const endX = b.left - frame.left;
    const startY = within(a.top + 16);
    const endY = within(b.top + 20);
    const middle = (startX + endX) / 2;
    setLine(`M${startX} ${startY} C${middle} ${startY} ${middle} ${endY} ${endX} ${endY}`);
  }, [selected?.key, selected?.thought]);

  useLayoutEffect(draw, [draw, thoughts.length, changes.length, notes.length, draft, sizes]);
  useEffect(() => {
    addEventListener('resize', draw);
    return () => removeEventListener('resize', draw);
  }, [draw]);
  // The browser settles a highlight just after the button comes up, so it is read a moment later.
  // A note already being written is not thrown away by a stray highlight.
  const latest = useRef({ changes, text });
  latest.current = { changes, text };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const lines = linesOfSelection(getSelection(), latest.current.changes);
        if (lines !== null && latest.current.text === '') setDraft(lines);
      }, 0);
    };
    document.addEventListener('pointerup', check);
    document.addEventListener('keyup', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerup', check);
      document.removeEventListener('keyup', check);
    };
  }, []);

  function close(): void {
    setDraft(null);
    setText('');
    getSelection()?.removeAllRanges();
  }

  function send(kind: NoteKind): void {
    if (draft === null) return;
    onNote({
      change: draft.change.key,
      path: draft.change.path,
      kind,
      code: codeOf(draft),
      text: text.trim(),
      first: draft.first,
      last: draft.last,
    });
    close();
  }

  return (
    <div className="work-panes" ref={box}>
      <section className="work-pane thinking" aria-label="Thinking">
        <header className="work-head">
          <span>Thinking</span>
          <span>{thoughts.length === 1 ? '1 step' : `${thoughts.length} steps`}</span>
        </header>
        <div className="work-scroll" ref={view.scroller} onScroll={() => { view.onScroll(); draw(); }}>
          <div className="work-list" ref={view.content}>
            {thoughts.map((thought, index) => (
              <details
                key={thought.key}
                className={selected?.thought === thought.key ? 'work-thought selected' : 'work-thought'}
                data-thought={thought.key}
                open={live && index === thoughts.length - 1 ? true : undefined}
                onToggle={draw}
              >
                <summary
                  onClick={() => {
                    const first = thought.changes[0];
                    if (first !== undefined) setPicked(first);
                  }}
                >
                  {thought.title}
                  {thought.changes.length === 0 ? null : (
                    <span className="led">
                      {thought.changes.length === 1 ? 'Led to a change' : `Led to ${thought.changes.length} changes`}
                    </span>
                  )}
                </summary>
                {thought.text === '' ? null : <p className="pre">{thought.text}</p>}
                {thought.did.map((did, at) => (
                  <code className="work-did" key={at}>{did}</code>
                ))}
              </details>
            ))}
          </div>
        </div>
      </section>
      <section className="work-pane changes" aria-label="Changes">
        <header className="work-head">
          <span>Changes</span>
          <span>
            {queued === 0
              ? 'Accepted unless you object'
              : `${queued === 1 ? '1 note' : `${queued} notes`} waiting for this turn to end`}
          </span>
        </header>
        <div className="work-scroll gutter" onScroll={draw}>
          <div className="work-list">
            {changes.length === 0 ? (
              <p className="work-hint">Nothing changed yet. Edits appear here as the model makes them.</p>
            ) : (
              <p className="work-hint">Highlight code to ask about it, comment on it or reject it.</p>
            )}
            {changes.map((change) => (
              <ChangeCard
                key={change.key}
                change={change}
                notes={notes.filter((note) => note.change === change.key)}
                draft={draft?.change.key === change.key ? draft : null}
                selected={selected?.key === change.key}
                onSelect={() => {
                  if (getSelection()?.isCollapsed !== false) setPicked(change.key);
                }}
                text={text}
                onText={setText}
                onCancel={close}
                onSend={send}
              />
            ))}
            <p className="work-hint">Shows what the file tools changed. A change a shell command makes is not listed yet.</p>
          </div>
        </div>
      </section>
      <PaneBar
        side="thinking"
        label="Resize the thinking pane"
        measure={(x) => x - (box.current?.getBoundingClientRect().left ?? 0)}
        onWidth={(thinking) => onSizes({ ...sizes, thinking })}
        onReset={() => onSizes({ ...sizes, thinking: DEFAULT_WORK_SIZES.thinking })}
      />
      <PaneBar
        side="chat"
        label="Resize the chat"
        measure={(x) => (box.current?.getBoundingClientRect().right ?? 0) + (sizeOfChat(box.current)) - x}
        onWidth={(chat) => onSizes({ ...sizes, chat })}
        onReset={() => onSizes({ ...sizes, chat: DEFAULT_WORK_SIZES.chat })}
      />
      <svg className="work-thread" aria-hidden="true">
        <path d={line} />
      </svg>
    </div>
  );
}
