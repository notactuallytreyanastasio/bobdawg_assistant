# Chat

A browser page for chatting with [ds4-server](../docs/SERVER.md): ask a question,
watch the answer arrive word by word as formatted markdown, and see the model's
thinking folded away beside it. With Plot on, paste messy data and the model writes D3
code for a chart, which runs in a sandbox beside the chat once you press Run. Chats are
kept in the browser. React on TypeScript, tested with Vitest and Testing Library, built by
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
which reads "Thought for 14s" afterwards. In a chart turn only the last round gets a
time, and the folds of the rounds before it just say "Thinking". Thinking belongs to the turn that produced
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

## Charts

The Plot button beside Thinking turns a question into a tool turn; the choice is
remembered and starts off. The model gets a prompt naming exactly what its code can
reach (`d3`, `DATA`, `MESSAGES`, `root`, `width`, `height`, `console.log`) and one tool,
`plot`, whose one argument is the code. When it calls the tool a card appears in the
transcript with Run and Code, and nothing has run yet: Code shows what was written, and
Stop is how the reader declines. Timers start at Run.

Generated code is often wrong, so the page tells the model what went wrong and lets it
try again. Runtime errors, with the line and source they came from, a drawing with nothing
in it, a run that drew no `svg`, axes with no data marks, `NaN` in an attribute, a hang and a
timeout all go back as the tool's answer, and the model sends the whole corrected code. One
Run covers the repairs of that turn, up to five rounds in all, and the next turn asks again.
Every call spends a round, whatever it draws, so each answer starts with the page's own count,
and the fourth warns that the next call is the last. The frame is checked out of sight and
the same frame is revealed on success, so a failed attempt never pops up; it folds away in the
transcript, like thinking. A call cut off by the length limit never runs.

A repair can end with no chart. A turn whose last attempt failed at the cap, or whose model
goes quiet after a failed attempt, says "Gave up". The result of the fifth round never reaches
the model, so a turn whose fifth attempt ran clean says "Out of rounds" and shows that chart
with nothing said about it. Neither is recorded as a success.

"Ran without errors" means that and no more: a chart with that label can be wrong, and it can
be close to empty. The checks are a floor. A data mark is a shape with some size outside D3's
axes, or a word past the first two, so hand-drawn axes, a background rectangle or a legend all
pass as marks, and fewer than three only earns the model a note to look again. Nothing compares
the chart with your data. The model is asked to log a row count and compare it with the source,
and the panel says to check the numbers.

A check is never judged in a hidden tab. Chrome gives a frame there no layout, so a good chart
measures as an empty one. No frame is made while the tab is hidden, a check the tab hid in the
middle of is taken down, and either way the check starts when the tab comes back, so the same
code can run twice under one Run. Until then the turn waits, the model hears nothing, no round
is spent, and Stop still ends it. A turn left in a hidden tab does not finish by itself.

Only text sent with Plot on goes into the chart as `DATA`, up to 1,000,000 characters:
the oldest whole messages give way first, the newest is cut if it alone is too long, and
the model is told. A long paste is clipped on the way to the model, to about 6,000 characters
from its start and its end, with the number of lines. That clip applies to turns with Plot on:
a later turn with Plot off sends the paste whole.

So a long paste can lose rows the model never saw. If the format changes in the hidden middle,
its parser may skip those rows and the chart still looks complete. Every answer to a call gives
the line count of `DATA`, the model is asked to log its row count and the lines it could not
parse, and it can repair the parser, but nothing makes it. Compare the chart with your data.

A chart is told to draw at no less than 640 by 416, whatever the panel's width, and its viewBox
scales it down to fit. Text on a phone is small for that reason: below that size the margins the
model writes cross over and the chart comes out upside down, which is worse. An svg drawn with
a width and height and no viewBox is given one when the page has loaded, so it shrinks too.

The answer to an ok call tells the model to stop and describe the chart unless a value is wrong
or rows are missing. That is a request too, and a model can still spend rounds on polish.

The prompt asks the model to type short or prose input, up to about 2,000 characters, into its
code as a literal array, and to parse `DATA` when it is long or regular, because regular
expressions over prose lost values and took longer. That is a request. The model can do either,
so `DATA` is not always where a chart's numbers came from, and a mistyped value is possible.

Data sent with Plot off, followed by "plot that" with Plot on, is not in `DATA`. The Run card
says how many earlier messages were left out, and that the model can still copy what it read
into its code, which is what it is told to do then. The answer to the call repeats that when
`DATA` is under 200 characters.

The panel has a Preview and a Code tab, Copy, Previous and Next through the attempts, a full
view, its own Stop, and Close. There is one live frame per page. Closing the panel,
stepping to another attempt, switching chats or hiding the tab after a check removes it,
and a tap on the Run placeholder brings a chart back. Opening a saved chat never runs
anything. A finished turn goes to the decision graph with the model's words, or `Drew:` and
the chart's title if it said nothing. The code is not recorded. A turn that gave up or ran out
of rounds is recorded as failed, because the server has no other word for it, and one that
ran out of rounds says so in the answer.

### What the sandbox holds, and what it does not

Model output is untrusted code, and pasted data can carry a prompt injection, so the design
assumes the code is hostile. It runs in an `<iframe sandbox="allow-scripts">` built by
hand with `srcdoc`, which gives it an opaque origin, under a policy allowing no network.
The page itself carries the one directive `frame-src 'none'`, which is what stops a frame
navigating itself to an address holding your data; a policy inside the frame cannot do that.
A srcdoc frame inherits the parent's policy, so that directive must stay alone: a `script-src`
added to the page would break every chart. There is no `blob:` or `data:` delivery and no
new tab, because either would hand the code the page's origin or lose the sandbox.

In Chrome 157 on macOS, 219 escape attempts went through the final build, by way of the real
document builder, host and Run click, with listeners on the API, `/chat/record` and an
attacker's server. None of them reached a listener over HTTP, read the page's chats or
storage, moved the page, opened a window, raised a dialog, started a download, or took
keystrokes typed into the question box. The nine that need a real click were run again alone,
because a concurrent run does not deliver them, and were clean too. The clipboard API is absent
there, and the lockdown removes `execCommand`. So the code is kept away from chats, storage, the
API and `/chat/record`, and every HTTP escape tested was blocked. That is a list of what was
tried, not a proof. For comparison, the same code with the sandbox, the policies and the
lockdown taken away set off a detector in 81 of 208 runs of that final pass, and in 151 of 207
in an earlier pass that also read Chrome's DNS log. Most of the quiet ones have no network
detector to set off, so they show nothing either way, and 11 attempts over UDP or bare TCP had no
such run. In the earlier pass six navigating attempts caused a DNS lookup; in both passes one
opened a TCP connection before being stopped, which is the first item below.

Attacks that do not go through the frame were tested on the same build with a stub model:
hostile HTML in saved chats, titles, code and markdown rendered inert, forged and malformed
saved chats were dropped, a tool call with Plot off never ran, and broken, oversized or misnamed
tool calls ended cleanly with every call answered. Only the first call in a reply runs, so a
reply full of calls costs one round. These checks live outside this package and were all
written by the people who built it: nobody independent has attacked this. Two attempts at an
independent attack were stopped before they ran anything.

What this does not stop:

- **Data embedded in a chart can still leak through DNS and TCP, about 28 KB per run by a
  rough estimate, and the page cannot prevent it.** The browser resolves names for its own
  speculative work, and that happens outside any policy a page can set. Turning off Chrome's
  Preload pages setting (`network_prediction_options: 2`) silenced all nine channels tested,
  and that is a choice each browser makes for itself. This is why the Run card says what it
  says.
- Only text sent with Plot on is embedded, but the model sees the whole chat, and can retype
  earlier text into its code. When the data is only there it is told to, and the Run card says
  so. Code shows what it copied.
- A chart can draw fake UI, including a fake prompt, inside the panel. The panel's notice is
  always on screen for that reason. The label reads "Ran without errors" and never "safe":
  everything the frame reports is a claim by the code it is reporting on.
- Error text returning to the model is a prompt injection path, and so is the quoted source
  line. Both sit below a line saying they are data, which helps and is not a guarantee.
- A blocked navigation ends the turn with a banner and no repair, because the lockdown takes
  links away and a navigation is almost certainly hostile. The address is never shown, logged, stored or sent to the model, because it
  can hold the data, but by then the name may already have been looked up.
- Links in answers can carry data if clicked. Images are already turned into links.
- Pasted data reaches the decision graph, because it is the question.
- `location.ancestorOrigins` still tells a frame which origin embeds it. `document.referrer` is
  blank.
- A frame that burns CPU between heartbeats fools the watchdog, which is why the panel has a
  Stop of its own.
- This has been tested on Chrome desktop only. Safari, Firefox and phones are untested. Freeze
  protection depends on Chrome's process isolation; if a frame does freeze the page, reloading
  recovers it, because nothing runs by itself.
- The lockdown script is hardening, not a boundary. The sandbox and the policies are the
  boundary. Its pattern for HTML-parsing method names should be rechecked when Chrome updates,
  because Chrome keeps adding them.

## Workspace

With **Workspace** on, the model is a coding agent: it has a shell and file tools in a directory
of its own, and each step shows in the transcript as it happens, folded open to what it ran and
what came back. The directory belongs to this browser and lasts between chats. No Run is asked
for, because nothing here runs in the page or on the server's own machine.

Each tool call is one container from `sandbox/`, with no network, a read-only root, no
capabilities, an ordinary user, and limits on memory, CPU and processes. The workspace is a named
volume in Docker's VM, so no directory of the host is mounted, and the file tools run inside as
well, so a symlink has nothing on the host to lead to. Build the image once with
`docker build -t ds4-sandbox sandbox`. `ds4_workspace.h` has the reasoning.

What holds it apart from another person's workspace is a random id kept in this browser, so
clearing the browser's storage loses the way back to it. Nothing limits disk but the VM's own
size, and this has been tested by us and not independently.

## Pages and links

Asked for a page, a report or a dashboard, the model calls the `page` tool instead of
`plot`, with a title, the markup and code to go with it. It comes down to code like any
other, whose first line puts the markup in `root`, so a page runs in the same frame, under
the same Run and the same lockdown, and the guard on `innerHTML` reads every tag. A page is
held to having run and drawn something, not to having drawn a chart.

Anything that ran can be shared. **Share as a page** says what that means and takes a second
press: the document goes to the server whole, D3 and the Plot-on text included, and comes back
as a link that opens without the chat. The server has to be started with `--share-dir`, which
`serve-tailnet.sh` does. A link lasts until its file is deleted from that directory, and anyone
who can reach the server and has the link can open it.

The server trusts no upload. It serves a shell with no script in it and the page in a sandboxed
`srcdoc` frame, under a policy of its own, kept in step with `FRAME_POLICY` by a test. See
`ds4_share.h` and `docs/SERVER.md`.

Tested in Chrome desktop against the real server, by us and not independently: 208 escapes,
each uploaded both as the chat sends it and bare, with no policy and no lockdown. Of the 193
that need no click, 61 reached the listener with nothing around them. Nothing tagged reached it
from a shared page. WebRTC and TCP were run on their own: a page from the chat sent nothing by
WebRTC, a blocked navigation still opened a TCP connection as it does in the chat, and a bare
upload did reach out by WebRTC and TCP, so such a page can send what it holds. DNS was not
measured on shared pages, and it is expected to leak as it does in the chat.

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

Saved chats keep tool calls and results too, with the arguments as the model wrote them,
because the server replays them byte for byte. Calls that are damaged or over 256 KB are
dropped on reading and the chat stays. A call without its result, which a stop or a closed
tab can leave behind, is simply not sent.

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
src/chat/message.ts         one message: role, text, thinking, calls, how it ended, its numbers
src/chat/conversation.ts    the transcript plus streaming and error, one reducer
src/chat/turnClock.ts       speed and thinking time for one turn
src/chat/format.ts          durations, turn numbers, context share as words
src/chat/library.ts         saved chats as data, and reading back what was stored
src/chat/storage.ts         the browser's storage behind a narrow door
src/chat/artifact.ts        the charts in a transcript, and which texts each may see
src/api/sse.ts              byte scanner turning a stream into data payloads
src/api/chatClient.ts       the streaming request, deltas, stop and how it ended
src/api/toolCalls.ts        tool calls gathered from their fragments
src/api/models.ts           model id, name and context size from GET /v1/models
src/api/recordTurn.ts       a finished turn, handed to the server for the graph
src/tools/tool.ts           what a tool is, and running one without breaking the turn
src/tools/plot.ts           the plot tool, and a run told to the model
src/tools/assistant.ts      the plot assistant: the prompt and its tool
src/artifact/limits.ts      every number the sandbox lives by
src/artifact/document.ts    the document a chart runs in, in order
src/artifact/protocol.ts    what a frame may say, validated and clamped
src/artifact/supervisor.ts  the rules a running frame lives by, as a pure step
src/artifact/host.ts        the only code that makes a frame
src/artifact/d3Source.ts    D3 as text, from the build
src/artifact/frame/         the lockdown and harness scripts that run inside a frame
src/env.ts                  the server origin, once
src/clipboard.ts            copying, with and without a secure context
src/hooks/useChat.ts        a turn: request, tool rounds, stop, retry, failure
src/hooks/useArtifacts.ts   when model code may run: the Run grant and the frame's state
src/hooks/useLibrary.ts     the saved chats as state
src/hooks/useStickToBottom.ts  following new text until the reader scrolls away
src/components/Transcript.tsx  the transcript as it stands
src/components/Markdown.tsx    an answer as markdown, code blocks included
src/components/CopyButton.tsx  copy, and saying so
src/components/Composer.tsx    the question box, Send, Stop, Thinking and Plot
src/components/ArtifactPanel.tsx  the chart beside the chat
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

The frame is the one thing React does not own. `host.ts` builds it by hand, so `sandbox` is
set before it enters the page, and `ArtifactPanel` stays mounted with an empty slot for it,
because a frame that moves in the tree reloads and runs its code again. Checking, showing
and full view are CSS classes on that one element. D3 is a dependency whose text ships in
the build as its own chunk and is inlined into each frame, because a frame has no network.

## Tests

Layer one covers the data: message ids, wire conversion, the reducer, saved chats
including damaged ones, storage that refuses, the SSE scanner against chunk boundaries
that split a JSON payload mid-character, the client against a stubbed `fetch`, and the
origin from the build-time environment. Layer two mounts the components with fake
servers in their props: a composer that will not send while an answer is arriving,
markdown that cannot inject anything, a transcript that follows and lets go, and the
whole page asking, answering, reloading and retrying. `test/hygiene.test.ts` scans the
package for the broad `any`, platform access inside `src`, modules without a test facing
them, anything in `src` that could hand a frame the page's origin, and the exact parent
policy in `index.html`.

The tool loop is tested with a scripted fake server and a fake tool: repair, the round cap,
stop at each stage, a reset in the middle of a tool, and replay on a later turn. The document,
protocol, supervisor and host are tested with injected time and hostile input, and `sandbox`
is checked before the frame enters the page. jsdom runs none of the frame's code, though, so
these tests cannot show that the sandbox holds. That was shown separately in real Chrome,
as described under [Charts](#charts), and those runs are not part of `npm test`. Neither are
the runs of the built page behind a stub model, in headless Chrome, that showed a repair and a
check in a hidden tab holding and passing on return, and the mark count telling bars, a word
cloud, empty axes, an empty line and a debug run apart. A hidden tab has not been tried in a
windowed Chrome or on a phone. Repair has also been seen against the real model.

There is no `jest-dom` here: assertions are written against the DOM as it stands.
