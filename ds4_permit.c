#include "ds4_permit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RULES_MAX 64
#define RULE_BYTES 512

struct ds4_permit {
    ds4_permit_mode mode;
    bool edits_allowed;
    int rule_count;
    /* A rule ending in a space is a prefix; any other is the whole command. */
    char rules[RULES_MAX][RULE_BYTES];
    char said[RULE_BYTES + 32];
};

ds4_permit *ds4_permit_new(ds4_permit_mode mode) {
    ds4_permit *p = calloc(1, sizeof(*p));
    if (p) p->mode = mode;
    return p;
}

void ds4_permit_free(ds4_permit *p) {
    free(p);
}

bool ds4_permit_parse_mode(const char *text, ds4_permit_mode *out) {
    if (!text) return false;
    if (!strcmp(text, "ask")) *out = DS4_PERMIT_ASK;
    else if (!strcmp(text, "edits")) *out = DS4_PERMIT_EDITS;
    else if (!strcmp(text, "all")) *out = DS4_PERMIT_ALL;
    else return false;
    return true;
}

const char *ds4_permit_mode_name(ds4_permit_mode mode) {
    return mode == DS4_PERMIT_ALL ? "all" : mode == DS4_PERMIT_EDITS ? "edits" : "ask";
}

ds4_permit_mode ds4_permit_mode_of(const ds4_permit *p) {
    return p->mode;
}

void ds4_permit_set_mode(ds4_permit *p, ds4_permit_mode mode) {
    p->mode = mode;
}

/* Anything that lets a command do a second thing. A pipe is handled by the caller,
 * which is why it is not here: each side of one is judged by itself. */
static bool has_shell_control(const char *s) {
    return strpbrk(s, ";&><`$\n\r()\\'\"{}*?[]~!#") != NULL;
}

static bool word_is(const char *s, size_t n, const char *word) {
    return strlen(word) == n && !memcmp(s, word, n);
}

/* These look like reading and are not: they write a file, or run a program named by
 * the option or by the repository's own configuration. */
static bool has_unsafe_option(const char *s, size_t n) {
    static const char *const unsafe[] = {
        "--output", "--ext-diff", "--textconv", "--pre", "--open-files-in-pager",
        "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls", "-fprint0",
    };
    for (size_t i = 0; i < sizeof(unsafe) / sizeof(unsafe[0]); i++) {
        size_t m = strlen(unsafe[i]);
        for (const char *p = s; p + m <= s + n; p++) {
            bool starts = p == s || p[-1] == ' ' || p[-1] == '\t';
            if (starts && !memcmp(p, unsafe[i], m)) return true;
        }
    }
    return false;
}

static bool segment_reads_only(const char *s, size_t n) {
    static const char *const plain[] = {
        "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "find", "file", "stat", "du", "df",
        "which", "basename", "dirname", "date", "uname", "whoami",
    };
    static const char *const git[] = {"status", "diff", "log", "show", "blame"};
    while (n && (*s == ' ' || *s == '\t')) s++, n--;
    while (n && (s[n - 1] == ' ' || s[n - 1] == '\t')) n--;
    if (!n || has_unsafe_option(s, n)) return false;
    size_t first = strcspn(s, " \t");
    if (first > n) first = n;
    for (size_t i = 0; i < sizeof(plain) / sizeof(plain[0]); i++)
        if (word_is(s, first, plain[i])) return true;
    if (!word_is(s, first, "git")) return false;
    const char *rest = s + first;
    size_t left = n - first;
    while (left && (*rest == ' ' || *rest == '\t')) rest++, left--;
    size_t second = strcspn(rest, " \t");
    if (second > left) second = left;
    for (size_t i = 0; i < sizeof(git) / sizeof(git[0]); i++)
        if (word_is(rest, second, git[i])) return true;
    return false;
}

bool ds4_permit_bash_reads_only(const char *command) {
    if (!command || !command[0] || has_shell_control(command)) return false;
    const char *s = command;
    for (;;) {
        const char *bar = strchr(s, '|');
        size_t n = bar ? (size_t)(bar - s) : strlen(s);
        if (!segment_reads_only(s, n)) return false;
        if (!bar) return true;
        s = bar + 1;
    }
}

static bool rule_covers(const char *rule, const char *command) {
    size_t n = strlen(rule);
    if (n && rule[n - 1] == ' ') {
        size_t whole = n - 1;
        if (strpbrk(command, ";&|><`$\n\r()\\")) return false;
        return !strncmp(rule, command, whole) && (command[whole] == '\0' || command[whole] == ' ');
    }
    return !strcmp(rule, command);
}

bool ds4_permit_needs_asking(const ds4_permit *p, const char *tool, const char *arg) {
    if (p->mode == DS4_PERMIT_ALL || !tool) return false;
    if (!strcmp(tool, "edit") || !strcmp(tool, "write"))
        return p->mode == DS4_PERMIT_ASK && !p->edits_allowed;
    if (strcmp(tool, "bash") != 0) return false;
    if (ds4_permit_bash_reads_only(arg)) return false;
    for (int i = 0; i < p->rule_count; i++)
        if (rule_covers(p->rules[i], arg ? arg : "")) return false;
    return true;
}

/* The rule for a simple command: two words, unless the second is an option or a path,
 * where one word is as much as can be said about it. */
static void rule_for(const char *command, char *out, size_t out_len) {
    if (strpbrk(command, ";&|><`$\n\r()\\") || strlen(command) + 2 > out_len) {
        snprintf(out, out_len, "%s", command);
        return;
    }
    size_t n = strcspn(command, " ");
    const char *second = command + n;
    while (*second == ' ') second++;
    size_t len = strcspn(second, " ");
    bool plain = len && *second != '-' && !memchr(second, '/', len) && !memchr(second, '.', len);
    if (plain) n = (size_t)(second - command) + len;
    snprintf(out, out_len, "%.*s ", (int)n, command);
}

static void describe(const char *rule, char *out, size_t out_len) {
    size_t n = strlen(rule);
    bool prefix = n && rule[n - 1] == ' ';
    snprintf(out, out_len, "%.*s%s", (int)(prefix ? n - 1 : n), rule, prefix ? " ..." : "");
}

const char *ds4_permit_always_covers(ds4_permit *p, const char *tool, const char *arg) {
    if (tool && (!strcmp(tool, "edit") || !strcmp(tool, "write"))) {
        snprintf(p->said, sizeof(p->said), "all file edits");
        return p->said;
    }
    char rule[RULE_BYTES];
    rule_for(arg ? arg : "", rule, sizeof(rule));
    describe(rule, p->said, sizeof(p->said));
    return p->said;
}

void ds4_permit_allow_always(ds4_permit *p, const char *tool, const char *arg) {
    if (tool && (!strcmp(tool, "edit") || !strcmp(tool, "write"))) {
        p->edits_allowed = true;
    } else if (p->rule_count < RULES_MAX) {
        char rule[RULE_BYTES];
        rule_for(arg ? arg : "", rule, sizeof(rule));
        snprintf(p->rules[p->rule_count++], RULE_BYTES, "%s", rule);
    }
}
