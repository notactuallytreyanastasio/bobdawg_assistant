#include "ds4_input.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    char *text;
    size_t len;
} text_buf;

static void put_n(text_buf *b, const char *s, size_t n) {
    char *grown = realloc(b->text, b->len + n + 1);
    if (!grown) return;
    b->text = grown;
    memcpy(b->text + b->len, s, n);
    b->len += n;
    b->text[b->len] = '\0';
}

static void put(text_buf *b, const char *s) {
    put_n(b, s, strlen(s));
}

static char *read_regular(const char *path, size_t max, bool *clipped) {
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return NULL;
    FILE *fp = fopen(path, "rb");
    if (!fp) return NULL;
    size_t size = (size_t)st.st_size > max ? max : (size_t)st.st_size;
    char *data = malloc(size + 1);
    if (!data) {
        fclose(fp);
        return NULL;
    }
    size_t got = fread(data, 1, size, fp);
    fclose(fp);
    data[got] = '\0';
    if (clipped) *clipped = (size_t)st.st_size > max;
    return data;
}

static bool is_directory(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

/* The repository's root, or dir itself when it is in none. Never above home, so a
 * stray .git there does not make every project one. */
static void root_of(const char *dir, const char *home, char *out, size_t out_len) {
    char at[PATH_MAX];
    snprintf(at, sizeof(at), "%s", dir);
    for (;;) {
        char probe[PATH_MAX + 8];
        snprintf(probe, sizeof(probe), "%s/.git", at);
        struct stat st;
        if (stat(probe, &st) == 0) {
            snprintf(out, out_len, "%s", at);
            return;
        }
        char *slash = strrchr(at, '/');
        if (!slash || slash == at || (home && !strcmp(at, home))) break;
        *slash = '\0';
    }
    snprintf(out, out_len, "%s", dir);
}

static void add_instructions_of(text_buf *b, const char *dir) {
    static const char *const names[] = {"AGENT.md", "AGENTS.md", "CLAUDE.md"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        char path[PATH_MAX + 16];
        snprintf(path, sizeof(path), "%s/%s", dir, names[i]);
        if (b->len >= DS4_INPUT_INSTRUCTION_BYTES) return;
        bool clipped = false;
        char *data = read_regular(path, DS4_INPUT_INSTRUCTION_BYTES - b->len, &clipped);
        if (!data) continue;
        put(b, "\n\nInstructions from ");
        put(b, path);
        put(b, ":\n");
        put(b, data);
        if (clipped) put(b, "\n[cut off here: the file is longer than instructions may be]");
        free(data);
        return;
    }
}

char *ds4_input_instructions(const char *dir, const char *home) {
    text_buf b = {0};
    if (home) {
        char own[PATH_MAX];
        snprintf(own, sizeof(own), "%s/.ds4", home);
        add_instructions_of(&b, own);
    }
    char root[PATH_MAX];
    root_of(dir, home, root, sizeof(root));
    add_instructions_of(&b, root);
    /* Each directory between the root and here, in that order, so the nearest speaks
     * last. dir is below root by construction. */
    size_t at = strlen(root);
    while (dir[at] == '/') {
        const char *next = strchr(dir + at + 1, '/');
        size_t end = next ? (size_t)(next - dir) : strlen(dir);
        char step[PATH_MAX];
        snprintf(step, sizeof(step), "%.*s", (int)end, dir);
        add_instructions_of(&b, step);
        at = end;
    }
    return b.text;
}

static bool ends_mention(char c) {
    return c == '\0' || isspace((unsigned char)c);
}

static void trim_mention(const char *start, size_t *n) {
    while (*n && strchr(".,;:!?)]}'\"", start[*n - 1])) (*n)--;
}

char *ds4_input_expand_mentions(const char *prompt) {
    text_buf added = {0};
    for (const char *p = prompt; *p; p++) {
        if (*p != '@' || (p != prompt && !isspace((unsigned char)p[-1]))) continue;
        const char *start = p + 1;
        size_t n = 0;
        while (!ends_mention(start[n])) n++;
        trim_mention(start, &n);
        if (!n || n >= PATH_MAX) continue;
        char path[PATH_MAX];
        snprintf(path, sizeof(path), "%.*s", (int)n, start);
        bool clipped = false;
        char *data = read_regular(path, DS4_INPUT_MENTION_BYTES, &clipped);
        if (!data) continue;
        put(&added, "\n\nThe file ");
        put(&added, path);
        put(&added, clipped ? ", cut off at its first 64 KiB:\n```\n" : ":\n```\n");
        put(&added, data);
        put(&added, "\n```");
        free(data);
    }
    if (!added.text) return NULL;
    text_buf out = {0};
    put(&out, prompt);
    put(&out, added.text);
    free(added.text);
    return out.text;
}

typedef struct {
    const char *name;
    const char *about;
    const char *prompt;
} builtin_command;

static const builtin_command BUILTINS[] = {
    {"init", "write an AGENT.md for this repository",
     "Read this repository and write an AGENT.md at its root for future sessions: how to build "
     "it, how to run its tests and a single test, how the code is laid out, and the rules a "
     "newcomer would break. Keep to what cannot be seen at a glance, and to what you checked. "
     "If one exists, improve it rather than replacing it. $ARGUMENTS"},
    {"review", "review the changes not yet committed",
     "Review the changes in this repository that are not committed yet: run git status and git "
     "diff, and read what you need around them. Report real defects first, each with the file, "
     "the line and what would go wrong, then anything else worth saying, and change nothing. "
     "$ARGUMENTS"},
};

static bool name_is_usable(const char *s, size_t n) {
    if (!n || n > 64) return false;
    for (size_t i = 0; i < n; i++)
        if (!isalnum((unsigned char)s[i]) && s[i] != '-' && s[i] != '_') return false;
    return true;
}

static char *command_file(const char *name, const char *dir, const char *home) {
    char root[PATH_MAX];
    root_of(dir, home, root, sizeof(root));
    char path[PATH_MAX + 96];
    snprintf(path, sizeof(path), "%s/.ds4/commands/%s.md", root, name);
    char *body = read_regular(path, DS4_INPUT_MENTION_BYTES, NULL);
    if (body || !home) return body;
    snprintf(path, sizeof(path), "%s/.ds4/commands/%s.md", home, name);
    return read_regular(path, DS4_INPUT_MENTION_BYTES, NULL);
}

static char *fill_arguments(const char *body, const char *args) {
    static const char mark[] = "$ARGUMENTS";
    text_buf b = {0};
    bool used = false;
    const char *p = body;
    for (const char *hit; (hit = strstr(p, mark)) != NULL; p = hit + sizeof(mark) - 1) {
        put_n(&b, p, (size_t)(hit - p));
        put(&b, args);
        used = true;
    }
    put(&b, p);
    if (!used && args[0]) {
        put(&b, "\n\n");
        put(&b, args);
    }
    return b.text ? b.text : calloc(1, 1);
}

char *ds4_input_command_prompt(const char *line, const char *dir, const char *home) {
    if (!line || line[0] != '/') return NULL;
    const char *name = line + 1;
    size_t n = strcspn(name, " \t");
    if (!name_is_usable(name, n)) return NULL;
    char word[65];
    snprintf(word, sizeof(word), "%.*s", (int)n, name);
    const char *args = name + n;
    while (*args == ' ' || *args == '\t') args++;
    char *body = command_file(word, dir, home);
    if (body) {
        char *filled = fill_arguments(body, args);
        free(body);
        return filled;
    }
    for (size_t i = 0; i < sizeof(BUILTINS) / sizeof(BUILTINS[0]); i++)
        if (!strcmp(BUILTINS[i].name, word)) return fill_arguments(BUILTINS[i].prompt, args);
    return NULL;
}

static void list_directory(text_buf *b, const char *dir, const char *from) {
    DIR *d = opendir(dir);
    if (!d) return;
    for (struct dirent *e; (e = readdir(d)) != NULL;) {
        size_t n = strlen(e->d_name);
        if (n < 4 || strcmp(e->d_name + n - 3, ".md") != 0 || !name_is_usable(e->d_name, n - 3)) continue;
        put(b, "/");
        put_n(b, e->d_name, n - 3);
        put(b, " (");
        put(b, from);
        put(b, ")\n");
    }
    closedir(d);
}

char *ds4_input_command_list(const char *dir, const char *home) {
    text_buf b = {0};
    for (size_t i = 0; i < sizeof(BUILTINS) / sizeof(BUILTINS[0]); i++) {
        put(&b, "/");
        put(&b, BUILTINS[i].name);
        put(&b, ": ");
        put(&b, BUILTINS[i].about);
        put(&b, "\n");
    }
    char root[PATH_MAX];
    root_of(dir, home, root, sizeof(root));
    char path[PATH_MAX + 32];
    snprintf(path, sizeof(path), "%s/.ds4/commands", root);
    if (is_directory(path)) list_directory(&b, path, "this repository");
    if (home) {
        snprintf(path, sizeof(path), "%s/.ds4/commands", home);
        if (is_directory(path)) list_directory(&b, path, "yours");
    }
    return b.text ? b.text : calloc(1, 1);
}

char *ds4_input_run_shell(const char *command) {
    text_buf b = {0};
    int fds[2];
    if (pipe(fds) != 0) {
        put(&b, "could not run the command\n");
        return b.text;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(fds[0]);
        close(fds[1]);
        put(&b, "could not run the command\n");
        return b.text;
    }
    if (pid == 0) {
        setpgid(0, 0);
        close(fds[0]);
        dup2(fds[1], STDOUT_FILENO);
        dup2(fds[1], STDERR_FILENO);
        close(fds[1]);
        freopen("/dev/null", "r", stdin);
        execl("/bin/sh", "sh", "-c", command, (char *)NULL);
        _exit(127);
    }
    close(fds[1]);
    time_t deadline = time(NULL) + DS4_INPUT_SHELL_SECONDS;
    bool timed_out = false;
    bool clipped = false;
    for (;;) {
        time_t left = deadline - time(NULL);
        if (left <= 0) {
            timed_out = true;
            break;
        }
        struct pollfd pfd = {.fd = fds[0], .events = POLLIN};
        int rc = poll(&pfd, 1, (int)left * 1000);
        if (rc < 0 && errno == EINTR) continue;
        if (rc <= 0) {
            timed_out = rc == 0;
            break;
        }
        char chunk[4096];
        ssize_t n = read(fds[0], chunk, sizeof(chunk));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        size_t room = b.len < DS4_INPUT_SHELL_BYTES ? DS4_INPUT_SHELL_BYTES - b.len : 0;
        if ((size_t)n > room) clipped = true;
        put_n(&b, chunk, (size_t)n > room ? room : (size_t)n);
    }
    close(fds[0]);
    if (timed_out) kill(-pid, SIGKILL);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    if (clipped) put(&b, "\n[output cut off]");
    if (b.len && b.text[b.len - 1] != '\n') put(&b, "\n");
    char tail[64];
    if (timed_out) snprintf(tail, sizeof(tail), "[killed after %d seconds]\n", DS4_INPUT_SHELL_SECONDS);
    else if (WIFEXITED(status)) snprintf(tail, sizeof(tail), "[exit %d]\n", WEXITSTATUS(status));
    else snprintf(tail, sizeof(tail), "[stopped by a signal]\n");
    put(&b, tail);
    return b.text;
}
