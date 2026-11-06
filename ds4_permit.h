#ifndef DS4_PERMIT_H
#define DS4_PERMIT_H

#include <stdbool.h>

/* Whether a tool call may run without asking. The model decides what to do, and this
 * decides what it may do unattended, so nothing here reads anything the model wrote
 * as a reason: a command either provably only reads, or a person sees it first.
 *
 * Three modes. ask stops at anything that can change the machine, edits lets file
 * edits through and still stops at bash, and all asks nothing, which is the only
 * mode a session with nobody at the keyboard can have.
 *
 * "Always" answers last the session and no longer. For bash the rule is the first
 * two words of the command, and it holds only for a command with no shell control in
 * it, so that allowing `npm test` does not allow `npm test; rm -rf ~`. A command that
 * has some is remembered exactly. Hooks are the place for rules that must hold every
 * session: see ds4_hooks.h. */

typedef enum {
    DS4_PERMIT_ASK,
    DS4_PERMIT_EDITS,
    DS4_PERMIT_ALL,
} ds4_permit_mode;

typedef struct ds4_permit ds4_permit;

ds4_permit *ds4_permit_new(ds4_permit_mode mode);
void ds4_permit_free(ds4_permit *p);

bool ds4_permit_parse_mode(const char *text, ds4_permit_mode *out);
const char *ds4_permit_mode_name(ds4_permit_mode mode);
ds4_permit_mode ds4_permit_mode_of(const ds4_permit *p);
void ds4_permit_set_mode(ds4_permit *p, ds4_permit_mode mode);

/* True when this command only reads, on the short list of commands known to, with
 * none of the options that make them write or run something else. */
bool ds4_permit_bash_reads_only(const char *command);

/* True when a person has to agree first. arg is the tool's main argument. */
bool ds4_permit_needs_asking(const ds4_permit *p, const char *tool, const char *arg);

/* What an "always" would allow, in words, to show before anyone agrees to it. The
 * text belongs to p and lasts until the next call. */
const char *ds4_permit_always_covers(ds4_permit *p, const char *tool, const char *arg);

void ds4_permit_allow_always(ds4_permit *p, const char *tool, const char *arg);

#endif /* DS4_PERMIT_H */
