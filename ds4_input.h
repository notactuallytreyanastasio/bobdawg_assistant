#ifndef DS4_INPUT_H
#define DS4_INPUT_H

#include <stdbool.h>
#include <stddef.h>

/* What a person types and what the repository says, before either reaches the model.
 *
 * Project instructions are the AGENT.md, AGENTS.md or CLAUDE.md files that apply here:
 * one from ~/.ds4, then one from each directory from the repository's root down to
 * this one. They go in as plain system text, and a file in a repository is as trusted
 * as the repository is, which is the same bargain as running its tests.
 *
 * @path in a prompt adds that file to the prompt. It is only taken for a mention: a
 * word that begins with @ and names a regular file, so an address or a decorator
 * stays what it is.
 *
 * A custom command is a markdown file, .ds4/commands/<name>.md at the repository's
 * root or in ~/.ds4/commands, and /<name> sends its text as the prompt. $ARGUMENTS is
 * replaced by what followed the command, and without one it goes on the end.
 *
 * !command runs under /bin/sh and its output goes to the model with the next prompt. */

#define DS4_INPUT_INSTRUCTION_BYTES (16u * 1024u)
#define DS4_INPUT_MENTION_BYTES (64u * 1024u)
#define DS4_INPUT_SHELL_BYTES (32u * 1024u)
#define DS4_INPUT_SHELL_SECONDS 120

/* The instructions for dir, or NULL when there are none. malloc'd. home may be NULL. */
char *ds4_input_instructions(const char *dir, const char *home);

/* The prompt with its mentions added, malloc'd, or NULL when it mentions nothing. */
char *ds4_input_expand_mentions(const char *prompt);

/* The prompt for "/name args", malloc'd, or NULL when no such command exists. The
 * built-in commands /init and /review can be replaced by a file of the same name. */
char *ds4_input_command_prompt(const char *line, const char *dir, const char *home);

/* One line per command that can be found, malloc'd, never NULL. */
char *ds4_input_command_list(const char *dir, const char *home);

/* Run command and return what it printed, with the exit status at the end. malloc'd,
 * never NULL. A command past DS4_INPUT_SHELL_SECONDS is killed. */
char *ds4_input_run_shell(const char *command);

/* A task list as the todo tool takes it: one task to a line, each starting "[ ] ", "[>] "
 * or "[x] ", for waiting, under way and done. False for anything else, or past
 * DS4_INPUT_TODO_LINES tasks. */
#define DS4_INPUT_TODO_LINES 64
bool ds4_input_todo_counts(const char *items, int *done, int *total);

#endif /* DS4_INPUT_H */
