#ifndef DS4_UNDO_H
#define DS4_UNDO_H

#include <stddef.h>

/* What the edit and write tools are about to change, kept so a person can take a turn
 * back. A file is copied the first time a turn touches it, so undoing a turn gives
 * back what was there when the turn began, however many edits it made.
 *
 * This covers the file tools and nothing else. A bash command can change anything,
 * and only git can answer for that, so /undo says it does not cover them.
 *
 * Copies live in memory, for this session. The oldest turns give way past
 * DS4_UNDO_MAX_BYTES, and a file over DS4_UNDO_MAX_FILE is named but not kept, so
 * undo can say which file it could not restore instead of quietly leaving it. */

#define DS4_UNDO_MAX_FILE (8u * 1024u * 1024u)
#define DS4_UNDO_MAX_BYTES (256u * 1024u * 1024u)

typedef struct ds4_undo ds4_undo;

ds4_undo *ds4_undo_new(void);
void ds4_undo_free(ds4_undo *u);

void ds4_undo_begin_turn(ds4_undo *u);

/* Call before a tool changes path. */
void ds4_undo_note(ds4_undo *u, const char *path);

/* Turns with something to undo. */
int ds4_undo_depth(const ds4_undo *u);

/* Restore the newest such turn and forget it. Returns one line per file, malloc'd, or
 * NULL when there is nothing to undo. */
char *ds4_undo_last(ds4_undo *u);

#endif /* DS4_UNDO_H */
