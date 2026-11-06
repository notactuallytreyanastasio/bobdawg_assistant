// The page: the model name as the server reports it, the transcript, the question box,
// and whatever the server complained about last. Nothing here decides any rule - the
// reducer does, and the hook runs the turn.

import { useEffect, useState } from 'react';
import { platformFetch } from './api/chatClient';
import type { FetchLike } from './api/chatClient';
import { fetchModelIds } from './api/models';
import { apiOrigin } from './env';
import { useChat } from './hooks/useChat';
import { Composer } from './components/Composer';
import { Transcript } from './components/Transcript';

export type AppProps = {
  readonly origin?: string;
  readonly fetchImpl?: FetchLike;
};

export function App({ origin = apiOrigin(), fetchImpl }: AppProps) {
  const send = fetchImpl ?? platformFetch;
  const [model, setModel] = useState('');
  const chat = useChat({ model, origin, fetchImpl: send });

  // The listing answers once with the models this server holds. The first is the one to
  // ask for, and its name is what the header shows.
  useEffect(() => {
    let settled = false;
    fetchModelIds({ origin, fetchImpl: send }).then((ids) => {
      if (!settled) setModel(ids[0] ?? '');
    });
    return () => {
      settled = true;
    };
  }, [origin, send]);

  return (
    <main className="page">
      <header className="header">
        <h1>ds4 chat</h1>
        <p className="model">{model === '' ? 'ds4-server' : model}</p>
        <button className="reset" type="button" onClick={chat.reset}>
          New chat
        </button>
      </header>

      {chat.conversation.error === null ? null : (
        <p className="error" role="alert">
          {chat.conversation.error}
        </p>
      )}

      <Transcript conversation={chat.conversation} />

      <Composer
        conversation={chat.conversation}
        ready={model !== ''}
        onSend={chat.send}
        onStop={chat.stop}
      />
    </main>
  );
}
