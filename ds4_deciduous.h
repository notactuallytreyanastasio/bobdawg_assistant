#ifndef DS4_DECIDUOUS_H
#define DS4_DECIDUOUS_H

#include <stdbool.h>
#include <stddef.h>

/* ds4-agent is a reasoning loop; deciduous is the memory of that reasoning.
 * Goals, options, decisions, actions and outcomes live outside the context
 * window, so compaction cannot erase them and a new session can pick the line
 * of work back up.
 *
 * This module is the whole seam, and it holds no graph of its own: every read
 * and write goes to the shared deciduous server over its MCP-over-HTTP API,
 * which is Postgres behind an Elixir endpoint.  There is no local graph file,
 * no cache and no mirror: one endpoint, one workspace per repository, so
 * parallel sessions and other machines see the same graph.  Nothing here
 * shells out to the deciduous CLI, and nothing here opens SQLite.
 *
 * The server's twenty-one tools are not shown to the model.  ds4 offers seven
 * operations over them - decide, turn, note, graph, board, goal and status -
 * because a model left to place every edge itself would spend its budget on
 * bookkeeping instead of on the work. */

/* Goal titles are kept short; the full request travels in the goal's prompt. */
#define DS4_DEC_GOAL_TITLE_MAX 100

typedef struct ds4_dec ds4_dec;

/* One resolved argument of a graph tool call, handed over from the agent's
 * tool-call parser.  Both pointers stay valid for the call only. */
typedef struct {
    const char *name;
    const char *value;
} ds4_dec_arg;

typedef struct {
    const char *tool;  /* decide | turn | note | graph | board | goal | status */
    const ds4_dec_arg *args;
    int argc;
} ds4_dec_call;

/* Nearest ancestor holding .deciduous/config.toml or .git; NULL or a miss
 * falls back to the directory itself. */
bool ds4_dec_find_root(const char *start, char *out, size_t cap);

/* Resolve the server (URL, token, workspace, branch) from the machine and
 * repository configuration, open an MCP session against it and fetch the
 * server's own agent-facing instructions.  NULL when no server is configured
 * or the endpoint will not complete the handshake, and ds4_dec_open_error()
 * then says why: there is no local fallback to fall through to.  label is the
 * name this session's board messages are signed with, and what op=read looks
 * for in @-mentions. */
ds4_dec *ds4_dec_open(const char *root, const char *label);
void ds4_dec_close(ds4_dec *d);
bool ds4_dec_active(const ds4_dec *d);

/* Why the last ds4_dec_open() failed; "" when it has not failed. */
const char *ds4_dec_open_error(void);

/* Teaching for the system prompt, with the workspace, branch and bound goal
 * this session writes into.  Caller does not free. */
const char *ds4_dec_prompt_section(const ds4_dec *d);

/* The server's own instructions, verbatim, for the test suite and for anyone
 * checking that ds4's teaching agrees with the server's rules.  NULL when no
 * session is open. */
const char *ds4_dec_rules(const ds4_dec *d);

/* Session-start context: endpoint, workspace, bound goal and how to read the
 * graph after a crash.  Caller does not free; NULL when inactive. */
const char *ds4_dec_recovery_note(const ds4_dec *d);

/* What the graph already holds about the bound goal: its decisions, notes and
 * rejected alternatives, plus the board messages waiting on this session's
 * label.  The harness injects it beside the recovery note, so the model sees
 * the record instead of re-litigating a decision that was already written
 * down.  NULL when no goal is bound; caller frees. */
char *ds4_dec_briefing(ds4_dec *d);

/* Bind the session to a goal: the goal node is created on the server under a
 * change_id, so a retried bind returns the node the first attempt made instead
 * of a second goal.  Pass no prompt to read instead: which goal this session
 * holds, and which goals the workspace still has open.  Returns a malloc'd
 * observation. */
char *ds4_dec_bind_goal(ds4_dec *d, const char *prompt);

/* Whether a goal is already bound; lets the harness auto-bind the opening
 * user request as the goal when --goal was not supplied. */
bool ds4_dec_goal_bound(const ds4_dec *d);

/* Server id of the bound goal, NULL when none; the id every write is filed
 * under.  Valid until the next bind. */
const char *ds4_dec_goal_id(const ds4_dec *d);

/* Release the binding for a fresh session (/new): the next goal-worthy request
 * starts a new line of work.  The goal node itself is left as the server has
 * it, because a session that ended is not proof that the work finished. */
void ds4_dec_release_goal(ds4_dec *d);

/* The session's news for the other agents sharing this workspace, posted to the
 * board at the point the session ends or starts over at /new.  Posted only when
 * this session recorded reasoning: a message saying nothing happened is noise
 * the others would have to read past.  Built from the nodes the session wrote,
 * not from the transcript, so compaction cannot change what it says.  NULL when
 * there is nothing to tell; caller frees. */
char *ds4_dec_close_session(ds4_dec *d);

/* Mark the bound goal completed on the server.  Reaches the server only on the
 * operator's `/done`: a session ending is not evidence the work finished.  The
 * server's word for a finished goal is `completed`; `done` is what the CLI help
 * prints and this server rejects.  Returns a malloc'd observation. */
char *ds4_dec_mark_goal_done(ds4_dec *d);

/* Execute one graph tool call; returns a malloc'd observation.  err receives
 * the reason a write did not happen, which the harness shows rather than
 * hiding, because a missing record is a real loss. */
char *ds4_dec_execute(ds4_dec *d, const ds4_dec_call *call, char *err, size_t err_len);

/* Harness nudge.  Called with every tool result: `tool` is the executed tool,
 * `arg` its path or command argument, `observation` the text returned to the
 * model, `exit_status` the command's status (-1 when it is not a status).
 * Nothing is recorded here: the server's rules say plainly that reading,
 * searching and planning must not be logged, so this only ever returns a
 * reminder at the moments a write belongs - once per session each. */
char *ds4_dec_note_result(ds4_dec *d, const char *tool, const char *arg,
                          const char *observation, int exit_status);

/* Authoritative graph state for context compaction: the reasoning survives
 * compaction exactly because it lives outside the context window, so it is
 * re-read from the server rather than summarised from the transcript. */
char *ds4_dec_compaction_digest(ds4_dec *d);

#endif /* DS4_DECIDUOUS_H */
