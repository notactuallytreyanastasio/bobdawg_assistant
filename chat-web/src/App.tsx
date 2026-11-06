// The page: the saved chats, the model as the server reports it, the transcript, the
// question box, and whatever the server complained about last. Nothing here decides any
// rule - the reducer does, and the hook runs the turn.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { platformFetch } from './api/chatClient';
import type { FetchLike } from './api/chatClient';
import { fetchModels } from './api/models';
import type { ModelInfo } from './api/models';
import { recordTurn, turnRecordOf } from './api/recordTurn';
import { sharePage } from './api/sharePage';
import { NO_WORKSPACES, createWorkspace, isWorkspaceId, runInWorkspace } from './api/workspace';
import type { RecordResult } from './api/recordTurn';
import { artifactsOf } from './chat/artifact';
import type { Conversation } from './chat/conversation';
import { contextPercent } from './chat/format';
import {
  loadPlot,
  loadThinking,
  loadWorkspaceId,
  loadWorkspaceOn,
  platformStore,
  savePlot,
  saveThinking,
  saveWorkspaceId,
  saveWorkspaceOn,
} from './chat/storage';
import type { StoreLike } from './chat/storage';
import { ArtifactPanel } from './components/ArtifactPanel';
import type { PanelTab } from './components/ArtifactPanel';
import { Composer } from './components/Composer';
import { MenuIcon, RetryIcon } from './components/icons';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import { Welcome } from './components/Welcome';
import { apiOrigin } from './env';
import { useArtifacts } from './hooks/useArtifacts';
import type { HostFactory } from './hooks/useArtifacts';
import { useChat } from './hooks/useChat';
import { useLibrary } from './hooks/useLibrary';
import { plotAssistant } from './tools/assistant';
import { workspaceAssistant } from './tools/workspace';
import type { WorkspaceRunner } from './tools/workspace';

export type AppProps = {
  readonly origin?: string;
  readonly fetchImpl?: FetchLike;
  readonly store?: StoreLike | null;
  readonly retryMs?: number;
  readonly createHost?: HostFactory;
};

// crypto.randomUUID needs a secure context, and the tailnet page is plain http. These ids
// only have to differ inside one browser's list.
function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function App({
  origin = apiOrigin(),
  fetchImpl,
  store = platformStore(),
  retryMs = 3000,
  createHost,
}: AppProps) {
  const send = fetchImpl ?? platformFetch;
  const library = useLibrary(store);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [activeId, setActiveId] = useState(() => library.initial?.id ?? newChatId());
  const [drawer, setDrawer] = useState(false);
  const [thinking, setThinking] = useState(() => loadThinking(store));
  const [graph, setGraph] = useState<RecordResult | null>(null);
  const [plot, setPlot] = useState(() => loadPlot(store));
  const [workspace, setWorkspace] = useState(() => loadWorkspaceOn(store));
  // The chart in the panel, by its key, or by call id for one the turn has only just made.
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('preview');
  const [fullView, setFullView] = useState(false);

  const artifacts = useArtifacts({
    onReveal: (callId) => {
      setPanelTab('preview');
      setOpenArtifact(callId);
    },
    ...(createHost === undefined ? {} : { createHost }),
  });
  // Made on first use, so that nobody who never turns this on has a workspace at all.
  const runInSandbox = useCallback<WorkspaceRunner>(
    async (tool, args, signal) => {
      const held = loadWorkspaceId(store);
      const id = isWorkspaceId(held) ? held : await createWorkspace(origin, send);
      if (id === null) return { ok: false, fatal: true, text: NO_WORKSPACES };
      if (id !== held) saveWorkspaceId(store, id);
      return runInWorkspace({ origin, id, tool, args, signal, fetchImpl: send });
    },
    [origin, send, store],
  );
  const assistant = useMemo(() => {
    if (workspace) return workspaceAssistant(runInSandbox);
    return plot ? plotAssistant(artifacts.runner) : null;
  }, [workspace, plot, artifacts.runner, runInSandbox]);

  // Every finished turn goes to the decision graph by way of the server. The answer is on
  // the page either way, so all that comes back is whether to say it did not land.
  function record(conversation: Conversation, failure: string | null): void {
    const turn = turnRecordOf(activeId, model?.name ?? '', conversation.messages, failure);
    if (turn === null) return;
    void recordTurn({ origin, fetchImpl: send, turn }).then(setGraph);
  }

  const chat = useChat({
    model: model?.id ?? '',
    origin,
    fetchImpl: send,
    thinking,
    assistant,
    onBegin: artifacts.beginTurn,
    initialMessages: library.initial?.messages ?? [],
    onTurn: record,
  });
  const { messages, streaming } = chat.conversation;

  // The server may still be loading the model, or not started yet: the page keeps asking
  // until it answers, so opening the page early costs nothing.
  useEffect(() => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (): Promise<void> => {
      const models = await fetchModels({ origin, fetchImpl: send });
      if (settled) return;
      const first = models[0];
      if (first !== undefined) {
        setModel(first);
        setUnreachable(false);
      } else {
        setUnreachable(true);
        timer = setTimeout(() => void ask(), retryMs);
      }
    };
    void ask();
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [origin, send, retryMs]);

  // Saved when a question goes out and when its answer ends, not on every word. An answer
  // cut short by a closed tab is lost, but its question is there to ask again.
  useEffect(() => {
    if (messages.length > 0) library.save(activeId, messages);
  }, [messages.length, streaming, activeId]);

  const charts = artifactsOf(messages);
  const shown = charts.findLastIndex((entry) => entry.key === openArtifact || entry.callId === openArtifact);
  const current = charts[shown] ?? null;

  // A retry can take away the chart a frame belongs to, and a frame nobody can see is a
  // frame nobody can stop.
  const orphaned = current === null && artifacts.status.live && !artifacts.checking;
  useEffect(() => {
    if (orphaned) artifacts.remove();
  }, [orphaned, artifacts.remove]);

  // The page has one frame, so anything that changes the chart in view takes the old one down
  // first, and no other chart runs until it is tapped.
  function clearPanel(): void {
    artifacts.reset();
    setOpenArtifact(null);
    setFullView(false);
  }

  function openChart(key: string, tab: PanelTab = 'preview'): void {
    if (key !== current?.key && key !== current?.callId && !artifacts.checking) artifacts.remove();
    setPanelTab(tab);
    setOpenArtifact(key);
  }

  function closeChart(): void {
    artifacts.remove();
    setOpenArtifact(null);
    setFullView(false);
  }

  function step(by: -1 | 1): void {
    const next = charts[shown + by];
    if (next !== undefined) openChart(next.key);
  }

  function startNew(): void {
    library.save(activeId, messages);
    library.select(null);
    clearPanel();
    chat.reset();
    setActiveId(newChatId());
    setDrawer(false);
  }

  function open(id: string): void {
    setDrawer(false);
    if (id === activeId) return;
    const saved = library.chats.find((entry) => entry.id === id);
    if (saved === undefined) return;
    library.save(activeId, messages);
    library.select(id);
    clearPanel();
    chat.load(saved.messages);
    setActiveId(id);
  }

  function remove(id: string): void {
    library.remove(id);
    if (id === activeId) {
      clearPanel();
      chat.reset();
      setActiveId(newChatId());
    }
  }

  function chooseThinking(next: boolean): void {
    setThinking(next);
    saveThinking(store, next);
  }

  function choosePlot(next: boolean): void {
    setPlot(next);
    savePlot(store, next);
    if (next) chooseWorkspace(false);
  }

  // One or the other: a turn has one assistant, and each has its own system prompt.
  function chooseWorkspace(next: boolean): void {
    setWorkspace(next);
    saveWorkspaceOn(store, next);
    if (next) {
      setPlot(false);
      savePlot(store, false);
    }
  }

  const ready = model !== null;
  // Asking again needs a model to ask, which a restored chat may be ahead of.
  const retry = ready ? chat.retry : undefined;
  const notice = ready
    ? undefined
    : unreachable
      ? "Can't reach ds4-server yet, still trying"
      : 'Connecting to ds4-server';
  const lastStats = messages.findLast((message) => message.stats !== null)?.stats ?? null;

  return (
    <div className="app">
      <Sidebar
        chats={library.chats}
        activeId={activeId}
        open={drawer}
        onNew={startNew}
        onOpen={open}
        onDelete={remove}
        onClose={() => setDrawer(false)}
      />
      <main className="page">
        <header className="header">
          <button className="menu" type="button" aria-label="Open chats" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </button>
          <p className="model">
            <span className={ready ? 'dot up' : unreachable ? 'dot down' : 'dot'} aria-hidden="true" />
            {model?.name ?? 'ds4-server'}
          </p>
          {graph === 'recorded' ? (
            <span className="graph" title="Each finished turn is written to the deciduous decision graph">
              In the decision graph
            </span>
          ) : null}
          {graph === 'missed' ? (
            <span className="graph lost" title="The answer is fine; the graph has no record of it">
              Last turn not recorded
            </span>
          ) : null}
        </header>

        {messages.length === 0 && !streaming ? (
          <Welcome ready={ready} onPick={chat.send} />
        ) : (
          <Transcript
            conversation={chat.conversation}
            pending={artifacts.pending}
            onRun={artifacts.grant}
            onCode={(callId) => openChart(callId, 'code')}
            onOpen={openChart}
            {...(retry === undefined ? {} : { onRetry: retry })}
          />
        )}

        {chat.conversation.error === null ? null : (
          <div className="error" role="alert">
            <span>{chat.conversation.error}</span>
            {retry === undefined ? null : (
              <button className="tool" type="button" onClick={retry}>
                <RetryIcon />
                <span>Try again</span>
              </button>
            )}
          </div>
        )}

        <Composer
          conversation={chat.conversation}
          ready={ready}
          thinking={thinking}
          contextPercent={contextPercent(lastStats?.contextTokens ?? null, model?.contextLength ?? null)}
          onThinking={chooseThinking}
          plot={plot && !workspace}
          onPlot={choosePlot}
          workspace={workspace}
          onWorkspace={chooseWorkspace}
          onSend={chat.send}
          onStop={chat.stop}
          {...(notice === undefined ? {} : { notice })}
        />
      </main>
      <ArtifactPanel
        slot={artifacts.slot}
        artifact={current}
        position={{ index: shown, count: charts.length }}
        tab={panelTab}
        checking={artifacts.checking}
        live={artifacts.status.live}
        ended={artifacts.status.ended}
        full={fullView}
        busy={streaming}
        onTab={setPanelTab}
        onRun={() => {
          if (current !== null) artifacts.show(current);
        }}
        onStop={artifacts.remove}
        onClose={closeChart}
        onFull={setFullView}
        onStep={step}
        onShare={async () => (current === null ? { kind: 'failed' } : sharePage({ origin, artifact: current, fetchImpl: send }))}
      />
    </div>
  );
}
