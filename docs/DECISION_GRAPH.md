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

The server's own instructions — fetched during the handshake and injected
verbatim — say there are three moments, and nowhere else:

- **The user asks for something.** The request becomes a goal, with their message
  verbatim in `prompt`.
- **There is more than one way to do it.** Options; then a decision whose title
  names what it beat.
- **Code or config changed, and it worked or failed.** An action and an outcome
  with the number or the error, or a turn that captures the step at once.

Observations go in when a fact changes the plan; a revisit when an earlier choice
turns out wrong. Reading, searching and planning are not recorded, so the graph
stays a record of commitments rather than a transcript.

ds4 never writes on its own. After a settled edit it reminds the model of the
fork-in-the-road moment, and after a command that worked it reminds it of the
step — once per session each, appended to the tool result. A reminder that is
ignored is not repeated, because a harness that nags writes noise instead of
decisions.

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
inherit yesterday's goal silently.

That release is what makes a goal *shareable*. A goal is a node, not a session
secret: a fresh session in the same workspace finds the request already written,
and the recovery note tells it to claim the node rather than duplicate it —
`op=status node_id=<id> status=active`. The claim is confirmed against the goal
nodes the server lists, so `op=status` on some other kind of node stays a plain
status change.

## What the model is told

`ds4_dec_prompt_section()` opens the session: the seven operations, the three
write moments, this workspace and branch the writes land in, and the bound goal.
A resumed session gets `ds4_dec_recovery_note()` — who holds the goal, or which
goal is waiting to be claimed. `/new` teaches it again after rebuilding the
transcript.

Compaction summarises the conversation but does not summarise the graph:
`ds4_dec_compaction_digest()` replaces the summary with the goal this session
holds and the decisions the branch remembers, because the graph already holds the
reasoning in its final form.

Once a goal is bound, ds4 also adds a briefing block to the system prompt — the
goal, the decision and observation titles filed under it, how many rejected
alternatives the server holds against it, and what the board has waiting for this
session's label. The model meets the graph before it writes to it, and the
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

Leaving, or `/new`, posts one closing note to the board — but only when this
session actually recorded something. The note counts what it wrote, names the
decisions, and points at the workspace and branch that hold them:

```
make deciduous a core concept of the ds4 harness: 1 decision, 1 step, 1 note
```

A session that only read stays quiet; a session that wrote posts once, so
restarting does not stack up identical notes. The headline names the goal, because
"session over" tells the next person nothing.

`/done` is separate and always explicit: it marks the bound goal `completed` on
the server. ds4 never marks a goal done on its own — not when the last patch
applied, not when the model stopped asking — and it refuses to mark one when no
goal is bound or no server answers.

```sh
/done        # only ever by request
```

## Limits

- ds4 speaks the server's API and nothing else. `deciduous commands`, `deciduous
  add` and the rest of the CLI are a different client of the same server; ds4
  does not call them, and does not duplicate their argument shapes locally.
- Board messages arrive at conversation boundaries, not mid-generation.
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
