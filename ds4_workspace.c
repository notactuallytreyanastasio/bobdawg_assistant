#include "ds4_workspace.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

bool ds4_workspace_id_is_valid(const char *id) {
    if (!id || strlen(id) != DS4_WORKSPACE_ID_CHARS) return false;
    for (size_t i = 0; i < DS4_WORKSPACE_ID_CHARS; i++) {
        bool hex = (id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f');
        if (!hex) return false;
    }
    return true;
}

void ds4_workspace_argv(const char *docker, const char *id, char *volume, size_t volume_len,
                        char *snapshots, size_t snapshots_len, char *name, size_t name_len,
                        const char *argv[DS4_WORKSPACE_ARGV_MAX]) {
    static unsigned serial;
    snprintf(volume, volume_len, "ds4ws-%s:/work", id);
    snprintf(snapshots, snapshots_len, "ds4ws-%s-undo:/snapshots", id);
    snprintf(name, name_len, "ds4run-%d-%u", (int)getpid(), __atomic_add_fetch(&serial, 1, __ATOMIC_RELAXED));
    const char *fixed[] = {
        docker, "run", "--rm", "-i",
        "--network", "none",
        "--read-only", "--tmpfs", "/tmp:size=256m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "256",
        "--memory", "1g", "--memory-swap", "1g",
        "--cpus", "2",
        "--ulimit", "fsize=1073741824", "--ulimit", "nofile=1024",
        "--user", "1000:1000",
        "--name", name,
        "-v", volume,
        "-v", snapshots,
        DS4_WORKSPACE_IMAGE,
        NULL,
    };
    memcpy(argv, fixed, sizeof(fixed));
}

static char *reply_of(const char *text, size_t *out_size) {
    size_t n = strlen(text) + 32;
    char *out = malloc(n);
    if (!out) return NULL;
    *out_size = (size_t)snprintf(out, n, "{\"ok\":false,\"text\":\"%s\"}", text);
    return out;
}

static bool spawn_quiet(const char *docker, const char *const *argv, int in_fd, int out_fd, pid_t *pid) {
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    if (in_fd >= 0) posix_spawn_file_actions_adddup2(&actions, in_fd, STDIN_FILENO);
    else posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    if (out_fd >= 0) posix_spawn_file_actions_adddup2(&actions, out_fd, STDOUT_FILENO);
    else posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    int rc = posix_spawnp(pid, docker, &actions, NULL, (char *const *)argv, environ);
    posix_spawn_file_actions_destroy(&actions);
    return rc == 0;
}

static int wait_for(pid_t pid) {
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    return status;
}

bool ds4_workspace_ready(const char *docker, char *err, size_t err_len) {
    const char *argv[] = {docker, "image", "inspect", DS4_WORKSPACE_IMAGE, NULL};
    pid_t pid;
    if (!spawn_quiet(docker, argv, -1, -1, &pid)) {
        snprintf(err, err_len, "%s cannot be run", docker);
        return false;
    }
    int status = wait_for(pid);
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return true;
    snprintf(err, err_len, "no %s image: run docker build -t %s sandbox",
             DS4_WORKSPACE_IMAGE, DS4_WORKSPACE_IMAGE);
    return false;
}

/* Killing the docker client leaves the container running, so it is named and killed by
 * that name. */
static void kill_container(const char *docker, const char *name, pid_t client) {
    const char *argv[] = {docker, "kill", name, NULL};
    pid_t pid;
    if (spawn_quiet(docker, argv, -1, -1, &pid)) wait_for(pid);
    kill(client, SIGKILL);
}

char *ds4_workspace_run(const char *docker, const char *id, const char *request, int seconds,
                        size_t *out_size) {
    if (!ds4_workspace_id_is_valid(id)) return reply_of("no such workspace", out_size);
    if (seconds <= 0 || seconds > DS4_WORKSPACE_SECONDS) seconds = DS4_WORKSPACE_SECONDS;

    int to_child[2], from_child[2];
    if (pipe(to_child) != 0) return reply_of("the sandbox could not start", out_size);
    if (pipe(from_child) != 0) {
        close(to_child[0]);
        close(to_child[1]);
        return reply_of("the sandbox could not start", out_size);
    }
    fcntl(to_child[1], F_SETFD, FD_CLOEXEC);
    fcntl(from_child[0], F_SETFD, FD_CLOEXEC);

    char volume[DS4_WORKSPACE_ID_CHARS + 16];
    char snapshots[DS4_WORKSPACE_ID_CHARS + 32];
    char name[64];
    const char *argv[DS4_WORKSPACE_ARGV_MAX];
    ds4_workspace_argv(docker, id, volume, sizeof(volume), snapshots, sizeof(snapshots), name, sizeof(name), argv);
    pid_t pid;
    bool spawned = spawn_quiet(docker, argv, to_child[0], from_child[1], &pid);
    close(to_child[0]);
    close(from_child[1]);
    if (!spawned) {
        close(to_child[1]);
        close(from_child[0]);
        return reply_of("the sandbox could not start", out_size);
    }

    /* Both ways at once: a pipe holds little, and either side can fill it. */
    int in_fd = to_child[1];
    fcntl(in_fd, F_SETFL, O_NONBLOCK);
    const char *left = request;
    size_t left_len = strlen(request);
    char *out = malloc(DS4_WORKSPACE_MAX_REPLY + 1);
    size_t got = 0;
    bool over = false, timed_out = false;
    time_t deadline = time(NULL) + seconds;
    void (*was_pipe)(int) = signal(SIGPIPE, SIG_IGN);
    if (left_len == 0) {
        close(in_fd);
        in_fd = -1;
    }
    for (;;) {
        time_t remaining = deadline - time(NULL);
        if (remaining <= 0) {
            timed_out = true;
            break;
        }
        struct pollfd fds[2] = {{.fd = from_child[0], .events = POLLIN}, {.fd = in_fd, .events = POLLOUT}};
        int rc = poll(fds, in_fd >= 0 ? 2 : 1, (int)(remaining > 1 ? 1000 : remaining * 1000));
        if (rc < 0 && errno == EINTR) continue;
        if (rc < 0) break;
        if (in_fd >= 0 && fds[1].revents) {
            ssize_t n = write(in_fd, left, left_len);
            if (n > 0) {
                left += n;
                left_len -= (size_t)n;
            }
            if (left_len == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
                close(in_fd);
                in_fd = -1;
            }
        }
        if (fds[0].revents) {
            char chunk[8192];
            ssize_t n = read(from_child[0], chunk, sizeof(chunk));
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            size_t take = (size_t)n;
            if (got + take > DS4_WORKSPACE_MAX_REPLY) {
                take = DS4_WORKSPACE_MAX_REPLY - got;
                over = true;
            }
            if (out) memcpy(out + got, chunk, take);
            got += take;
        }
    }
    signal(SIGPIPE, was_pipe);
    if (in_fd >= 0) close(in_fd);
    close(from_child[0]);
    if (timed_out) kill_container(docker, name, pid);
    int status = wait_for(pid);
    if (!out) return reply_of("out of memory", out_size);
    if (timed_out) {
        free(out);
        return reply_of("the call ran out of time and was stopped", out_size);
    }
    if (over) {
        free(out);
        return reply_of("the tool's answer was too large", out_size);
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 || got == 0) {
        free(out);
        return reply_of("the sandbox stopped without answering", out_size);
    }
    out[got] = '\0';
    *out_size = got;
    return out;
}
