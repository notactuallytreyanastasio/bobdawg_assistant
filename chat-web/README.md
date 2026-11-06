# Chat

A browser page for chatting with [ds4-server](../docs/SERVER.md): ask a question,
watch the answer arrive word by word as formatted markdown, and see the model's
thinking folded away beside it. Chats are kept in the browser. React on TypeScript, tested with Vitest and Testing Library, built by
Vite.

```
npm test      # the test suite
npm run check # type check, then the test suite
npm run dev   # the page, at http://localhost:5173/chat/
npm run build # the page for /chat/, under dist/
npm run preview # the built page, at http://localhost:4173/chat/
```

Developed against Node 26. The page needs `ds4-server` answering chat requests;
it is built against the OpenAI-compatible endpoint the server exposes at `/v1`.

## What the page does

The page follows the system's light or dark setting, and on a phone the chat list
becomes a drawer. The header names the model the server reported, taken from
`GET /v1/models`, with a dot for whether the server has answered. A server that is
down or still loading is asked again every few seconds, so the page can be opened
first; until it answers, the box stays closed and says why.

Questions go into the box at the bottom, which grows with the text: Enter sends and
Shift+Enter starts a new line. While an answer is arriving the Send button becomes
Stop, Escape does the same, and the box will not send a new question - the server
takes one conversation at a time, and the page has no queue to show. The Thinking
button asks the model to reason first or to answer straight away; the choice is
remembered and goes out as `chat_template_kwargs.enable_thinking`. Once a turn has
finished, the box also says how much of the model's context the conversation uses.

Each answer streams into place and is rendered as markdown with GFM tables, and a
line break from the model stays a line break. `react-markdown` builds React elements,
so nothing the model writes reaches the page as HTML; raw tags stay text, script
addresses are dropped, and images become links, because an answer should not be able
to make the reader's browser call an address it chose. Code blocks name their
language and have a copy button. The view follows the newest text until the reader
scrolls up, and a button then jumps back.

A turn with thinking gets a fold of its own above the answer, closed by default,
which reads "Thought for 14s" afterwards. Thinking belongs to the turn that produced
it: a later question does not inherit the previous turn's thinking, and the model
never sees it again. Before the first word the page says what it is waiting for and
counts the seconds, so a slow prefill does not look like a dead page.

A finished answer offers Copy and Retry, with its token count and speed beside them.
The speed runs from the first delta to the last, so prefill is not counted.

Stop ends the request and leaves the partial answer standing, marked as stopped. An
answer the server cut at its length limit says so. A failure appears in a banner with
the server's own wording and a way to try again, and the question that failed stays
in the transcript: the answer is missing, not the context. A server that ends an
answer with `finish_reason: error`, or a stream that closes with no ending at all, is
a failure too, not a short answer.

## Where chats are kept

Chats live in this browser's `localStorage`, the newest hundred of them, and the page
reopens the one it was showing. The list is the page's own; the inference API stays
stateless and never sees it.
A chat is saved when a question goes out and when its answer ends, not on every word,
so closing the tab mid-answer loses that answer but not the question. When storage is
full the oldest chats give way, and a browser that refuses storage still chats, with
nothing saved. Deleting a chat asks once, in place, and cannot be undone.

Each finished turn is also written to the decision graph, by way of `POST /chat/record`
on `ds4-server`: the conversation is a goal and each exchange a step under it, on the
`chat` branch of the repository's workspace. The token that writes there stays on the
server. The question and the answer are recorded, a stop or a failure included, and
thinking is not. The header says when a turn is in the graph and when one did not land;
the answer is unaffected either way, and a turn is sent once rather than retried. A turn
abandoned by switching to another chat is not recorded. `--chat-graph off` turns this
off, and [the decision graph docs](../docs/DECISION_GRAPH.md#the-chat-page) say what
is written.

The tailnet page is plain `http://`, which is not a secure context, so
`navigator.clipboard` and `crypto.randomUUID` do not exist there. Copying falls back
to a selection, and chat ids do not depend on `randomUUID`.

## Reaching the server

The page calls the relative path `/v1/chat/completions`, so a page served from
the same origin as the server needs no configuration at all - and sharing the
origin is how it is served. `ds4-server --ui-dir chat-web/dist` answers `/chat/`
from the build on the same port as the API, so no server address is baked into
the bundle and no cross-origin headers are needed. `./serve-tailnet.sh` builds
the page and passes the directory when the server comes up for the tailnet; see
[serving on the tailnet](../docs/TAILNET.md) and
[the chat page in the server docs](../docs/SERVER.md#chat-page).

The build is for that prefix: `base` in `vite.config.ts` is `/chat/`, which is
the prefix `ds4-server` serves the page under, and the built index asks for its
assets under the same prefix.

`npm run dev` follows the same-origin rule from the other side: the page comes
from Vite on port 5173 under `/chat/` and the server sits on port 8000, so the
development server proxies `/v1` across. `DS4_API_TARGET` moves the proxy when
the server is elsewhere or on another port; it is read by `vite.config.ts` and
never reaches the browser.

A page hosted somewhere other than the server itself - on another web server, or
reached through `npm run preview` while the server runs elsewhere - does need the
server's origin. Point `VITE_API_BASE` at it when building, as in
`VITE_API_BASE=http://127.0.0.1:8000 npm run build`. The origin is read once at
startup and every request goes to it after.

Requests carry `stream: true` and are read from the byte stream as they arrive.
The scanner works at byte level rather than line level because a data line can
split anywhere in the stream, and `ds4-server` sends the final `[DONE]` sentinel
without a closing newline. Stopping aborts the request; the code tells a stop
from a real failure by reading the abort signal, because in the test environment
the abort's own exception is not an `Error`.

## How it is laid out

```
src/chat/message.ts         one message: role, text, thinking, how it ended, its numbers
src/chat/conversation.ts    the transcript plus streaming and error, one reducer
src/chat/turnClock.ts       speed and thinking time for one turn
src/chat/format.ts          durations, turn numbers, context share as words
src/chat/library.ts         saved chats as data, and reading back what was stored
src/chat/storage.ts         the browser's storage behind a narrow door
src/api/sse.ts              byte scanner turning a stream into data payloads
src/api/chatClient.ts       the streaming request, deltas, stop and how it ended
src/api/models.ts           model id, name and context size from GET /v1/models
src/api/recordTurn.ts       a finished turn, handed to the server for the graph
src/env.ts                  the server origin, once
src/clipboard.ts            copying, with and without a secure context
src/hooks/useChat.ts        a turn: request, deltas, stop, retry, failure
src/hooks/useLibrary.ts     the saved chats as state
src/hooks/useStickToBottom.ts  following new text until the reader scrolls away
src/components/Transcript.tsx  the transcript as it stands
src/components/Markdown.tsx    an answer as markdown, code blocks included
src/components/CopyButton.tsx  copy, and saying so
src/components/Composer.tsx    the question box, Send, Stop and Thinking
src/components/Sidebar.tsx     the saved chats
src/components/Welcome.tsx     the empty page
src/components/icons.tsx       the page's icons
src/App.tsx                 the page
public/logo.svg             the logo, for the favicon and the page's mark
test/                       one test file per module, mirroring src/
```

The conversation reducer is pure and knows nothing about requests; the client is
a plain function over `fetch` with no React in it, and the hook is the thin place
where the two meet. A question that arrives while the answer to the previous one
is still being streamed is refused at the reducer, so the rule is checked at the
front door rather than in a component's props. The page holds a conversation and
the server stays stateless: every request carries the whole transcript, with
thinking left out of it. The saved list is the page's too; the reducer never sees it,
and `App` hands it a transcript to load.

## Tests

Layer one covers the data: message ids, wire conversion, the reducer, saved chats
including damaged ones, storage that refuses, the SSE scanner against chunk boundaries
that split a JSON payload mid-character, the client against a stubbed `fetch`, and the
origin from the build-time environment. Layer two mounts the components with fake
servers in their props: a composer that will not send while an answer is arriving,
markdown that cannot inject anything, a transcript that follows and lets go, and the
whole page asking, answering, reloading and retrying. `test/hygiene.test.ts` scans the
package for the broad `any`, platform access inside `src`, and modules without a test
facing them.

There is no `jest-dom` here: assertions are written against the DOM as it stands.
