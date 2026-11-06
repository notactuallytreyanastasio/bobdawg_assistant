// The graph page: every goal down the side, the tree of the one in view, the node being read,
// and a place to ask the model about any of it. The model reads the graph with the same tools
// that write to it, and a write waits here for the reader's yes.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, WheelEvent } from 'react';
import { platformFetch } from '../api/chatClient';
import type { FetchLike } from '../api/chatClient';
import { callGraphTool, listGraphTools } from '../api/graph';
import type { GraphTool } from '../api/graph';
import { fetchModels } from '../api/models';
import type { ModelInfo } from '../api/models';
import type { ChatMessage } from '../chat/message';
import { Markdown } from '../components/Markdown';
import { apiOrigin } from '../env';
import { useChat } from '../hooks/useChat';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { graphAssistant } from '../tools/graph';
import type { GraphRequest } from '../tools/graph';
import { CARD_HEIGHT, CARD_WIDTH, layoutTree } from './layout';
import { CHAT_BRANCH, goalsOf, indexGraph, nodeIdsIn, parseGraph, rootOf, searchNodes, statsOf, treeOf } from './model';
import type { Graph, GraphIndex, GraphNode } from './model';

export type GraphAppProps = {
  readonly origin?: string;
  readonly fetchImpl?: FetchLike;
};

type View = { readonly x: number; readonly y: number; readonly scale: number };
type Waiting = GraphRequest & { readonly answer: (yes: boolean) => void };

const START_VIEW: View = { x: 32, y: 32, scale: 0.9 };
const MIN_SCALE = 0.2;
const MAX_SCALE = 2;

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function Timeline({ days, chosen, onChoose }: {
  readonly days: readonly (readonly [string, number])[];
  readonly chosen: string | null;
  readonly onChoose: (day: string | null) => void;
}) {
  const most = Math.max(1, ...days.map(([, count]) => count));
  return (
    <div className="g-days" role="group" aria-label="Nodes by day">
      {days.map(([day, count]) => (
        <button
          key={day}
          type="button"
          aria-pressed={chosen === day}
          title={`${day}: ${count} nodes`}
          aria-label={`${day}: ${count} nodes`}
          onClick={() => onChoose(chosen === day ? null : day)}
        >
          <i style={{ height: `${Math.max(8, (count / most) * 100)}%` }} />
        </button>
      ))}
    </div>
  );
}

function Tree({ index, root, selected, onSelect }: {
  readonly index: GraphIndex;
  readonly root: string;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState(START_VIEW);
  const drag = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutTree(treeOf(index, root), folded), [index, root, folded]);

  useEffect(() => {
    setFolded(new Set());
    setView(START_VIEW);
  }, [root]);

  // A node chosen from elsewhere is brought into view, unfolding whatever hides it.
  useEffect(() => {
    if (selected === null) return;
    const spot = layout.placed.find((node) => node.id === selected);
    const frame = box.current?.getBoundingClientRect();
    if (spot === undefined || frame === undefined || frame.width === 0) return;
    setView((now) => {
      const left = now.x + spot.x * now.scale;
      const top = now.y + spot.y * now.scale;
      const inside = left >= 0 && top >= 0 && left + CARD_WIDTH * now.scale <= frame.width && top + CARD_HEIGHT * now.scale <= frame.height;
      if (inside) return now;
      return { ...now, x: frame.width / 2 - (spot.x + CARD_WIDTH / 2) * now.scale, y: frame.height / 2 - (spot.y + CARD_HEIGHT / 2) * now.scale };
    });
  }, [selected, layout]);

  function zoom(event: WheelEvent<HTMLDivElement>): void {
    const frame = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - frame.left;
    const py = event.clientY - frame.top;
    setView((now) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, now.scale * Math.exp(-event.deltaY / 400)));
      const ratio = scale / now.scale;
      return { scale, x: px - (px - now.x) * ratio, y: py - (py - now.y) * ratio };
    });
  }

  function grab(event: PointerEvent<HTMLDivElement>): void {
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    drag.current = { x: event.clientX - view.x, y: event.clientY - view.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    const from = drag.current;
    if (from !== null) setView((now) => ({ ...now, x: event.clientX - from.x, y: event.clientY - from.y }));
  }

  function fit(): void {
    const frame = box.current?.getBoundingClientRect();
    if (frame === undefined || frame.width === 0) return;
    const scale = Math.min(1, Math.max(MIN_SCALE, Math.min((frame.width - 48) / layout.width, (frame.height - 48) / layout.height)));
    setView({ scale, x: 24, y: 24 });
  }

  return (
    <div
      className="g-tree"
      ref={box}
      onWheel={zoom}
      onPointerDown={grab}
      onPointerMove={move}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <div className="g-tree-tools">
        <button className="tool" type="button" onClick={fit}>
          <span>Fit</span>
        </button>
      </div>
      <div className="g-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true">
          {layout.links.map((link) => (
            <path key={`${link.from}/${link.to}`} d={link.path} />
          ))}
        </svg>
        {layout.placed.map((spot) => {
          const node = index.byId.get(spot.id);
          if (node === undefined) return null;
          const parent = (index.children.get(spot.id) ?? []).length > 0;
          return (
            <div
              key={spot.id}
              className={`g-card ${node.type}${selected === spot.id ? ' selected' : ''}`}
              style={{ left: spot.x, top: spot.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
            >
              <button className="g-card-open" type="button" onClick={() => onSelect(spot.id)}>
                <b>{node.type}</b>
                <span>{node.title}</span>
              </button>
              {parent ? (
                <button
                  className="g-fold"
                  type="button"
                  aria-label={spot.hidden > 0 ? `Show ${spot.hidden} hidden nodes` : 'Fold this branch'}
                  onClick={() =>
                    setFolded((now) => {
                      const next = new Set(now);
                      if (!next.delete(spot.id)) next.add(spot.id);
                      return next;
                    })
                  }
                >
                  {spot.hidden > 0 ? spot.hidden : '−'}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Detail({ node, index, onSelect, onAsk }: {
  readonly node: GraphNode;
  readonly index: GraphIndex;
  readonly onSelect: (id: string) => void;
  readonly onAsk: (node: GraphNode) => void;
}) {
  const list = (label: string, ids: readonly string[]) =>
    ids.length === 0 ? null : (
      <>
        <dt>{label}</dt>
        <dd>
          {ids.map((id) => (
            <button key={id} className="g-link" type="button" onClick={() => onSelect(id)}>
              {index.byId.get(id)?.title ?? id}
            </button>
          ))}
        </dd>
      </>
    );
  return (
    <article className="g-detail">
      <p className={`g-kind ${node.type}`}>
        {node.type}
        {node.status === '' ? '' : ` · ${node.status}`}
        {node.createdAt === '' ? '' : ` · ${dayOf(node.createdAt)}`}
      </p>
      <h2>{node.title}</h2>
      {node.prompt === '' ? null : <blockquote className="pre">{node.prompt}</blockquote>}
      {node.description === '' ? null : <p className="pre">{node.description}</p>}
      <dl>
        {node.commit === '' ? null : (
          <>
            <dt>Commit</dt>
            <dd><code>{node.commit}</code></dd>
          </>
        )}
        {node.files.length === 0 ? null : (
          <>
            <dt>Files</dt>
            <dd>{node.files.map((file) => <code key={file}>{file}</code>)}</dd>
          </>
        )}
        {list('Came from', index.parents.get(node.id) ?? [])}
        {list('Led to', index.children.get(node.id) ?? [])}
      </dl>
      <button className="tool" type="button" onClick={() => onAsk(node)}>
        <span>Ask about this</span>
      </button>
    </article>
  );
}

const Answer = memo(function Answer({ message, index, onSelect }: {
  readonly message: ChatMessage;
  readonly index: GraphIndex;
  readonly onSelect: (id: string) => void;
}) {
  const named = nodeIdsIn(message.text, index);
  return (
    <div className="g-answer">
      {message.calls.map((call) => (
        <code className="g-call" key={call.id}>{call.name}</code>
      ))}
      {message.text === '' ? null : <Markdown text={message.text} />}
      {named.map((id) => (
        <button key={id} className="g-link" type="button" onClick={() => onSelect(id)}>
          {index.byId.get(id)?.title ?? id}
        </button>
      ))}
    </div>
  );
});

export function GraphApp({ origin = apiOrigin(), fetchImpl }: GraphAppProps) {
  const send = fetchImpl ?? platformFetch;
  const [graph, setGraph] = useState<Graph | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tools, setTools] = useState<readonly GraphTool[]>([]);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [withChats, setWithChats] = useState(false);
  const [question, setQuestion] = useState('');
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  const load = useCallback(async () => {
    const answer = await callGraphTool(origin, 'get_graph', { include_details: true, max_nodes: 20000 }, undefined, send);
    const parsed = answer.ok ? parseGraph(answer.text) : null;
    if (parsed === null) setFailure(answer.ok ? 'The graph came back in a form this page cannot read.' : answer.text);
    else {
      setFailure(null);
      setGraph(parsed);
    }
  }, [origin, send]);

  useEffect(() => {
    void load();
    void listGraphTools(origin, send).then(setTools);
    void fetchModels({ origin, fetchImpl: send }).then((models) => setModel(models[0] ?? null));
  }, [load, origin, send]);

  const assistant = useMemo(
    () =>
      graphAssistant({
        tools,
        run: (tool, args, signal) => callGraphTool(origin, tool, args, signal, send),
        confirm: (request) => new Promise((answer) => setWaiting({ ...request, answer })),
        onChanged: () => void load(),
      }),
    [tools, origin, send, load],
  );
  const chat = useChat({ model: model?.id ?? '', origin, fetchImpl: send, thinking: true, assistant });
  const { messages, streaming, error } = chat.conversation;
  const view = useStickToBottom(`${messages.length}:${messages.at(-1)?.text.length}`, null);

  const index = useMemo(() => (graph === null ? null : indexGraph(graph)), [graph]);
  const shownNodes = useMemo(
    () => (graph?.nodes ?? []).filter((node) => withChats || node.branch !== CHAT_BRANCH),
    [graph, withChats],
  );
  const stats = useMemo(() => statsOf(shownNodes), [shownNodes]);
  const goals = useMemo(
    () => (graph === null || index === null ? [] : goalsOf(graph, index, withChats)),
    [graph, index, withChats],
  );
  const listed = goals.filter((goal) => day === null || dayOf(goal.node.createdAt) === day);
  const found = useMemo(() => searchNodes(shownNodes, query), [shownNodes, query]);
  const shownRoot = root ?? goals[0]?.node.id ?? null;
  const node = selected === null ? null : (index?.byId.get(selected) ?? null);

  function open(id: string): void {
    if (index === null) return;
    setRoot(rootOf(index, id));
    setSelected(id);
  }

  function ask(text: string): void {
    if (text.trim() === '' || model === null || streaming) return;
    chat.send(text);
    setQuestion('');
  }

  function decide(yes: boolean): void {
    waiting?.answer(yes);
    setWaiting(null);
  }

  return (
    <div className="g-app">
      <header className="g-top">
        <h1>Decision graph</h1>
        <p>
          {shownNodes.length} nodes · {goals.length} goals
          {stats.types.slice(0, 5).map(([type, count]) => (
            <span key={type} className={`g-kind ${type}`}> · {count} {type}</span>
          ))}
        </p>
        <span className="spacer" />
        <label className="g-check">
          <input type="checkbox" checked={withChats} onChange={(event) => setWithChats(event.target.checked)} />
          Include chat turns
        </label>
        <a className="tool" href="./">Chat</a>
      </header>
      {failure === null ? null : <p className="error" role="alert">{failure}</p>}
      <div className="g-body">
        <nav className="g-side" aria-label="Goals">
          <input
            id="graph-search"
            type="search"
            aria-label="Search the graph"
            placeholder="Search every node"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Timeline days={stats.days} chosen={day} onChoose={setDay} />
          <ul className="g-goals">
            {query.trim() === ''
              ? listed.map((goal) => (
                  <li key={goal.node.id}>
                    <button
                      type="button"
                      aria-pressed={shownRoot === goal.node.id}
                      onClick={() => {
                        setRoot(goal.node.id);
                        setSelected(goal.node.id);
                      }}
                    >
                      <span>{goal.node.title}</span>
                      <small>{dayOf(goal.node.createdAt)} · {goal.size} nodes</small>
                    </button>
                  </li>
                ))
              : found.map((hit) => (
                  <li key={hit.id}>
                    <button type="button" onClick={() => open(hit.id)}>
                      <span>{hit.title}</span>
                      <small>{hit.type}</small>
                    </button>
                  </li>
                ))}
          </ul>
        </nav>
        <main className="g-main">
          {index === null || shownRoot === null ? (
            <p className="g-empty">{failure === null ? 'Loading the graph' : 'No graph to show'}</p>
          ) : (
            <Tree index={index} root={shownRoot} selected={selected} onSelect={setSelected} />
          )}
        </main>
        <aside className="g-right" aria-label="Details and questions">
          {node === null || index === null ? (
            <p className="g-empty">Pick a node to read it.</p>
          ) : (
            <Detail
              node={node}
              index={index}
              onSelect={open}
              onAsk={(about) => setQuestion(`About node ${about.id} ("${about.title}"): `)}
            />
          )}
          <section className="g-ask" aria-label="Ask about the graph">
            <div className="g-thread" ref={view.scroller} onScroll={view.onScroll}>
              <div ref={view.content}>
                {messages.length === 0 ? (
                  <p className="g-empty">Ask {model?.name ?? 'the model'} anything about this history. It reads the graph as it answers, and asks you before changing it.</p>
                ) : null}
                {index === null
                  ? null
                  : messages.map((message) =>
                      message.role === 'user' ? (
                        <p className="g-you pre" key={message.id}>{message.text}</p>
                      ) : message.role === 'assistant' ? (
                        <Answer key={message.id} message={message} index={index} onSelect={open} />
                      ) : null,
                    )}
                {streaming ? <p className="g-empty" role="status">Working through the graph</p> : null}
                {error === null ? null : <p className="error" role="alert">{error}</p>}
              </div>
            </div>
            {waiting === null ? null : (
              <div className="g-approve" role="alertdialog" aria-label="Allow this change?">
                <b>The model wants to change the graph with {waiting.tool}</b>
                <pre>{JSON.stringify(waiting.args, null, 2)}</pre>
                <div>
                  <button className="tool" type="button" onClick={() => decide(false)}><span>Decline</span></button>
                  <button className="tool go" type="button" onClick={() => decide(true)}><span>Allow</span></button>
                </div>
              </div>
            )}
            <form
              className="g-form"
              onSubmit={(event) => {
                event.preventDefault();
                ask(question);
              }}
            >
              <textarea
                id="graph-question"
                aria-label="Your question"
                placeholder="Why did we choose this?"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    ask(question);
                  }
                }}
              />
              {streaming ? (
                <button className="tool" type="button" onClick={chat.stop}><span>Stop</span></button>
              ) : (
                <button className="tool go" type="submit" disabled={model === null || question.trim() === ''}><span>Ask</span></button>
              )}
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
}
