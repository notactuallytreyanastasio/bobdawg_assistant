#ifndef DS4_HOOKS_H
#define DS4_HOOKS_H

#include <stdbool.h>
#include <stddef.h>

/* Commands the repository wants run at fixed points in an agent session, so a rule
 * can be kept by the harness instead of by the model remembering it.  They live in
 * .ds4/hooks at the repository root, one per line:
 *
 *     <event> <tool> <pattern> <command...>
 *
 * event is session_start, pre_tool, post_tool or session_end.  tool is a tool name
 * or *.  pattern is an fnmatch glob over the tool's main argument: a bash command, a
 * path, the op of a deciduous call.  Fields split on spaces, so ? stands for one in a
 * pattern.  The command runs under /bin/sh at the repository
 * root with DS4_HOOK_EVENT, DS4_HOOK_TOOL, DS4_HOOK_ARG and, after a tool,
 * DS4_HOOK_RESULT and DS4_HOOK_EXIT in its environment.
 *
 * Exit 0 lets the tool go ahead, and what it printed is shown to the model.  Exit 2
 * from a pre_tool hook refuses the tool, and what it printed is the reason.  Anything
 * else, a timeout included, is a broken hook: the model is told, and the tool goes
 * ahead, because a hook that fails open is a bug to fix and one that fails closed
 * stops all work.  The file is read once when a session starts, so an edit made during
 * a session cannot lift a rule on that session. */

typedef enum {
    DS4_HOOK_SESSION_START,
    DS4_HOOK_PRE_TOOL,
    DS4_HOOK_POST_TOOL,
    DS4_HOOK_SESSION_END,
} ds4_hook_event;

typedef struct ds4_hooks ds4_hooks;

typedef struct {
    bool blocked;
    char *output; /* malloc'd, never NULL; what the hooks said */
} ds4_hook_result;

/* Hooks for this root.  NULL with err empty when it has none; NULL with err set when
 * the file does not parse, because a rule that silently stopped applying is worse than
 * being told. */
ds4_hooks *ds4_hooks_load(const char *root, char *err, size_t err_len);
void ds4_hooks_free(ds4_hooks *h);
int ds4_hooks_count(const ds4_hooks *h);

/* Run the hooks matching this moment, in file order, stopping at the first refusal.
 * h may be NULL.  result_text and exit_status apply after a tool; pass NULL and -1. */
ds4_hook_result ds4_hooks_run(const ds4_hooks *h, ds4_hook_event event, const char *tool,
                              const char *arg, const char *result_text, int exit_status);

#endif /* DS4_HOOKS_H */
