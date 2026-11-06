# Making the graph load-bearing

> Status: in progress. Phase 1, the session-close half of Phase 2 and the first half
> of Phase 8 have landed (briefing, closing note, `/done`, re-handshake after a server
> restart). The rest is still the plan.

Today the decision graph is *available* to ds4 and it is already the only writer
of the reasoning record — [DECISION_GRAPH.md](DECISION_GRAPH.md). What it is not
yet is *required*. The loop runs exactly the same whether the model consults the
graph or never touches it, which means the record of a session depends on the
model remembering to write while it works. The phases below move deciduous from
"tool the model may use" to "the state the session is shaped by", without ever
letting ds4 keep a local copy of the graph.

## Ground rules every phase obeys

- The server stays the only writer and the only reader. No local file, cache or
  mirror; no shelling out to the `deciduous` CLI. A read that cannot happen is a
  gap the model is told about, not something to fake.
- A bounded number of server calls per session — start, each detected fork,
  compaction, close. The budget is a token and latency budget as much as a
  politeness one.
- Nothing gets recorded that the model did not author, except the boundary
  message describing the session, which is built from nodes the session already
  wrote, and the chat page's turns, because a chat model has no tools to write with.
- Every phase is verifiable without a model: a test in `ds4_agent_test` that
  writes and reads through the real server in workspace `ds4-selftest`, skipping
  itself when the server is down.
- Injected blocks stay small — roughly a paragraph each. The graph's value is
  that it is cheap to *summarise* into the prompt, not to dump.

## Phase 1 — the graph is read before the work starts *(landed)*

`ds4_dec_briefing()` asks the server, in one call, for the bound goal's children
and the decisions filed under it, and renders them as "already decided / still
open / what this goal's nodes say about the next step". The harness injects it at
session start beside the recovery note, and again in the compaction digest.

That gives the model the answer to "has this been decided before?" without ever
needing to think of `op=graph` — the same mechanism the recovery note proved
works, extended from the goal node to the reasoning under it.

**Touchpoints:** `ds4_dec_briefing()` in the seam; injection beside
`ds4_dec_recovery_note()` at worker start; reuse in `ds4_dec_compaction_digest()`;
a `--graph brief=off` escape if it turns out to cost too many tokens.

How it landed: three server calls, `get_descendants` under the goal (depth 4, sixty
nodes), `ask_graph` with the goal's title for decisions from earlier work, and one
`read_messages` for what is waiting on this session's label. It
goes into the system prompt appended to the teaching block — a goal-less session
gets no briefing, and a failed read says the reason instead of listing nothing.
It is built when a worker starts or resets, so `/goal` mid-session does not
refresh it until the next boundary; that refresh is still open. There is no
`brief=off` escape: `--graph off` removes the whole seam, and it turned out to be
cheap enough that a second switch would have been a way to configure slop.

## Phase 2 — the board is read at the start and written at the end *(partly landed)*

Read at session start: one `read_messages` call for this session's label, so the
first thing the model sees is what the other agents working on this repository
last wanted it to know. Write at session close: a boundary message built from
this session's own nodes — goal, what it decided, the last recorded turn, and
whatever the model supplied for next step and blocker — so the next session and
the next agent inherit the line of work rather than guessing it from the commit.

This is also the fix for the "goal already held" case: ds4 should read the board
before telling the model someone else has the goal, because that is precisely
what the board is for.

**Touchpoints:** the open/bind path; session close before `ds4_dec_close()`; the
held-goal refusal. Follows the `--graph on|off` gate — no graph means no board.

How it landed: the read rides inside the briefing (`read_messages` for what waits
on this session's label); the write is `ds4_dec_close_session()` at `/new` and at
teardown — the goal title, counts of decisions, steps and notes, the decision
titles, the last recorded turn and where the graph now holds it. It posts only for
a session that recorded something, and posts once. Still open: the held-goal
refusal does not read the board first, and the note carries no next step or
blocker the model could have supplied.

## Phase 3 — one goal per piece of work, not per launch

`--goal "X"` and auto-bind currently create a new goal node every launch, so
repeated sessions pile up near-duplicate goals. Look the goal up first
(`query_nodes`) and attach to the open one when the title matches; create only
when there is nothing to attach to. The observation then says "attached to the
goal the workspace already had" instead of "goal recorded", which is also the
honest signal that this session is continuing someone's line of work.

## Phase 4 — a session ends with a line about what happened

If this session bound a goal and wrote decisions or turns, but never recorded a
closing turn, ds4 asks once, at the point the model has stopped working: *what
happened, one line*. A goal that ends with the work's actual ending is worth one
extra exchange; the refusal to ask twice is what keeps it from nagging. Pure
state on the session's own counters, so it is trivially testable.

## Phase 5 — compaction digests derived from the graph

The digest already mentions the bound goal. It should carry the record itself:
this session's decision titles, the last turn's outcome, and what is still open,
all read from the server. Then losing the transcript is survivable in a stronger
sense — the summary stops being a story about the reasoning and becomes the
reasoning, indexed by node ids the model can `op=graph` back to.

## Phase 6 — sharper fork detection

Today a fork means "an edit happened", which catches most real forks by luck.
The signals that actually mean a choice was made: a build or test that fails, and
then a *different* approach succeeds; the user rejecting a direction; the same
file edited again right after a failure; a transcript that plainly names two
options. Where two options are named, ds4 can hand the reminder back with the
rejected option already drafted, so the decision node gets the alternative it is
supposed to record instead of one invented at write time.

Still one nudge per moment per session, still writes nothing.

## Phase 7 — hygiene as a command

`/graph` with no argument shows the endpoint, workspace, branch, bound goal and
goal count — the thing to check when a session seems to be writing into the wrong
place. `/graph review` runs the server's consolidation report, orphan search and
activity check and renders them as a report, so the graph stays a maintained
asset rather than quietly rotting. `/graph board` reads the board on demand. All
three are reads; none of them writes.

## Phase 8 — when the server goes away mid-session *(partly landed)*

There is no local fallback by design, so the answer is to come back rather than
to buffer: if no session is open, ds4 re-attempts the handshake at a safe point
and tells the model the graph is back before its next write. A session that
cannot reach the server keeps working, but the gap it leaves is named, and the
recovered session says what was not recorded while it was dark.

How it landed: a restarted server answers `404` for a session it has forgotten, so
`dec_rpc()` shakes hands again and sends the refused call once more. Still open:
telling the model what went unrecorded while the server was actually down.

## Decided

1. **Does ds4 ever mark a goal done?** Never automatically. `/done` is the
   operator's command, and it writes the status this server accepts
   (`completed`). A turn that simply ended is not evidence the work finished.
2. **Is the boundary message posted at every session close, or only when the
   session wrote something?** Only when it wrote something. A session that read,
   chatted and changed nothing posts nothing — nobody should have to scroll past
   "nothing happened" to find the session that did something.
3. **System prompt or context message for the briefing?** The system prompt,
   appended to the teaching block. It is one paragraph today; the context message
   is where it goes if it ever grows.

## Gaps on the deciduous side, not in ds4

Found while building against the live server. ds4 works around them instead of
inventing a vocabulary of its own:

- `deciduous commands` prints `No commands logged.` even in a workspace that has
  recorded activity.
- `deciduous add --help` and `deciduous status --help` offer `done` and `parked`,
  which `update_node` refuses. The writable set is `pending`, `active`,
  `completed`, `rejected`, `superseded`, `abandoned`.
- `query_nodes` accepts a `done` status filter that no node can satisfy, so
  searching for finished goals returns nothing while the help text says the word
  is valid.
- A workspace whose config names a `[remote]` project has no branches, and the
  server accepts the branch ds4 sends without saying so.

## Order of building

Phases 1 and 2 landed first, which was the point of the document: the graph gets
read before the work starts, and the session leaves a line behind when it did
something. The live graph then reordered the rest. `consolidation_report` finds eight
decisions written twice with the same title and no revisit between them, while no
goal in the `ds4` workspace is a duplicate, so 5 comes next: a digest scoped to the
goal should stop a compacted session re-recording what it already decided (that it
is the cause is an inference, not a proof). Then 4, because sessions still close with
decisions and no steps. 7 is nearly free now that `consolidation_report` exists. 6
stays late, as the riskiest because it shapes what gets recorded at all, and 3 moves
to last, with nothing in the graph asking for it.
