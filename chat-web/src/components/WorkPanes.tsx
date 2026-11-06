// The two panes beside the chat when the model works in its sandbox: its thinking, and what it
// changed. A line joins a change to the thought behind it, across the gutter the changes keep
// on their left so that it never runs over text. Everything counts as accepted. Highlighting
// code and right-clicking is how the reader objects, and that note goes into the chat.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
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
};

const KINDS: Readonly<Record<NoteKind, { readonly label: string; readonly hint: string }>> = {
  comment: { label: 'Comment', hint: 'Tell the model what you think of this code' },
  ask: { label: 'Question', hint: 'What do you want to know?' },
  reject: { label: 'Rejected', hint: 'Why? Optional, but it helps' },
};

type Lines = { readonly change: Change; readonly first: number; readonly last: number };
type Menu = Lines & { readonly x: number; readonly y: number };
type Draft = Lines & { readonly kind: NoteKind };

function lineIndex(node: Node | null): number | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  const line = element?.closest<HTMLElement>('[data-line]');
  return line === null || line === undefined ? null : Number(line.dataset['line']);
}

// The lines a right-click means: the highlighted ones inside this change, or else the one under
// the pointer.
export function linesAt(target: Element, selection: Selection | null, change: Change): Lines | null {
  const clicked = lineIndex(target);
  if (clicked === null) return null;
  const one = { change, first: clicked, last: clicked };
  if (selection === null || selection.isCollapsed) return one;
  const from = lineIndex(selection.anchorNode);
  const to = lineIndex(selection.focusNode);
  const box = target.closest('[data-change]');
  const inside = (node: Node | null) => node !== null && box?.contains(node) === true;
  if (from === null || to === null || !inside(selection.anchorNode) || !inside(selection.focusNode)) return one;
  return { change, first: Math.min(from, to), last: Math.max(from, to) };
}

function codeOf(lines: Lines): string {
  return lines.change.lines
    .slice(lines.first, lines.last + 1)
    .map((line) => line.text)
    .join('\n');
}

const MARKS = { add: '+', del: '-', same: ' ' } as const;

function NoteBox({ draft, onCancel, onSend }: {
  readonly draft: Draft;
  readonly onCancel: () => void;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const { label, hint } = KINDS[draft.kind];
  return (
    <div className={`work-note open ${draft.kind}`}>
      <b>{label}</b>
      <textarea
        aria-label={label}
        placeholder={hint}
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="work-note-row">
        <button className="tool" type="button" onClick={onCancel}>
          <span>Cancel</span>
        </button>
        <button
          className="tool go"
          type="button"
          disabled={text.trim() === '' && draft.kind !== 'reject'}
          onClick={() => onSend(text.trim())}
        >
          <span>Send to chat</span>
        </button>
      </div>
    </div>
  );
}

function ChangeCard({ change, notes, draft, selected, onSelect, onMenu, onCancel, onSend }: {
  readonly change: Change;
  readonly notes: readonly Note[];
  readonly draft: Draft | null;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onMenu: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onCancel: () => void;
  readonly onSend: (text: string) => void;
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
      <div className="work-diff" onContextMenu={onMenu}>
        {change.lines.map((line, index) => {
          const held = notes.filter((note) => index >= note.first && index <= note.last);
          const marked = held.some((note) => note.kind === 'reject') ? 'struck' : held.length > 0 ? 'marked' : '';
          return (
            <div key={index}>
              <div className={`work-line ${line.kind} ${marked}`} data-line={index}>
                {MARKS[line.kind]} {line.text}
              </div>
              {notes
                .filter((note) => note.last === index)
                .map((note) => (
                  <div className={`work-note ${note.kind}`} key={note.id}>
                    <b>{KINDS[note.kind].label}</b>
                    {note.text === '' ? 'No reason given' : note.text}
                  </div>
                ))}
              {draft?.last === index ? <NoteBox draft={draft} onCancel={onCancel} onSend={onSend} /> : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function WorkPanes({ work, notes, live, queued, onNote }: WorkPanesProps) {
  const { thoughts, changes } = work;
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
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

  useLayoutEffect(draw, [draw, thoughts.length, changes.length, notes.length, draft]);
  useEffect(() => {
    addEventListener('resize', draw);
    return () => removeEventListener('resize', draw);
  }, [draw]);
  useEffect(() => {
    if (menu === null) return undefined;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    addEventListener('click', close);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('click', close);
      removeEventListener('keydown', onKey);
    };
  }, [menu]);

  function openMenu(change: Change, event: MouseEvent<HTMLDivElement>): void {
    if (!(event.target instanceof Element) || event.target.closest('.work-note') !== null) return;
    const lines = linesAt(event.target, getSelection(), change);
    if (lines === null) return;
    event.preventDefault();
    setMenu({ ...lines, x: event.clientX, y: event.clientY });
  }

  function send(text: string): void {
    if (draft === null) return;
    onNote({
      change: draft.change.key,
      path: draft.change.path,
      kind: draft.kind,
      code: codeOf(draft),
      text,
      first: draft.first,
      last: draft.last,
    });
    setDraft(null);
    getSelection()?.removeAllRanges();
  }

  const menuAt: CSSProperties | undefined =
    menu === null ? undefined : { left: Math.min(menu.x, innerWidth - 216), top: Math.min(menu.y, innerHeight - 150) };
  const count = menu === null ? 0 : menu.last - menu.first + 1;

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
              <p className="work-hint">Highlight code and right-click to comment, ask why or reject.</p>
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
                onMenu={(event) => openMenu(change, event)}
                onCancel={() => setDraft(null)}
                onSend={send}
              />
            ))}
            <p className="work-hint">Shows what the file tools changed. A change a shell command makes is not listed yet.</p>
          </div>
        </div>
      </section>
      <svg className="work-thread" aria-hidden="true">
        <path d={line} />
      </svg>
      {menu === null ? null : (
        <div className="work-menu" role="menu" style={menuAt}>
          <p>{count === 1 ? '1 line' : `${count} lines`} selected</p>
          {(['comment', 'ask', 'reject'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className={kind === 'reject' ? 'danger' : ''}
              onClick={() => setDraft({ ...menu, kind })}
            >
              {kind === 'comment' ? 'Comment' : kind === 'ask' ? 'Ask why' : 'Reject'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
