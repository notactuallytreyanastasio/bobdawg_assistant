/* The hooks engine: see ds4_hooks.h for what a hook is. This file knows nothing about
 * git or the decision graph; those are only the first things that use it. */

#include "ds4_hooks.h"

#include <ctype.h>
#include <errno.h>
#include <fnmatch.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define DS4_HOOK_TIMEOUT_MS 30000
#define DS4_HOOK_OUTPUT_MAX (16 * 1024)
#define DS4_HOOK_RESULT_MAX (16 * 1024)
#define DS4_HOOK_LINE_MAX 4096
#define DS4_HOOK_REFUSE_EXIT 2

extern char **environ;

typedef struct {
    ds4_hook_event event;
    char *tool;
    char *pattern;
    char *command;
} ds4_hook;

struct ds4_hooks {
    char root[PATH_MAX];
    ds4_hook *v;
    int len;
};

static bool event_of(const char *name, ds4_hook_event *out) {
    static const struct {
        const char *name;
        ds4_hook_event event;
    } events[] = {
        {"session_start", DS4_HOOK_SESSION_START},
        {"pre_tool", DS4_HOOK_PRE_TOOL},
        {"post_tool", DS4_HOOK_POST_TOOL},
        {"session_end", DS4_HOOK_SESSION_END},
    };
    for (size_t i = 0; i < sizeof(events) / sizeof(events[0]); i++) {
        if (!strcmp(name, events[i].name)) {
            *out = events[i].event;
            return true;
        }
    }
    return false;
}

static char *next_field(char **cursor) {
    char *p = *cursor;
    while (*p && isspace((unsigned char)*p)) p++;
    if (!*p) return NULL;
    char *start = p;
    while (*p && !isspace((unsigned char)*p)) p++;
    if (*p) *p++ = '\0';
    *cursor = p;
    return start;
}

ds4_hooks *ds4_hooks_load(const char *root, char *err, size_t err_len) {
    char path[PATH_MAX + 16];
    if (err && err_len) err[0] = '\0';
    snprintf(path, sizeof(path), "%s/.ds4/hooks", root);
    FILE *f = fopen(path, "r");
    if (!f) return NULL;

    ds4_hooks *h = calloc(1, sizeof(*h));
    if (!h) {
        fclose(f);
        return NULL;
    }
    snprintf(h->root, sizeof(h->root), "%s", root);
    char line[DS4_HOOK_LINE_MAX];
    int number = 0;
    while (fgets(line, sizeof(line), f)) {
        number++;
        line[strcspn(line, "\r\n")] = '\0';
        char *cursor = line;
        char *event = next_field(&cursor);
        if (!event || event[0] == '#') continue;
        char *tool = next_field(&cursor);
        char *pattern = next_field(&cursor);
        while (*cursor && isspace((unsigned char)*cursor)) cursor++;
        ds4_hook hook = {0};
        if (!tool || !pattern || !*cursor || !event_of(event, &hook.event)) {
            if (err && err_len)
                snprintf(err, err_len, "%s:%d: want <event> <tool> <pattern> <command>", path, number);
            fclose(f);
            ds4_hooks_free(h);
            return NULL;
        }
        ds4_hook *grown = realloc(h->v, sizeof(*h->v) * (size_t)(h->len + 1));
        if (!grown) break;
        h->v = grown;
        hook.tool = strdup(tool);
        hook.pattern = strdup(pattern);
        hook.command = strdup(cursor);
        h->v[h->len++] = hook;
    }
    fclose(f);
    return h;
}

void ds4_hooks_free(ds4_hooks *h) {
    if (!h) return;
    for (int i = 0; i < h->len; i++) {
        free(h->v[i].tool);
        free(h->v[i].pattern);
        free(h->v[i].command);
    }
    free(h->v);
    free(h);
}

int ds4_hooks_count(const ds4_hooks *h) {
    return h ? h->len : 0;
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* The inherited environment plus a few names. The caller's process has threads, so the
 * block is built for the child rather than set in the parent. */
static char **child_env(char **extra, int extra_len) {
    int count = 0;
    while (environ[count]) count++;
    char **env = calloc((size_t)(count + extra_len + 1), sizeof(*env));
    if (!env) return NULL;
    memcpy(env, environ, sizeof(*env) * (size_t)count);
    memcpy(env + count, extra, sizeof(*env) * (size_t)extra_len);
    return env;
}

static char *env_pair(const char *name, const char *value) {
    size_t len = strlen(name) + strlen(value) + 2;
    char *out = malloc(len);
    if (out) snprintf(out, len, "%s=%s", name, value);
    return out;
}

/* One command to its end, or to the deadline. Returns its exit status, -1 when it was
 * killed or could not start. Output goes on being read past the cap, or a chatty hook
 * would block on a full pipe and look like a hang. */
static int run_command(const ds4_hooks *h, const char *command, char **env,
                       char *out, size_t out_cap, size_t *out_len) {
    int pipefd[2];
    if (pipe(pipefd) != 0) return -1;

    size_t script_len = strlen(command) + strlen(h->root) + 32;
    char *script = malloc(script_len);
    if (!script) {
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    /* The root goes through the environment so no path needs quoting into a script. */
    snprintf(script, script_len, "cd \"$DS4_HOOK_ROOT\" || exit 1\n%s", command);
    char *argv[] = {"sh", "-c", script, NULL};

    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attr;
    posix_spawn_file_actions_init(&actions);
    posix_spawnattr_init(&attr);
    /* Its own process group, so a timeout takes whatever it started as well. */
    posix_spawnattr_setpgroup(&attr, 0);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
    posix_spawn_file_actions_addclose(&actions, pipefd[0]);
    posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDERR_FILENO);
    posix_spawn_file_actions_addclose(&actions, pipefd[1]);
    pid_t pid = 0;
    int rc = posix_spawn(&pid, "/bin/sh", &actions, &attr, argv, env);
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attr);
    free(script);
    close(pipefd[1]);
    if (rc != 0) {
        close(pipefd[0]);
        return -1;
    }

    long long deadline = now_ms() + DS4_HOOK_TIMEOUT_MS;
    bool timed_out = false;
    for (;;) {
        long long left = deadline - now_ms();
        if (left <= 0) {
            timed_out = true;
            break;
        }
        struct pollfd pfd = {.fd = pipefd[0], .events = POLLIN};
        int ready = poll(&pfd, 1, (int)left);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) {
            timed_out = ready == 0;
            break;
        }
        char buf[4096];
        ssize_t n = read(pipefd[0], buf, sizeof(buf));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        size_t room = *out_len < out_cap ? out_cap - *out_len : 0;
        size_t take = (size_t)n < room ? (size_t)n : room;
        memcpy(out + *out_len, buf, take);
        *out_len += take;
    }
    close(pipefd[0]);
    if (timed_out) kill(-pid, SIGKILL);

    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    if (timed_out || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

static const char *event_name(ds4_hook_event event) {
    switch (event) {
    case DS4_HOOK_SESSION_START: return "session_start";
    case DS4_HOOK_PRE_TOOL: return "pre_tool";
    case DS4_HOOK_POST_TOOL: return "post_tool";
    case DS4_HOOK_SESSION_END: return "session_end";
    }
    return "";
}

static bool hook_matches(const ds4_hook *hook, ds4_hook_event event, const char *tool, const char *arg) {
    if (hook->event != event) return false;
    if (strcmp(hook->tool, "*") != 0 && strcmp(hook->tool, tool) != 0) return false;
    return fnmatch(hook->pattern, arg, 0) == 0;
}

ds4_hook_result ds4_hooks_run(const ds4_hooks *h, ds4_hook_event event, const char *tool,
                              const char *arg, const char *result_text, int exit_status) {
    ds4_hook_result result = {.blocked = false, .output = NULL};
    size_t cap = DS4_HOOK_OUTPUT_MAX, len = 0;
    char *out = calloc(1, cap + 256);
    if (!h || !out) {
        result.output = out ? out : strdup("");
        return result;
    }
    const char *tool_name = tool ? tool : "";
    const char *argument = arg ? arg : "";

    char status[32], clipped[DS4_HOOK_RESULT_MAX + 1];
    snprintf(status, sizeof(status), "%d", exit_status);
    snprintf(clipped, sizeof(clipped), "%s", result_text ? result_text : "");
    char *extra[] = {
        env_pair("DS4_HOOK_EVENT", event_name(event)),
        env_pair("DS4_HOOK_TOOL", tool_name),
        env_pair("DS4_HOOK_ARG", argument),
        env_pair("DS4_HOOK_RESULT", clipped),
        env_pair("DS4_HOOK_EXIT", status),
        env_pair("DS4_HOOK_ROOT", h->root),
    };
    const int extra_len = (int)(sizeof(extra) / sizeof(extra[0]));
    char **env = child_env(extra, extra_len);

    for (int i = 0; env && i < h->len; i++) {
        const ds4_hook *hook = &h->v[i];
        if (!hook_matches(hook, event, tool_name, argument)) continue;
        int rc = run_command(h, hook->command, env, out, cap, &len);
        if (rc == DS4_HOOK_REFUSE_EXIT && event == DS4_HOOK_PRE_TOOL) {
            result.blocked = true;
            break;
        }
        if (rc != 0) {
            len += (size_t)snprintf(out + len, 256, "%shook failed (%s): %.120s\n",
                                    len && out[len - 1] != '\n' ? "\n" : "",
                                    rc < 0 ? "killed or timed out" : "bad exit status",
                                    hook->command);
            if (len > cap) len = cap;
        }
    }
    out[len] = '\0';
    free(env);
    for (int i = 0; i < extra_len; i++) free(extra[i]);
    result.output = out;
    return result;
}
