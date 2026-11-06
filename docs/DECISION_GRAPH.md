# The Decision Graph

[README](../README.md)

A workspace remembers *why* work happened, not only what changed.
[deciduous](https://github.com/briandawg/deciduous) keeps that history as a
graph — goals, the options that were weighed, decisions, actions, outcomes — and
`ds4-agent` treats it as a core concept: the model is taught the graph in its own
system prompt, writes through one tool, and a resumed session recovers a
colleague's unfinished reasoning without anyone telling it the history twice.

## The server is the only writer

The graph lives in **PostgreSQL behind the shared deciduous server**. ds4 reaches
it over that server's MCP-over-HTTP API: `POST /mcp`, JSON-RPC, a Bearer token,
and the `Mcp-Session-Id` that `initialize` returns. There is no local graph file,
no SQLite database, no cache, no mirror, and ds4 never runs the `deciduous` CLI:

- One endpoint, one workspace per repository. Parallel sessions, other machines
  and the server's own web view read the same graph, which is the whole point of
  keeping reasoning notes in a database instead of in a directory.
- Arguments are validated server-side and ids are generated server-side, so ds4
  cannot write a node the schema rejects, and cannot leave a half-finished node
  behind after a retry.
- When the server is unreachable, ds4 says so and writes nothing. There is no
  fallback store to quietly fall through to, and nothing to reconcile later.

`ds4_deciduous.c` is the whole seam: the HTTP/JSON-RPC client, the seven
operations, the teaching and the briefing that go into the prompt, the recovery
note, the compaction digest, the closing note and the explicit `/done`.

### Where the endpoint comes from

| Source | What it sets |
| --- | --- |
| `~/.config/deciduous/server/.env` | `http://DECIDUOUS_BIND_ADDRESS:DECIDUOUS_PORT/mcp` (default `127.0.0.1:4000`) and `DECIDUOUS_MCP_TOKEN` |
| `.deciduous/config.toml` in the workspace or an ancestor | `[remote] url` and `[remote] workspace`, for a repository that lives on a different server |
| `DECIDUOUS_MCP_URL`, `DECIDUOUS_MCP_TOKEN`, `DECIDUOUS_WORKSPACE`, `DECIDUOUS_BRANCH` | override all of the above |
| `~/.config/deciduous/credentials` | the token, first line, when nothing else supplied one |

The workspace defaults to the repository directory name and the branch to
`git branch --show-current` (`main` when that fails); both ride on every request
as `workspace`/`branch` arguments plus an `X-Deciduous-Workspace` pin. The first
write creates the workspace server-side, so an empty workspace reads as "nothing
has been written to it yet" rather than an error ds4 invents. A bare URL gets the
`/mcp` path. `https://` is refused: ds4 has no TLS client, so point at a plain
`http://` endpoint — a local server, or a local proxy that speaks TLS onward.

## One tool, seven operations

The server's twenty-one tools — `add_node`, `add_edge`, `query_nodes`,
`get_descendants` and the rest — are not shown to the model. ds4 offers one tool,
`deciduous`, with an `op` argument, because a model left to place every edge
itself would spend its budget on bookkeeping:

| Call | Server tool |
| --- | --- |
| `op=goal prompt="make the seam real"` | `add_node`, `node_type=goal` — writes the request and holds it for this session |
| `op=decide title= chosen_option= rejected_option= rationale=` | `log_decision` — options, the choice and what it beat |
| `op=turn summary= observation= decision= action= outcome=` | `capture_conversation_turn` — one step, all or nothing |
| `op=note title= description= why=` | `add_node`, `node_type=observation`, attached under the goal |
| `op=graph question="which option was rejected"` | `ask_graph` — the server searches the graph and returns the nodes carrying the answer |
| `op=board subject= body= why= reply_to=` | `post_message`; with neither subject nor body, `read_messages` answers what is waiting for this session's label, and `all=1` reads everything recent |
| `op=status node_id= status=` | `update_node` — and naming a goal node claims it for this session |

A call missing the field its op cannot work without is refused before any request
goes out, and the refusal names the field. `--graph off` leaves the tool out of
the session entirely.

## When the graph gets written

The server's own instructions are fetched during the handshake. They name tools
the model does not have, so ds4 teaches the same moments in terms of its own ops:

- **The user asks for something.** The request becomes a goal, with their message
  verbatim in `prompt`. The harness does this one.
- **There is more than one way to do it.** `op=decide`, naming what it beat.
- **Code or config changed, and it worked or failed.** `op=turn` with an action and
  an outcome carrying the number or the error.

`op=note` goes in when a fact changes the plan, and an `op=decide` that says what it
replaces when an earlier choice turns out wrong. Reading, searching and planning are not recorded, so the graph
stays a record of commitments rather than a transcript.

ds4 never writes on its own. It reminds the model where work has gone unrecorded,
appended to the tool result: the fork-in-the-road moment at the first edit, and the
step when a command works after an edit. A command with no edit behind it is only
looking around, however cleanly it exited. The step reminder comes back once
something has been recorded and more work follows; the fork reminder comes back
every eight edits with nothing written. Recording a decision or a step resets the
count, so a session keeping its record hears nothing.

## The goal

A session holds one goal, and every write hangs under it:

```sh
./ds4-agent -m ds4flash.gguf --goal "make deciduous a core concept"
```

A turn that carries intent — "make the seam real, not just wired", not `hi` and
not `/new` — binds itself as the goal when `--goal` was not supplied. `/goal`
shows the bound goal, `/goal <text>` binds a new one, and a second `op=goal` in
the same session answers that the session already holds one instead of quietly
writing a second goal beside it. `/new` releases the goal, so new work does not
inherit yesterday's goal silently: nothing written after `/new` files under the old
goal, and the next request that carries intent becomes a goal of its own. A goal
bound on the opening turn is in the system message before the model answers. `/goal
<text>` while a goal is held posts the closing note for it first, as `/new` does.

That release is what makes a goal *shareable*. A goal is a node, not a session
secret: after `/new` the recovery note offers the released goal, and says to claim
the node rather than duplicate it — `op=status node_id=<id> status=active`. Any
session can claim a goal it finds with `op=goal` or `op=graph` the same way. The
claim is confirmed against the goal nodes the server lists, and only `status=active`
claims: closing a goal is not taking it on. A process that starts fresh does not
remember which goal it last held, so `op=goal` with no prompt lists the open ones.

## What the model is told

`ds4_dec_prompt_section()` opens the session: the seven operations, the three
write moments, this workspace and branch the writes land in, and the bound goal.
A resumed session gets `ds4_dec_recovery_note()` — who holds the goal, or which
goal is waiting to be claimed. `/new` teaches it again after rebuilding the
transcript.

Compaction summarises the conversation but does not summarise the graph:
`ds4_dec_compaction_digest()` adds the goal this session holds and the decisions the
branch remembers to the summary, because the graph already holds the reasoning in its
final form.

Once a goal is bound, ds4 also adds a briefing block to the system prompt — the
goal, the decision and observation titles filed under it, how many options were
weighed, up to three decisions from earlier work on the same subject found by asking
`ask_graph` the goal's title, and what the board has waiting for this session's
label. A new goal has nothing under it, which is when a model is likeliest to decide
again what earlier work settled. The model meets the graph before it writes to it, and the
briefing sends a fuzzy question to `op=graph` instead of to the model's memory:

```
What the graph already holds
Goal "make deciduous a core concept of the ds4 harness", held by this session.
Decisions: how ds4 reaches the graph
Ask op=graph before writing a decision: the graph may already hold it.
```

A session with no goal gets no briefing, and a briefing that cannot read the
graph says so instead of pretending the graph is empty.

`--label` names this session on the graph: it signs posted board messages and is
what `op=board` looks for in `@`-mentions.

## When the session ends

Leaving, `/new` or a new `/goal` posts one closing note to the board — but only when this
session actually recorded something. The note counts what it wrote, names the
decisions, and points at the workspace and branch that hold them:

```
make deciduous a core concept of the ds4 harness: 1 decision, 1 step, 1 note
```

A session that only read stays quiet; a session that wrote posts once, so
restarting does not stack up identical notes. The headline names the goal, because
"session over" tells the next person nothing. The server reads `@word` in a message
as an address, so the note drops the `@` from the titles it quotes.

`/done` is separate and always explicit: it marks the bound goal `completed` on
the server. ds4 never marks a goal done on its own — not when the last patch
applied, not when the model stopped asking — and it refuses to mark one when no
goal is bound or no server answers.

```sh
/done        # only ever by request
```

## The chat page

The chat page has no tools, so its model cannot write for itself the way an agent
does. `ds4-server` writes on the conversation's behalf instead, which is the one place
ds4 records something the model did not author: the operator asked for every
conversation to be tracked. It uses the same seam, `ds4_dec_record_chat_turn()`:

| On the page | In the graph |
| --- | --- |
| A conversation | A goal, its opening question verbatim in `prompt` |
| A finished exchange | A step under that goal: the question as the action, the answer as the outcome |
| A stop, a length cut-off, a failure | The same step, with the outcome saying so, and `success: false` for a failure |

The page posts each finished turn to `POST /chat/record` and the server writes two
calls: `add_node` for the goal and `capture_conversation_turn` for the step. The goal's
`change_id` is `chat-<id>` from the page's own chat id, so the same goal comes back on
every turn and the server keeps nothing between them. Thinking is not recorded, and an
answer past 32 KiB is cut.

Conversations go to this repository's workspace, on a `chat` branch. They are in the
same tree as the agent's work and `ask_graph` can reach them, but `op=goal` lists a few
goals per branch, and a day of chatting on `main` would push the agent's goals off it.
The label is `ds4-chat`.

The token stays on the server, because the page is served with no authentication. For
the same reason `/chat/record` refuses anything but `application/json`: a form on some
other website can post text at this port, but a JSON content type makes the browser ask
first, and the answer is no. Anyone who can reach the port can still write here, the
same way they can use the API, so Tailscale ACLs remain the access control. On a shared
tailnet that means **other people's chats are recorded too**. `--chat-graph off` stops
it; the page then says nothing about the graph.

This is only the write side. The chat model is not taught the graph and is not
briefed from it, so a conversation does not yet benefit from what the graph holds.
There is no closing note on the board either, because a browser tab has no reliable
end, and conversation goals stay `active`. Requests to `/v1` from anything else, LM
Studio included, are not recorded: they carry no conversation identity.

## Limits

- ds4 speaks the server's API and nothing else. `deciduous commands`, `deciduous
  add` and the rest of the CLI are a different client of the same server; ds4
  does not call them, and does not duplicate their argument shapes locally.
- Board messages arrive at conversation boundaries, not mid-generation.
- A restarted server forgets the session and answers `404`. ds4 shakes hands again
  and sends the call once more, which is safe because the refused call never ran.
  While the server is actually down, writes fail and say so.
- A reply that stops short of its declared length, closes before its JSON ends, or
  holds no result is a failure, never a quiet success.
- The reminders cover `edit`, `write` and successful `bash`. `read` is not a
  decision, and web search or MCP side effects are not recorded.
- A goal released by `/new` is left as it was written. `/done` marks the bound
  goal `completed`; ds4 never marks one on its own, and never closes one it did
  not open.
- `op=status` writes the vocabulary this server accepts — `pending`, `active`,
  `completed`, `rejected`, `superseded`, `abandoned`. `done` is what
  `deciduous status --help` on 1.1.0 prints, and the server refuses it, so ds4
  writes `completed` and passes the refusal through rather than inventing a
  status of its own.

## Where this is going

The graph is available to the model rather than required by the loop: a session
that never calls `deciduous` still runs. The briefing, the board at conversation
boundaries and the closing note have landed; what is left — claiming a goal across
machines, the graph answer riding along when the graph itself is quiet, and the
deciduous-side gaps ds4 has to work around (`commands` printing nothing, CLI help
offering statuses this server refuses) — is in
[DECISION_GRAPH_ROADMAP.md](DECISION_GRAPH_ROADMAP.md).
