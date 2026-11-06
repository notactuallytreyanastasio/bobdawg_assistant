# Chat

A browser page for chatting with [ds4-server](../docs/SERVER.md): ask a question,
watch the answer arrive word by word, and see the model's thinking folded away
beside it. React on TypeScript, tested with Vitest and Testing Library, built by
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

The header names the model the server reported, taken from `GET /v1/models`.
Questions go into the box at the bottom: Enter sends, Shift+Enter starts a new
line. While an answer is arriving the Send button becomes Stop, and the box is
closed to a new question - the server takes one conversation at a time, and the
page has no queue to show.

The transcript grows below. Each answer streams into place as it arrives, and a
turn with thinking gets a "Thinking" fold of its own above the answer, closed by
default. Thinking belongs to the turn that produced it: a later question does not
inherit the previous turn's thinking, and the model never sees it again. A
long-running turn says what it is doing - waiting for the model to begin, then
answering - so it is visible that the page is working and not stuck.

Stop ends the request and leaves the partial answer standing, marked as stopped
after the words that arrived. New chat clears the transcript for a fresh
question. A failure appears in a banner with the server's own wording, and the
question that failed stays in the transcript: the answer is missing, not the
context.

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
src/chat/message.ts         one message: role, text, thinking
src/chat/conversation.ts    the transcript plus streaming and error, one reducer
src/api/sse.ts              byte scanner turning a stream into data payloads
src/api/chatClient.ts       the streaming request, deltas and stop
src/api/models.ts           model id from GET /v1/models
src/env.ts                  the server origin, once
src/hooks/useChat.ts        a turn: request, deltas, stop, failure
src/components/Transcript.tsx  the transcript as it stands
src/components/Composer.tsx   the question box, Send and Stop
src/App.tsx                 the page
test/                       one test file per module, mirroring src/
```

The conversation reducer is pure and knows nothing about requests; the client is
a plain function over `fetch` with no React in it, and the hook is the thin place
where the two meet. A question that arrives while the answer to the previous one
is still being streamed is refused at the reducer, so the rule is checked at the
front door rather than in a component's props. The page holds a conversation and
the server stays stateless: every request carries the whole transcript, with
thinking left out of it.

## Tests

Layer one covers the data: message ids, wire conversion, the reducer, the SSE
scanner against chunk boundaries that split a JSON payload mid-character, the
client against a stubbed `fetch`, and the origin from the build-time environment.
Layer two mounts the components with fake servers in their props: a composer that
will not send while an answer is arriving, a transcript that folds thinking away,
and the whole page asking and answering. `test/hygiene.test.ts` scans the package
for the broad `any`, platform access inside `src`, and modules without a test
facing them.

There is no `jest-dom` here: assertions are written against the DOM as it stands.
