#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "../ds4_agent.c"
#include <sys/stat.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/resource.h>
#include <sys/socket.h>
#if defined(__APPLE__) || defined(__linux__)
#include <sys/xattr.h>
#endif

static const char *test_output_dir;

static void test_fixture(const char *name, const char *data, size_t len) {
    if (!test_output_dir) return;
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/%s", test_output_dir, name);
    FILE *fp = fopen(path, "wb");
    AGENT_TEST_ASSERT(fp != NULL);
    if (!fp) return;
    AGENT_TEST_ASSERT(fwrite(data, 1, len, fp) == len);
    AGENT_TEST_ASSERT(fclose(fp) == 0);
}

/* Permission is granted by this parse, so only the whole word may count. */
static void test_permission_answers(void) {
    AGENT_TEST_ASSERT(agent_parse_choice("y\n") == 'y');
    AGENT_TEST_ASSERT(agent_parse_choice("  YES \n") == 'y');
    AGENT_TEST_ASSERT(agent_parse_choice("n\n") == 'n');
    AGENT_TEST_ASSERT(agent_parse_choice("no\n") == 'n');
    AGENT_TEST_ASSERT(agent_parse_choice("a\n") == 'a');
    AGENT_TEST_ASSERT(agent_parse_choice("always\n") == 'a');
    AGENT_TEST_ASSERT(agent_parse_choice("at is the project code word\n") == 0);
    AGENT_TEST_ASSERT(agent_parse_choice("yeah go on\n") == 0);
    AGENT_TEST_ASSERT(agent_parse_choice("nope\n") == 0);
    AGENT_TEST_ASSERT(agent_parse_choice("\n") == 0);
}

static void test_tool_arg(agent_tool_call *call, const char *name, const char *value) {
    agent_tool_call_add_arg(call, name, value, strlen(value), true, "</arg_value>");
}

static int test_write_file(const char *path, const char *data, size_t len,
                           char *err, size_t errlen) {
    return agent_replace_file(path, data, len, NULL, 0, err, errlen);
}

static void test_atomic_file_tools(void) {
    char dir[] = "/tmp/ds4-agent-files-XXXXXX";
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    char path[PATH_MAX], linkpath[PATH_MAX], err[256];
    snprintf(path, sizeof(path), "%s/file", dir);
    snprintf(linkpath, sizeof(linkpath), "%s/link", dir);
    char original[4096];
    memset(original, 'x', sizeof(original));
    AGENT_TEST_ASSERT(test_write_file(path, original, sizeof(original), err, sizeof(err)) == 0);
    AGENT_TEST_ASSERT(chmod(path, 0751) == 0);
#ifdef __APPLE__
    AGENT_TEST_ASSERT(setxattr(path, "com.ds4.agent-test", "keep", 4, 0, 0) == 0);
#elif defined(__linux__)
    AGENT_TEST_ASSERT(setxattr(path, "user.ds4-agent-test", "keep", 4, 0) == 0);
#endif

    pid_t child = fork();
    AGENT_TEST_ASSERT(child >= 0);
    if (child == 0) {
        signal(SIGXFSZ, SIG_IGN);
        struct rlimit limit = {64, 64};
        if (setrlimit(RLIMIT_FSIZE, &limit)) _exit(2);
        int rc = agent_replace_file(path, original, sizeof(original),
                                     original, sizeof(original), err, sizeof(err));
        _exit(rc == -1 ? 0 : 3);
    }
    int status = 0;
    if (child > 0) waitpid(child, &status, 0);
    AGENT_TEST_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    char *data = NULL;
    size_t len = 0;
    AGENT_TEST_ASSERT(agent_read_file_bytes(path, &data, &len, err, sizeof(err)) == 0);
    AGENT_TEST_ASSERT(len == sizeof(original) && !memcmp(data, original, len));
    free(data);
    AGENT_TEST_ASSERT(agent_replace_file(path, "bad", 3, "stale", 5, err, sizeof(err)) == -1);
    AGENT_TEST_ASSERT(strstr(err, "changed") != NULL);

    AGENT_TEST_ASSERT(symlink("file", linkpath) == 0);
    AGENT_TEST_ASSERT(test_write_file(linkpath, "new", 3, err, sizeof(err)) == 0);
    struct stat st;
    AGENT_TEST_ASSERT(lstat(linkpath, &st) == 0 && S_ISLNK(st.st_mode));
    AGENT_TEST_ASSERT(stat(path, &st) == 0 && (st.st_mode & 0777) == 0751);
    AGENT_TEST_ASSERT(st.st_uid == getuid());
#ifdef __APPLE__
    char attribute[16];
    AGENT_TEST_ASSERT(getxattr(path, "com.ds4.agent-test", attribute, sizeof(attribute), 0, 0) == 4);
    AGENT_TEST_ASSERT(!memcmp(attribute, "keep", 4));
#elif defined(__linux__)
    char attribute[16];
    AGENT_TEST_ASSERT(getxattr(path, "user.ds4-agent-test", attribute, sizeof(attribute)) == 4);
    AGENT_TEST_ASSERT(!memcmp(attribute, "keep", 4));
#endif
    AGENT_TEST_ASSERT(agent_read_file_bytes(path, &data, &len, err, sizeof(err)) == 0);
    AGENT_TEST_ASSERT(len == 3 && !memcmp(data, "new", 3));
    free(data);
    unlink(linkpath);
    AGENT_TEST_ASSERT(link(path, linkpath) == 0);
    AGENT_TEST_ASSERT(test_write_file(path, "bad", 3, err, sizeof(err)) == -1);
    AGENT_TEST_ASSERT(strstr(err, "hard-linked") != NULL);
    unlink(linkpath);
    unlink(path);
    /* Failed replacements must not leave temporary files behind. */
    AGENT_TEST_ASSERT(rmdir(dir) == 0);

    const char *match = NULL;
    size_t match_len = 0;
    bool anchored = true;
    AGENT_TEST_ASSERT(agent_edit_find_old_span("literal [upto] text", 19,
                         "[upto]", false, &match, &match_len, &anchored, err, sizeof(err)));
    AGENT_TEST_ASSERT(!anchored && match_len == 6 && !memcmp(match, "[upto]", 6));
}

static void test_streaming_file_tools(void) {
    char path[] = "/tmp/ds4-agent-read-XXXXXX";
    int fd = mkstemp(path);
    AGENT_TEST_ASSERT(fd >= 0);
    FILE *fp = fdopen(fd, "wb");
    /* Larger than the old whole-file cap, with matches at both ends. */
    fputs("needle first\r\n", fp);
    for (int i = 0; i < 1024 * 1024; i++) fputs("0123456789abcdef\n", fp);
    fputs("needle last\r", fp);
    fclose(fp);
    agent_worker w = {0};
    char *text = agent_read_range(&w, path, 1, 1, false, false, true);
    AGENT_TEST_ASSERT(strstr(text, "needle first") && w.more_valid);
    AGENT_TEST_ASSERT(w.more_next_line == 2 && w.more_byte_offset == 14);
    free(text);
    agent_tool_call more = {0};
    test_tool_arg(&more, "count", "1");
    text = agent_tool_more(&w, &more);
    AGENT_TEST_ASSERT(strstr(text, "2 0123456789abcdef"));
    free(text);
    agent_tool_call_free(&more);

    agent_tool_call call = {0};
    test_tool_arg(&call, "path", path);
    test_tool_arg(&call, "query", "needle");
    char linkpath[PATH_MAX];
    snprintf(linkpath, sizeof(linkpath), "%s-link", path);
    AGENT_TEST_ASSERT(symlink(path, linkpath) == 0);
    agent_tool_call linked = {0};
    test_tool_arg(&linked, "path", linkpath);
    test_tool_arg(&linked, "query", "needle");
    text = agent_tool_search(&w, &linked);
    AGENT_TEST_ASSERT(strstr(text, "2 matches") && strstr(text, "needle last"));
    free(text);
    agent_tool_call_free(&linked);
    unlink(linkpath);
    text = agent_tool_search(&w, &call);
    AGENT_TEST_ASSERT(strstr(text, "2 matches") && strstr(text, "needle last"));
    free(text);
    test_tool_arg(&call, "mode", "regexp");
    text = agent_tool_search(&w, &call);
    AGENT_TEST_ASSERT(strstr(text, "Tool error:"));
    free(text);
    agent_tool_call_free(&call);

    fp = fopen(path, "wb");
    for (int i = 0; i < 256 * 1024; i++) fputc('x', fp);
    fclose(fp);
    size_t total = 0;
    text = agent_read_range(&w, path, 1, 1, false, true, true);
    do {
        size_t n = strspn(text, "x");
        total += n;
        AGENT_TEST_ASSERT(n > 0 && n < AGENT_TOOL_MAX_BYTES);
        if (w.more_valid) AGENT_TEST_ASSERT(strstr(text, "Read truncated") != NULL);
        free(text);
        if (!w.more_valid) break;
        text = agent_tool_more(&w, &more);
    } while (total < 512 * 1024);
    AGENT_TEST_ASSERT(total == 256 * 1024 && !w.more_valid);
    text = agent_read_range(&w, path, 1, INT_MAX, true, true, true);
    AGENT_TEST_ASSERT(strstr(text, "Tool error: whole read") && !w.more_valid);
    free(text);
    fp = fopen(path, "wb");
    for (int i = 0; i < 256 * 1024; i++) fputc(0x80, fp);
    fclose(fp);
    text = agent_read_range(&w, path, 1, 1, false, true, true);
    AGENT_TEST_ASSERT(strlen(text) < AGENT_TOOL_MAX_BYTES && w.more_valid);
    free(text);
    unlink(path);
    AGENT_TEST_ASSERT(mkfifo(path, 0600) == 0);
    double started = now_sec();
    text = agent_read_range(&w, path, 1, 1, false, false, true);
    AGENT_TEST_ASSERT(strstr(text, "Tool error:") && now_sec() - started < 0.5);
    free(text);
    unlink(path);
    test_tool_arg(&call, "path", path);
    test_tool_arg(&call, "query", "needle");
    text = agent_tool_search(&w, &call);
    AGENT_TEST_ASSERT(strstr(text, "Tool error:"));
    free(text);
    agent_tool_call_free(&call);

    agent_buf b = {0};
    char *large = xmalloc(200000);
    memset(large, 'q', 200000);
    agent_buf_append(&b, large, 200000);
    text = agent_buf_take(&b);
    AGENT_TEST_ASSERT(strlen(text) == 200000);
    free(text);
    b.limit = 100;
    agent_buf_append(&b, large, 200000);
    text = agent_buf_take(&b);
    AGENT_TEST_ASSERT(strstr(text, "Output truncated") != NULL);
    free(large);
    free(text);
    b.limit = 3;
    agent_buf_puts(&b, "a\xe4\xb8\xad" "b");
    text = agent_buf_take(&b);
    AGENT_TEST_ASSERT(!strncmp(text, "a\n[Output truncated", 19));
    free(text);
}

static void test_shell_spawn(void) {
    agent_worker w = {0};
    pthread_mutex_init(&w.mu, NULL);
    w.wake_fd[0] = w.wake_fd[1] = -1;
    char err[256], cwd[PATH_MAX];
    AGENT_TEST_ASSERT(getcwd(cwd, sizeof(cwd)) != NULL);
    setenv("DS4_TEST_SHELL_ENV", "inherited", 1);
    for (int closed_stdio = 0; closed_stdio <= 1; closed_stdio++) {
        int saved[3];
        if (closed_stdio) {
            fflush(NULL);
            for (int i = 0; i < 3; i++) {
                saved[i] = fcntl(i, F_DUPFD_CLOEXEC, 3);
                AGENT_TEST_ASSERT(saved[i] >= 0);
                if (saved[i] < 0) exit(1);
            }
            for (int i = 0; i < 3; i++) close(i);
        }
        agent_bash_job *job = agent_bash_start(&w,
            "read line || printf 'stdin-eof\\n'; pwd; "
            "printf 'env=%s\\n' \"$DS4_TEST_SHELL_ENV\"; "
            "printf 'stderr-captured\\n' >&2; sleep 0.1; exit 23",
            5, err, sizeof(err));
        bool group_ok = job && getpgid(job->pid) == job->pid;
        double start = now_sec();
        while (job && agent_bash_is_running(job) && now_sec() - start < 6)
            usleep(10000);
        bool finished = false;
        char *obs = job ? agent_bash_observation(job, true, &finished) : NULL;
        if (job) {
            unlink(job->path);
            agent_bash_remove_job(&w, job);
        }
        if (closed_stdio) {
            for (int i = 0; i < 3; i++) {
                if (dup2(saved[i], i) < 0) _exit(1);
                close(saved[i]);
            }
        }
        AGENT_TEST_ASSERT(group_ok && finished && obs);
        if (obs) {
            AGENT_TEST_ASSERT(strstr(obs, "exit_status=23"));
            AGENT_TEST_ASSERT(strstr(obs, "stdin-eof"));
            AGENT_TEST_ASSERT(strstr(obs, cwd));
            AGENT_TEST_ASSERT(strstr(obs, "env=inherited"));
            AGENT_TEST_ASSERT(strstr(obs, "stderr-captured"));
        }
        free(obs);
    }
    unsetenv("DS4_TEST_SHELL_ENV");
    free(w.out);
    pthread_mutex_destroy(&w.mu);
}

static void test_background_jobs(void) {
    agent_worker w = {0};
    pthread_mutex_init(&w.mu, NULL);
    w.wake_fd[0] = w.wake_fd[1] = -1;
    char err[256], marker[] = "/tmp/ds4-agent-deadline-XXXXXX";
    int fd = mkstemp(marker);
    close(fd);
    unlink(marker);
    char cmd[PATH_MAX + 128];
    snprintf(cmd, sizeof(cmd), "sleep 2; printf late > %s", marker);
    agent_bash_job *job = agent_bash_start(&w, cmd, 1, err, sizeof(err));
    AGENT_TEST_ASSERT(job != NULL);
    if (!job) goto done;
    /* Deliberately no status polling: this stands in for model generation. */
    usleep(2400000);
    AGENT_TEST_ASSERT(access(marker, F_OK) != 0);
    bool finished = false;
    char *obs = agent_bash_observation(job, true, &finished);
    AGENT_TEST_ASSERT(finished && strstr(obs, "timed_out=1"));
    free(obs);
    unlink(job->path);
    agent_bash_remove_job(&w, job);

    job = agent_bash_start(&w, "(sleep 0.1; printf descendant-output) &", 5, err, sizeof(err));
    AGENT_TEST_ASSERT(job != NULL);
    if (!job) goto done;
    usleep(350000);
    obs = agent_bash_observation(job, true, &finished);
    AGENT_TEST_ASSERT(finished && strstr(obs, "descendant-output"));
    free(obs);
    unlink(job->path);
    agent_bash_remove_job(&w, job);

    job = agent_bash_start(&w, "head -c 2097152 /dev/zero | tr '\\000' x", 5, err, sizeof(err));
    AGENT_TEST_ASSERT(job != NULL);
    if (!job) goto done;
    usleep(900000);
    obs = agent_bash_observation(job, true, &finished);
    AGENT_TEST_ASSERT(finished && strstr(obs, "exit_status=0"));
    AGENT_TEST_ASSERT(job->bytes == 2097152);
    free(obs);
    obs = agent_bash_observation(job, true, &finished);
    AGENT_TEST_ASSERT(strlen(obs) < AGENT_BASH_TAIL_BYTES + 2048);
    free(obs);
    unlink(job->path);
    agent_bash_remove_job(&w, job);

    job = agent_bash_start(&w, "sleep 0.3; printf completed", 5, err, sizeof(err));
    AGENT_TEST_ASSERT(job != NULL);
    if (!job) goto done;
    char output_path[PATH_MAX];
    snprintf(output_path, sizeof(output_path), "%s", job->path);
    agent_tool_call call = {.name = xstrdup("bash_status")};
    char id[32];
    snprintf(id, sizeof(id), "%d", job->id);
    test_tool_arg(&call, "job", id);
    test_tool_arg(&call, "refresh_sec", "1");
    double start = now_sec();
    obs = agent_execute_tool_call(&w, &call);
    AGENT_TEST_ASSERT(now_sec() - start >= 0.2);
    AGENT_TEST_ASSERT(strstr(obs, "status=done") && strstr(obs, "completed"));
    AGENT_TEST_ASSERT(w.bash_jobs == NULL);
    free(obs);
    agent_tool_call_free(&call);
    unlink(output_path);

    /* Two monitors must make progress together, and stopping one must neither
     * block shutdown nor kill the other job's process group. */
    job = agent_bash_start(&w, "sleep 30", 60, err, sizeof(err));
    agent_bash_job *other = agent_bash_start(&w, "sleep 0.2; printf independent", 5, err, sizeof(err));
    AGENT_TEST_ASSERT(job && other);
    if (!job || !other) goto done;
    start = now_sec();
    agent_bash_signal(job, SIGKILL);
    unlink(job->path);
    agent_bash_remove_job(&w, job);
    AGENT_TEST_ASSERT(now_sec() - start < 2);
    while (agent_bash_is_running(other) && now_sec() - start < 3) usleep(10000);
    obs = agent_bash_observation(other, true, &finished);
    AGENT_TEST_ASSERT(finished && strstr(obs, "exit_status=0") && strstr(obs, "independent"));
    free(obs);
    unlink(other->path);
    agent_bash_remove_job(&w, other);
done:
    agent_bash_jobs_free(&w);
    unlink(marker);
    free(w.out);
    pthread_mutex_destroy(&w.mu);
}

static void test_completion(const char *text, linenoiseCompletions *completions) {
    (void)text;
    linenoiseAddCompletion(completions, "example");
}

static void test_fragmented_terminal_input(void) {
    int input[2];
    AGENT_TEST_ASSERT(pipe(input) == 0);
    fcntl(input[0], F_SETFL, O_NONBLOCK);
    FILE *sink = tmpfile();
    AGENT_TEST_ASSERT(sink != NULL);
    if (!sink) { close(input[0]); close(input[1]); return; }
    setenv("LINENOISE_ASSUME_TTY", "1", 1);
    struct linenoiseState l = {0};
    char buffer[1024] = "";
    l.ifd = input[0]; l.ofd = fileno(sink);
    l.buf = buffer; l.buflen = sizeof(buffer) - 1;
    l.cols = 80; l.prompt = "";
    const char *samples[] = {"\xc3\xa9", "\xe4\xb8\xad", "\xf0\x9f\x98\x80"};
    for (size_t s = 0; s < sizeof(samples)/sizeof(samples[0]); s++) {
        const char *sample = samples[s];
        for (size_t split = 1; split < strlen(sample); split++) {
            linenoiseEditClear(&l);
            for (size_t i = 0; i < split; i++)
                AGENT_TEST_ASSERT(linenoiseEditFeedByte(&l, sample[i]) == linenoiseEditMore);
            AGENT_TEST_ASSERT(l.len == 0);
            AGENT_TEST_ASSERT(linenoiseEditFeed(&l) == linenoiseEditMore);
            AGENT_TEST_ASSERT(l.len == 0);
            for (size_t i = split; i < strlen(sample); i++)
                AGENT_TEST_ASSERT(linenoiseEditFeedByte(&l, sample[i]) == linenoiseEditMore);
            AGENT_TEST_ASSERT(!strcmp(l.buf, sample));
        }
    }
    linenoiseEditClear(&l);
    const char sequence[] = "ab\x1b[DZ\x1b[3~\x1b[H!";
    for (size_t i = 0; i < sizeof(sequence) - 1; i++) {
        AGENT_TEST_ASSERT(linenoiseEditFeedByte(&l, sequence[i]) == linenoiseEditMore);
        AGENT_TEST_ASSERT(linenoiseEditFeed(&l) == linenoiseEditMore);
    }
    AGENT_TEST_ASSERT(!strcmp(l.buf, "!aZ"));
    linenoiseEditClear(&l);
    const char paste[] = "\x1b[200~one\r\n\xe4\xb8\xad\nthree\x1b[201~";
    for (size_t i = 0; i < sizeof(paste) - 1; i++) {
        AGENT_TEST_ASSERT(linenoiseEditFeedByte(&l, paste[i]) == linenoiseEditMore);
        AGENT_TEST_ASSERT(linenoiseEditFeed(&l) == linenoiseEditMore);
        if (i < sizeof(paste) - 2) AGENT_TEST_ASSERT(l.len == 0);
    }
    AGENT_TEST_ASSERT(!strcmp(l.buf, "one\n\xe4\xb8\xad\nthree"));
    linenoiseEditClear(&l);
    linenoiseEditFeedByte(&l, '\xe4');
    linenoiseEditFeedByte(&l, 'X');
    AGENT_TEST_ASSERT(!strcmp(l.buf, "\xef\xbf\xbdX"));
    linenoiseEditClear(&l);
    const char invalid_paste[] = "\x1b[200~bad\xe4\x1b[201~";
    for (size_t i = 0; i < sizeof(invalid_paste) - 1; i++)
        AGENT_TEST_ASSERT(linenoiseEditFeedByte(&l, invalid_paste[i]) == linenoiseEditMore);
    AGENT_TEST_ASSERT(l.len == 0 && !l.paste_active);
    linenoiseSetCompletionCallback(test_completion);
    linenoiseEditFeedByte(&l, 'e');
    linenoiseEditFeedByte(&l, '\t');
    AGENT_TEST_ASSERT(l.in_completion);
    linenoiseEditFeedByte(&l, '\x1b');
    AGENT_TEST_ASSERT(!l.in_completion && !strcmp(l.buf, "e"));
    linenoiseEditFeedByte(&l, '[');
    linenoiseEditFeedByte(&l, 'D');
    AGENT_TEST_ASSERT(l.pos == 0);
    linenoiseEditClear(&l);
    linenoiseEditFeedByte(&l, '\t');
    const char unicode[] = "\xe4\xb8\xad";
    for (size_t i = 0; i < sizeof(unicode) - 1; i++) linenoiseEditFeedByte(&l, unicode[i]);
    AGENT_TEST_ASSERT(!l.in_completion && !strcmp(l.buf, "example\xe4\xb8\xad"));
    linenoiseEditClear(&l);
    l.buflen = 3;
    linenoiseEditFeedByte(&l, 'e');
    linenoiseEditFeedByte(&l, '\t');
    linenoiseEditFeedByte(&l, ' ');
    AGENT_TEST_ASSERT(!l.in_completion && !strcmp(l.buf, "e") && l.len == 1);
    l.buflen = sizeof(buffer) - 1;
    linenoiseSetCompletionCallback(NULL);
    free(l.queued_input);
    free(l.paste_buf);
    close(input[0]); close(input[1]); fclose(sink);
    unsetenv("LINENOISE_ASSUME_TTY");
}

static void test_shell_terminal_controls(void) {
    const char malicious[] = "before\x1b[2Jafter\x1b[H!\x1b]52;c;secret\a"
                             "\x1bPdata\x1b\\\x1b[31mred\x1b[0m\b\n";
    char *safe = agent_terminal_safe_text(malicious, sizeof(malicious) - 1);
    AGENT_TEST_ASSERT(!strcmp(safe, "beforeafter!\x1b[31mred\x1b[0m\\x08\n"));
    free(safe);
    const char c1[] = "\xe4\xb8\xad\xc2\x9b" "2J\x9b" "2J";
    safe = agent_terminal_safe_text(c1, sizeof(c1) - 1);
    AGENT_TEST_ASSERT(!strcmp(safe, "\xe4\xb8\xad\\xc2\\x9b2J\\x9b2J"));
    free(safe);
    for (size_t i = 0; i < sizeof(malicious); i++) {
        safe = agent_terminal_safe_text(malicious, i);
        AGENT_TEST_ASSERT(!strstr(safe, "\x1b[2J") && !strstr(safe, "\x1b]52"));
        free(safe);
    }
}

static void test_markdown_literals(void) {
    const char *input[] = {"Use *.c files.", "The literal is \\*.", "An unmatched `tick",
                          "**bold** and *italic* and `code`.", "``a ` b``", "*unclosed",
                          "* list item\n", "trailing \\", "**unclosed", "`a``", "\\`literal\\`",
                          "> **Hint:** Check `errno`.\n"};
    const char *expected[] = {"Use *.c files.", "The literal is *.", "An unmatched `tick",
                             "bold and italic and code.", "a ` b", "*unclosed",
                             "* list item\n", "trailing \\", "**unclosed", "`a``", "`literal`",
                             "> Hint: Check errno.\n"};
    for (size_t i = 0; i < sizeof(input)/sizeof(input[0]); i++) {
        agent_tail_capture capture = {.cap = 16384};
        agent_token_renderer r = {.capture = &capture, .format_markdown = true};
        for (size_t j = 0; j < strlen(input[i]); j++) renderer_markdown_feed(&r, input[i][j]);
        renderer_markdown_finish(&r);
        renderer_flush_utf8(&r);
        size_t len;
        char *out = agent_tail_capture_take(&capture, &len);
        AGENT_TEST_ASSERT(!strcmp(out, expected[i]));
        if (strcmp(out, expected[i])) fprintf(stderr, "markdown: %s => %s\n", input[i], out);
        free(out);
    }
    agent_tail_capture capture = {.cap = 20000};
    agent_token_renderer r = {.capture = &capture, .format_markdown = true};
    renderer_markdown_feed(&r, '*');
    for (int i = 0; i < 8192; i++) renderer_markdown_feed(&r, 'x');
    renderer_markdown_finish(&r);
    size_t len;
    char *out = agent_tail_capture_take(&capture, &len);
    AGENT_TEST_ASSERT(len == 8193 && out[0] == '*');
    free(out);
}

static char *test_hint_capture(const char *text, size_t split, bool markdown,
                               bool color, agent_tool_syntax syntax, int *calls) {
    agent_tail_capture capture = {.cap = 32768};
    agent_token_renderer renderer = {.capture = &capture, .format_thinking = true,
        .format_markdown = markdown, .use_color = color, .last_output_newline = true};
    agent_dsml_parser parser = {.syntax = syntax, .state = AGENT_DSML_SEARCH};
    agent_stream_renderer stream = {.renderer = &renderer, .parser = &parser, .syntax = syntax};
    size_t n = strlen(text);
    if (split <= n) {
        agent_stream_text(&stream, text, split, false);
        /* A prompt redraw resets terminal colors between generated fragments. */
        if (color && renderer.wrote_visible_output) renderer_write(&renderer, "\x1b[0m", 4);
        agent_stream_text(&stream, text + split, n - split, false);
    } else {
        for (size_t i = 0; i < n; i++) {
            agent_stream_text(&stream, text + i, 1, false);
            if (color && renderer.wrote_visible_output) renderer_write(&renderer, "\x1b[0m", 4);
        }
    }
    agent_stream_text(&stream, NULL, 0, true);
    renderer_finish(&renderer);
    AGENT_TEST_ASSERT(!renderer.md_hint && !renderer.md_hint_prefix_len && !renderer.color_open);
    if (calls) {
        *calls = (int)parser.calls.len;
        AGENT_TEST_ASSERT(parser.calls.len == 1);
        if (parser.calls.len == 1) {
            AGENT_TEST_ASSERT(!strcmp(parser.calls.v[0].name, "bash"));
            AGENT_TEST_ASSERT(parser.calls.v[0].argc == 1);
            if (parser.calls.v[0].argc == 1)
                AGENT_TEST_ASSERT(!strcmp(parser.calls.v[0].args[0].value, "printf HINT_OK"));
        }
    } else AGENT_TEST_ASSERT(parser.calls.len == 0);
    agent_dsml_parser_free(&parser);
    return agent_tail_capture_take(&capture, NULL);
}

static void test_hint_rendering(void) {
    const char *badge = "\x1b[1;97;48;5;23m Hint \x1b[0m";
    const char *sample =
        "The error path is fixed.\n\n"
        "> **Hint:** Save `errno` before **cleanup**; calls can overwrite it.\n"
        "> Keep the original error for reporting.\n"
        "> Unicode stays intact: caf\xc3\xa9, \xe4\xb8\xad.\n"
        "Normal prose resumes here.\n\n"
        "```text\n> **Hint:** This is literal code.\n```\n"
        "Another normal line.\n";
    for (size_t split = 0; split <= strlen(sample) + 1; split++) {
        char *out = test_hint_capture(sample, split, true, true, AGENT_TOOL_SYNTAX_DSML, NULL);
        const char *label = strstr(out, badge);
        AGENT_TEST_ASSERT(label && !strstr(label + strlen(badge), badge));
        AGENT_TEST_ASSERT(strstr(out, "\x1b[1mcleanup") || split > strlen(sample));
        if (split == strlen(sample)) test_fixture("hints.ansi", out, strlen(out));
        if (split > strlen(sample)) test_fixture("hints-fragmented.ansi", out, strlen(out));
        free(out);
    }
    const char *literal[] = {"> quoted text", "> **Hinting:** not a hint",
        "Inline > **Hint:** not an aside", "`> **Hint:** literal`",
        "\\> **Hint:** escaped", "<think>> **Hint:** hidden reasoning</think>Normal."};
    for (size_t i = 0; i < sizeof(literal) / sizeof(literal[0]); i++) {
        char *out = test_hint_capture(literal[i], strlen(literal[i]), true, true,
                                      AGENT_TOOL_SYNTAX_DSML, NULL);
        AGENT_TEST_ASSERT(!strstr(out, badge));
        free(out);
    }
    const char marker[] = "> **Hint:**";
    for (size_t i = 0; i < sizeof(marker) - 1; i++) {
        char partial[sizeof(marker)];
        memcpy(partial, marker, i);
        partial[i] = 0;
        char *out = test_hint_capture(partial, i, true, true, AGENT_TOOL_SYNTAX_GLM, NULL);
        AGENT_TEST_ASSERT(!strstr(out, badge) && !strncmp(out, partial, i));
        free(out);
    }
    char *out = test_hint_capture(sample, strlen(sample), false, false, AGENT_TOOL_SYNTAX_DSML, NULL);
    AGENT_TEST_ASSERT(!strncmp(out, sample, strlen(sample)) && !strchr(out, '\x1b'));
    free(out);
    out = test_hint_capture("> **Hint:** Check `errno`.\n", 0, true, false, AGENT_TOOL_SYNTAX_DSML, NULL);
    AGENT_TEST_ASSERT(!strcmp(out, "> Hint: Check errno.\n\n"));
    free(out);
    const char *tool[] = {
        "> **Hint:** Keep shell checks reproducible.\n"
        "<｜DSML｜tool_calls><｜DSML｜invoke name=\"bash\">"
        "<｜DSML｜parameter name=\"command\" string=\"true\">printf HINT_OK"
        "</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>",
        "> **Hint:** Keep shell checks reproducible.\n"
        "<tool_call>bash<arg_key>command</arg_key><arg_value>printf HINT_OK</arg_value></tool_call>"
    };
    for (int glm = 0; glm < 2; glm++) {
        for (size_t split = 0; split <= strlen(tool[glm]); split++) {
            int calls = 0;
            out = test_hint_capture(tool[glm], split, true, true,
                glm ? AGENT_TOOL_SYNTAX_GLM : AGENT_TOOL_SYNTAX_DSML, &calls);
            AGENT_TEST_ASSERT(calls == 1 && strstr(out, badge));
            if (split == strlen(tool[glm]))
                test_fixture(glm ? "hints-glm-tool.ansi" : "hints-dsml-tool.ansi", out, strlen(out));
            free(out);
        }
    }
}

static void test_unicode_output_and_footer(void) {
    agent_editor ed = {0};
    ed.edit.cols = 80;
    char ascii[78];
    memset(ascii, 'a', sizeof(ascii));
    editor_note_output(&ed, ascii, sizeof(ascii));
    editor_note_output(&ed, "\xe4", 1);
    AGENT_TEST_ASSERT(ed.output_col == 78 && ed.output_utf8_len == 1);
    editor_note_output(&ed, "\xb8\xad", 2);
    AGENT_TEST_ASSERT(ed.output_col == 0 && ed.output_pending_wrap);
    editor_note_output(&ed, "\xcc\x81", 2);
    AGENT_TEST_ASSERT(ed.output_col == 0 && ed.output_pending_wrap);
    editor_note_output(&ed, "x", 1);
    AGENT_TEST_ASSERT(ed.output_col == 1 && !ed.output_pending_wrap);
    editor_note_output(&ed, "\r", 1);
    AGENT_TEST_ASSERT(ed.output_col == 0 && !ed.output_pending_wrap);
    const char family[] = "\xf0\x9f\x91\xa9\xe2\x80\x8d\xf0\x9f\x92\xbb";
    for (size_t i = 0; i < sizeof(family) - 1; i++) editor_note_output(&ed, family + i, 1);
    AGENT_TEST_ASSERT(ed.output_col == 2);
    int width;
    AGENT_TEST_ASSERT(linenoiseNextGrapheme(family, sizeof(family) - 1, &width) == sizeof(family) - 1 && width == 2);
    const char flag[] = "\xf0\x9f\x87\xae\xf0\x9f\x87\xb9";
    AGENT_TEST_ASSERT(linenoiseNextGrapheme(flag, sizeof(flag) - 1, &width) == sizeof(flag) - 1 && width == 2);
    editor_note_output(&ed, flag, sizeof(flag) - 1);
    AGENT_TEST_ASSERT(ed.output_col == 4);
    editor_note_output(&ed, "\x1b[", 2);
    AGENT_TEST_ASSERT(ed.output_escape == 2);
    editor_note_output(&ed, "31mX", 4);
    AGENT_TEST_ASSERT(ed.output_col == 5 && !ed.output_escape);

    agent_prompt_queue q = {0};
    char queued[181];
    for (int i = 0; i < 60; i++) memcpy(queued + i * 3, "\xe4\xb8\xad", 3);
    queued[180] = 0;
    agent_prompt_queue_push(&q, queued);
    agent_status st = {0};
    char footer[4096];
    build_footer_text(&st, &q, 40, footer, sizeof(footer));
    test_fixture("queue-footer.txt", footer, strlen(footer));
    for (size_t pos = 0; pos < strlen(footer);) {
        uint32_t cp;
        size_t n = linenoiseUtf8Decode(footer + pos, strlen(footer) - pos, &cp);
        AGENT_TEST_ASSERT(n && cp != 0xfffd);
        if (!n) break;
        pos += n;
    }
    agent_prompt_queue_free(&q);
}

static void test_footer_only_updates(void) {
    FILE *sink = tmpfile();
    AGENT_TEST_ASSERT(sink != NULL);
    if (!sink) return;
    int saved = dup(STDOUT_FILENO);
    dup2(fileno(sink), STDOUT_FILENO);
    agent_editor ed = {.active = true, .scroll_region = true, .term_rows = 24,
                       .term_cols = 80, .output_bottom = 22, .prompt_row = 23};
    snprintf(ed.prompt, sizeof(ed.prompt), "ds4-agent> ");
    snprintf(ed.status, sizeof(ed.status), "generation 0");
    char buffer[] = "draft";
    ed.edit = (struct linenoiseState){.ifd = -1, .ofd = STDOUT_FILENO,
        .buf = buffer, .buflen = sizeof(buffer), .len = 5, .pos = 5, .oldpos = 5,
        .prompt = ed.prompt, .plen = strlen(ed.prompt), .cols = 80,
        .oldrows = 1, .oldstatusrows = 1, .oldrpos = 1,
        .screen_cursor_row = 23, .screen_cursor_col = 17};
    linenoiseEditSetStatus(&ed.edit, ed.status, "", "");
    const char initial[] = "\x1b[23;1Hds4-agent> draft\r\ngeneration 0\x1b[23;17H";
    write_all(STDOUT_FILENO, initial, sizeof(initial) - 1);
    editor_set_prompt_status(&ed, ed.prompt, "generation 1");
    off_t first = lseek(STDOUT_FILENO, 0, SEEK_CUR);
    editor_set_prompt_status(&ed, ed.prompt, "generation 2");
    AGENT_TEST_ASSERT(lseek(STDOUT_FILENO, 0, SEEK_CUR) == first && ed.status_dirty);
    ed.last_prompt_redraw_time -= 1;
    editor_set_prompt_status(&ed, ed.prompt, "generation 2");
    AGENT_TEST_ASSERT(!ed.status_dirty);
    editor_set_prompt_status(&ed, ed.prompt, "done");
    editor_flush_prompt_status(&ed, true);
    AGENT_TEST_ASSERT(!ed.status_dirty && !strcmp(buffer, "draft"));
    dup2(saved, STDOUT_FILENO);
    close(saved);
    fseek(sink, 0, SEEK_END);
    size_t len = (size_t)ftell(sink);
    rewind(sink);
    char *text = xmalloc(len + 1);
    AGENT_TEST_ASSERT(fread(text, 1, len, sink) == len);
    text[len] = 0;
    AGENT_TEST_ASSERT(strstr(text, "\x1b[?2026h") && !strstr(text, "\x1b[0K"));
    test_fixture("status.ansi", text, len);
    free(text);
    free(ed.edit.status); free(ed.edit.status_start); free(ed.edit.status_end);
    fclose(sink);
}

static void test_tool_contracts(void) {
    for (int glm = 0; glm < 3; glm++) {
        for (int vision = 0; vision < 2; vision++) {
            char *prompt = glm == 2 ? agent_build_qwen_tools_prompt(false, vision) :
                           glm ? agent_build_glm_tools_prompt(false, vision) :
                                 agent_build_dsml_tools_prompt(false, vision);
            AGENT_TEST_ASSERT((strstr(prompt, "view_image") != NULL) == vision);
            AGENT_TEST_ASSERT(strstr(prompt, "POSIX extended") && strstr(prompt, "128 KiB"));
            AGENT_TEST_ASSERT(strstr(prompt, "&amp;lt;/"));
            /* The decision graph is a core tool of the harness: it is offered in every
             * prompt, under one name, and the prompt says what the moments to write are. */
            AGENT_TEST_ASSERT(strstr(prompt, "deciduous") != NULL);
            AGENT_TEST_ASSERT(strstr(prompt, "decide|turn|note|graph|board|goal|status") != NULL);
            AGENT_TEST_ASSERT(strstr(prompt, "goal") != NULL);
            if (!glm) AGENT_TEST_ASSERT(strstr(prompt, "\"name\": \"deciduous\"") != NULL);
            if (glm == 1) AGENT_TEST_ASSERT(strstr(prompt, "\"name\":\"deciduous\"") != NULL);
            if (glm == 2) AGENT_TEST_ASSERT(strstr(prompt, "\"name\":\"deciduous\"") != NULL);
            char name[64];
            snprintf(name, sizeof(name), "prompt-%s-%d.txt", glm == 2 ? "qwen" : glm ? "glm" : "dsml", vision);
            test_fixture(name, prompt, strlen(prompt));
            free(prompt);
        }
    }
}

/* The graph lives on the shared deciduous server, so these tests talk to a real
 * one through the API and skip silently when nothing is listening. They reuse one
 * workspace of their own so a run does not scatter names over somebody's database,
 * and they never shell out to the deciduous CLI: the server API is the only writer
 * ds4 has, which is the point of the seam. */
typedef struct { const char *key; const char *value; } graph_kv;

static char *graph_call(agent_worker *w, const char *op, const graph_kv *kv) {
    agent_tool_call call = {0};
    char *out;

    call.name = xstrdup("deciduous");
    if (op)
        agent_tool_call_add_arg(&call, "op", op, strlen(op), true, "</arg_value>");
    for (int i = 0; kv && kv[i].key; i++)
        agent_tool_call_add_arg(&call, kv[i].key, kv[i].value,
                                strlen(kv[i].value), true, "</arg_value>");
    out = agent_execute_tool_call(w, &call);
    agent_tool_call_free(&call);
    return out;
}

/* A deciduous server that misbehaves on request, because the failures that
 * matter here cannot be asked of the real one: a reply cut off halfway, or a
 * session that outlived a restart.  It serves one connection at a time on a
 * thread and keeps the last tool call it saw, so a test can read what ds4 really
 * put on the wire. */
typedef enum {
    FAKE_OK,
    FAKE_TRUNCATE_DECLARED,   /* promises more bytes than it sends */
    FAKE_TRUNCATE_JSON,       /* closes cleanly in the middle of the JSON */
    FAKE_STALE_ONCE,          /* refuses the current session, once */
    FAKE_OPEN_GOALS,          /* lists open goals for a query_nodes */
} fake_mode;

typedef struct {
    int listen_fd;
    int port;
    volatile fake_mode mode;
    volatile int initializes;
    volatile int tool_calls;
    char last_body[8192];
    size_t last_len;
    char last_auth[128];
    pthread_t thread;
} fake_mcp;

static void fake_reply(int fd, const char *head, const char *body) {
    char out[2048];
    int n = snprintf(out, sizeof(out),
                     "HTTP/1.1 %s\r\nContent-Type: application/json\r\n"
                     "Connection: close\r\nContent-Length: %zu\r\n\r\n%s",
                     head, strlen(body), body);
    if (write(fd, out, (size_t)n) < 0) return;
}

static void *fake_mcp_main(void *arg) {
    fake_mcp *f = arg;
    for (;;) {
        static char req[131072];
        size_t got = 0;
        int fd = accept(f->listen_fd, NULL, NULL);
        if (fd < 0) return NULL;
        for (;;) {
            ssize_t n = read(fd, req + got, sizeof(req) - 1 - got);
            if (n <= 0) break;
            got += (size_t)n;
            req[got] = '\0';
            char *end = strstr(req, "\r\n\r\n");
            char *len = strcasestr(req, "content-length:");
            if (end && len && got >= (size_t)(end + 4 - req) + (size_t)atol(len + 15)) break;
        }
        req[got] = '\0';
        char *body = strstr(req, "\r\n\r\n");
        body = body ? body + 4 : req;
        if (strstr(body, "\"initialize\"")) {
            char head[96];
            const char *auth = strcasestr(req, "authorization:");
            f->initializes++;
            snprintf(f->last_auth, sizeof(f->last_auth), "%.*s",
                     auth ? (int)strcspn(auth, "\r\n") : 0, auth ? auth : "");
            snprintf(head, sizeof(head), "200 OK\r\nMcp-Session-Id: fake-%d", f->initializes);
            fake_reply(fd, head, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":"
                                 "{\"instructions\":\"the fake rules\"}}");
        } else if (strstr(body, "notifications/initialized")) {
            fake_reply(fd, "202 Accepted", "");
        } else {
            f->tool_calls++;
            snprintf(f->last_body, sizeof(f->last_body), "%s", body);
            f->last_len = strlen(body);
            if (f->mode == FAKE_STALE_ONCE) {
                f->mode = FAKE_OK;
                fake_reply(fd, "404 Not Found",
                           "{\"error\":{\"code\":-32001,\"message\":\"Session not found\"},"
                           "\"id\":1,\"jsonrpc\":\"2.0\"}");
            } else if (f->mode == FAKE_OPEN_GOALS && strstr(body, "query_nodes")) {
                /* A loose match first: the server's search is not an equality. */
                fake_reply(fd, "200 OK",
                           "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\","
                           "\"text\":\"{\\\"nodes\\\":["
                           "{\\\"id\\\":\\\"22222222-near\\\",\\\"title\\\":\\\"ship the thing soon\\\"},"
                           "{\\\"id\\\":\\\"33333333-open\\\",\\\"title\\\":\\\"ship the thing\\\"}"
                           "]}\"}]}}");
            } else if (f->mode == FAKE_TRUNCATE_DECLARED) {
                const char *cut = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                                  "Content-Length: 500\r\n\r\n{\"jsonrpc\":\"2.0\",\"res";
                if (write(fd, cut, strlen(cut)) < 0) { /* the test sees the gap */ }
            } else if (f->mode == FAKE_TRUNCATE_JSON) {
                fake_reply(fd, "200 OK", "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"ty");
            } else {
                fake_reply(fd, "200 OK",
                           "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\","
                           "\"text\":\"{\\\"id\\\":\\\"11111111-aaaa\\\",\\\"results\\\":[],"
                           "\\\"nodes\\\":[],\\\"messages\\\":[],\\\"created\\\":true}\"}]}}");
            }
        }
        close(fd);
    }
}

static bool fake_mcp_start(fake_mcp *f) {
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    socklen_t len = sizeof(addr);
    char url[64];

    memset(f, 0, sizeof(*f));
    f->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (f->listen_fd < 0) return false;
    if (bind(f->listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) return false;
    if (listen(f->listen_fd, 8) != 0) return false;
    if (getsockname(f->listen_fd, (struct sockaddr *)&addr, &len) != 0) return false;
    f->port = ntohs(addr.sin_port);
    if (pthread_create(&f->thread, NULL, fake_mcp_main, f) != 0) return false;
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/mcp", f->port);
    setenv("DECIDUOUS_MCP_URL", url, 1);
    setenv("DECIDUOUS_MCP_TOKEN", "fake-token", 1);
    return true;
}

static void fake_mcp_stop(fake_mcp *f) {
    shutdown(f->listen_fd, SHUT_RDWR);
    close(f->listen_fd);
    pthread_join(f->thread, NULL);
    unsetenv("DECIDUOUS_MCP_URL");
    unsetenv("DECIDUOUS_MCP_TOKEN");
}

static char *fake_call(ds4_dec *d, const char *tool, const ds4_dec_arg *args, int argc,
                       char *err, size_t err_len) {
    ds4_dec_call call = {.tool = tool, .args = args, .argc = argc};
    return ds4_dec_execute(d, &call, err, err_len);
}

/* Which server, with whose token, under which workspace. HOME is a throwaway so
 * the machine's real files play no part. */
static void test_deciduous_server_choice(void) {
    fake_mcp f;
    ds4_dec *d;
    char dir[] = "/tmp/ds4-choice-XXXXXX";
    char home[PATH_MAX], path[PATH_MAX + 64], cmd[PATH_MAX * 2], url[64];
    const char *real_home = getenv("HOME");
    char *saved_home = real_home ? strdup(real_home) : NULL;
    FILE *fp;

    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    snprintf(home, sizeof(home), "%s/home", dir);
    snprintf(cmd, sizeof(cmd), "mkdir -p %s/.config/deciduous/server %s/.ds4 %s/plain/sub", home, home, dir);
    AGENT_TEST_ASSERT(system(cmd) == 0);
    setenv("HOME", home, 1);
    AGENT_TEST_ASSERT(fake_mcp_start(&f));
    snprintf(url, sizeof(url), "%s", getenv("DECIDUOUS_MCP_URL"));
    unsetenv("DECIDUOUS_MCP_TOKEN");
    unsetenv("DECIDUOUS_WORKSPACE");
    unsetenv("DECIDUOUS_BRANCH");

    snprintf(path, sizeof(path), "%s/.config/deciduous/server/.env", home);
    fp = fopen(path, "w");
    AGENT_TEST_ASSERT(fp != NULL);
    /* Nothing listens on port 1: reaching the fake proves the choice was made. */
    fprintf(fp, "DECIDUOUS_BIND_ADDRESS=127.0.0.1\nDECIDUOUS_PORT=1\nDECIDUOUS_MCP_TOKEN=local-secret\n");
    fclose(fp);
    snprintf(path, sizeof(path), "%s/.config/deciduous/credentials", home);
    fp = fopen(path, "w");
    AGENT_TEST_ASSERT(fp != NULL);
    fprintf(fp, "hosted-token\n");
    fclose(fp);

    /* The local server's token never leaves for another server. */
    snprintf(path, sizeof(path), "%s/plain/sub", dir);
    d = ds4_dec_open(path, "tester");
    AGENT_TEST_ASSERT(d != NULL && ds4_dec_active(d));
    AGENT_TEST_ASSERT(strstr(f.last_auth, "hosted-token") != NULL);
    AGENT_TEST_ASSERT(strstr(f.last_auth, "local-secret") == NULL);
    /* Outside a repository the work is scratch, not the path's top directory. */
    AGENT_TEST_ASSERT(strstr(ds4_dec_prompt_section(d), "Workspace \"scratch\"") != NULL);
    ds4_dec_close(d);

    /* ~/.ds4/graph counts only for a process that asked, and only then. */
    unsetenv("DECIDUOUS_MCP_URL");
    snprintf(path, sizeof(path), "%s/.ds4/graph", home);
    fp = fopen(path, "w");
    AGENT_TEST_ASSERT(fp != NULL);
    fprintf(fp, "%s\nnot this line\n", url);
    fclose(fp);
    snprintf(path, sizeof(path), "%s/plain", dir);
    int before = f.initializes;
    d = ds4_dec_open(path, "tester");
    AGENT_TEST_ASSERT(!ds4_dec_active(d));
    AGENT_TEST_ASSERT(f.initializes == before);
    ds4_dec_close(d);
    ds4_dec_use_user_server(true);
    d = ds4_dec_open(path, "tester");
    ds4_dec_use_user_server(false);
    AGENT_TEST_ASSERT(d != NULL && ds4_dec_active(d));
    AGENT_TEST_ASSERT(f.initializes == before + 1);
    AGENT_TEST_ASSERT(strstr(f.last_auth, "hosted-token") != NULL);
    ds4_dec_close(d);

    /* A goal the operator names is taken up when it is open, title for title. */
    f.mode = FAKE_OPEN_GOALS;
    setenv("DECIDUOUS_MCP_URL", url, 1);
    d = ds4_dec_open(path, "tester");
    AGENT_TEST_ASSERT(d != NULL);
    char *held = ds4_dec_claim_goal(d, "ship the thing");
    AGENT_TEST_ASSERT(held && strstr(held, "33333333-open") != NULL);
    AGENT_TEST_ASSERT(strstr(f.last_body, "add_node") == NULL);
    free(held);
    ds4_dec_close(d);
    /* A near match is a different goal, and an opening prompt never claims. */
    d = ds4_dec_open(path, "tester");
    AGENT_TEST_ASSERT(d != NULL);
    held = ds4_dec_claim_goal(d, "ship the");
    AGENT_TEST_ASSERT(held && strstr(held, "11111111-aaaa") != NULL);
    free(held);
    ds4_dec_close(d);
    d = ds4_dec_open(path, "tester");
    AGENT_TEST_ASSERT(d != NULL);
    held = ds4_dec_bind_goal(d, "ship the thing");
    AGENT_TEST_ASSERT(held && strstr(held, "11111111-aaaa") != NULL);
    free(held);
    ds4_dec_close(d);
    f.mode = FAKE_OK;

    fake_mcp_stop(&f);
    if (saved_home) setenv("HOME", saved_home, 1); else unsetenv("HOME");
    free(saved_home);
    snprintf(cmd, sizeof(cmd), "rm -rf %s", dir);
    AGENT_TEST_ASSERT(system(cmd) == 0);
}

static void test_deciduous_seam_failures(void) {
    fake_mcp f;
    ds4_dec *d;
    char err[512], *out;
    const ds4_dec_arg note[] = {{"title", "a fact"}, {"description", "it holds"}};
    const ds4_dec_arg decide[] = {{"title", "a choice"}, {"chosen_option", "this one"}};
    const ds4_dec_arg ask[] = {{"question", "what was decided"}};

    setenv("DECIDUOUS_WORKSPACE", "ds4-selftest", 1);
    setenv("DECIDUOUS_BRANCH", "main", 1);
    AGENT_TEST_ASSERT(fake_mcp_start(&f));
    d = ds4_dec_open("/tmp", "tester");
    AGENT_TEST_ASSERT(d != NULL);
    out = ds4_dec_bind_goal(d, "keep a session alive across a restart");
    free(out);
    AGENT_TEST_ASSERT(ds4_dec_goal_bound(d));

    /* A restarted server forgets the session.  That is not a failed write: the
     * write never ran, so ds4 shakes hands again and sends it once more. */
    f.mode = FAKE_STALE_ONCE;
    int calls = f.tool_calls;
    out = fake_call(d, "note", note, 2, err, sizeof(err));
    AGENT_TEST_ASSERT(out && strstr(out, "Observation recorded") != NULL);
    free(out);
    AGENT_TEST_ASSERT(f.initializes == 2);
    AGENT_TEST_ASSERT(f.tool_calls == calls + 2);

    /* An observation is live knowledge, not something waiting to happen. */
    AGENT_TEST_ASSERT(strstr(f.last_body, "\"status\":\"active\"") != NULL);

    /* A reply that stops short is not a success, whichever way it stopped: the
     * model must not be told a decision was logged when nobody can say so. */
    f.mode = FAKE_TRUNCATE_DECLARED;
    out = fake_call(d, "decide", decide, 2, err, sizeof(err));
    AGENT_TEST_ASSERT(out == NULL || strstr(out, "did not record") != NULL);
    AGENT_TEST_ASSERT(out == NULL || strstr(out, "logged") == NULL);
    free(out);
    f.mode = FAKE_TRUNCATE_JSON;
    out = fake_call(d, "decide", decide, 2, err, sizeof(err));
    AGENT_TEST_ASSERT(out == NULL || strstr(out, "did not record") != NULL);
    free(out);

    /* And an unreadable answer is not an empty graph. */
    out = fake_call(d, "graph", ask, 1, err, sizeof(err));
    AGENT_TEST_ASSERT(out == NULL || strstr(out, "Nothing in the graph") == NULL);
    free(out);
    f.mode = FAKE_OK;

    /* The opening request becomes the goal, but only when it carries intent, and
     * a bind that fails says so and leaves the session without a goal. */
    {
        agent_worker turn = {0};
        ds4_dec *fresh = ds4_dec_open("/tmp", "tester");
        AGENT_TEST_ASSERT(fresh != NULL);
        turn.dec = fresh;
        AGENT_TEST_ASSERT(!agent_worker_bind_request(&turn, "hi"));
        AGENT_TEST_ASSERT(!agent_worker_bind_request(&turn, "/new"));
        f.mode = FAKE_TRUNCATE_JSON;
        AGENT_TEST_ASSERT(!agent_worker_bind_request(&turn, "make the seam real, not just wired"));
        AGENT_TEST_ASSERT(!ds4_dec_goal_bound(fresh));
        f.mode = FAKE_OK;
        AGENT_TEST_ASSERT(agent_worker_bind_request(&turn, "make the seam real, not just wired"));
        AGENT_TEST_ASSERT(ds4_dec_goal_bound(fresh));
        AGENT_TEST_ASSERT(!agent_worker_bind_request(&turn, "and this is a second request"));
        ds4_dec_close(fresh);
    }

    /* A conversation is a goal and an exchange a step under it. The change id comes
     * from the page's chat id, so the writer keeps nothing between turns; the
     * session's own goal is not touched. */
    {
        ds4_dec *chats = ds4_dec_open("/tmp", "ds4-chat");
        ds4_dec_chat_turn turn = {.chat_id = "abc-1", .first_question = "why is the sky blue?",
                                  .question = "and at sunset?", .answer = "red, it scatters less",
                                  .ending = "length", .model = "Qwen"};
        char *goal;
        AGENT_TEST_ASSERT(chats != NULL);
        ds4_dec_use_branch(chats, "chat");
        calls = f.tool_calls;
        goal = ds4_dec_record_chat_turn(chats, &turn, err, sizeof(err));
        AGENT_TEST_ASSERT(goal && !strcmp(goal, "11111111-aaaa"));
        free(goal);
        AGENT_TEST_ASSERT(f.tool_calls == calls + 2);
        AGENT_TEST_ASSERT(!ds4_dec_goal_bound(chats));
        AGENT_TEST_ASSERT(strstr(f.last_body, "capture_conversation_turn") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "\"parent_node_id\":\"11111111-aaaa\"") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "Cut off at the length limit") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "red, it scatters less") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "\"branch\":\"chat\"") != NULL);

        turn.ending = "failed";
        turn.answer = "model busy";
        goal = ds4_dec_record_chat_turn(chats, &turn, err, sizeof(err));
        free(goal);
        AGENT_TEST_ASSERT(strstr(f.last_body, "\"success\":false") != NULL);

        /* Not recorded is reported, never swallowed. */
        f.mode = FAKE_TRUNCATE_JSON;
        AGENT_TEST_ASSERT(ds4_dec_record_chat_turn(chats, &turn, err, sizeof(err)) == NULL);
        AGENT_TEST_ASSERT(err[0] != '\0');
        f.mode = FAKE_OK;

        /* A very long answer is kept up to the limit, on a character. */
        char *longer = malloc(40000);
        memset(longer, 'y', 39999);
        memcpy(longer + 32767, "\xe2\x80\x94", 3);
        longer[39999] = '\0';
        turn.ending = "";
        turn.answer = longer;
        snprintf(f.last_body, sizeof(f.last_body), "%s", "");
        goal = ds4_dec_record_chat_turn(chats, &turn, err, sizeof(err));
        AGENT_TEST_ASSERT(goal != NULL);
        free(goal);
        free(longer);
        AGENT_TEST_ASSERT(f.last_len > 32000 && f.last_len < 34000);
        ds4_dec_close(chats);
    }

    /* A reply is a message number on the wire, whatever the model typed. */
    {
        const ds4_dec_arg reply[] = {{"subject", "s"}, {"body", "b"}, {"reply_to", "42"}};
        const ds4_dec_arg bad[] = {{"subject", "s"}, {"body", "b"}, {"reply_to", "soon"}};
        out = fake_call(d, "board", reply, 3, err, sizeof(err));
        free(out);
        AGENT_TEST_ASSERT(strstr(f.last_body, "\"reply_to\":42") != NULL);
        calls = f.tool_calls;
        out = fake_call(d, "board", bad, 3, err, sizeof(err));
        AGENT_TEST_ASSERT(out && strstr(out, "reply_to") != NULL);
        free(out);
        AGENT_TEST_ASSERT(f.tool_calls == calls);
    }

    /* The closing note quotes decision titles, and the server reads @word as an
     * address: a title about @types/node must not page a label that is not there.
     * A title cut for the note is cut on a character, never inside one. */
    {
        char title[160];
        memset(title, 'x', 126);
        memcpy(title + 126, "\xe2\x80\x94 tail", 9);
        title[135] = '\0';
        const ds4_dec_arg pkg[] = {{"title", "zero deps but @types/node"}, {"chosen_option", "dev only"}};
        const ds4_dec_arg wide[] = {{"title", title}, {"chosen_option", "dev only"}};
        out = fake_call(d, "decide", pkg, 2, err, sizeof(err));
        free(out);
        out = fake_call(d, "decide", wide, 2, err, sizeof(err));
        free(out);
        out = ds4_dec_close_session(d);
        AGENT_TEST_ASSERT(out != NULL);
        free(out);
        AGENT_TEST_ASSERT(strstr(f.last_body, "post_message") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "types/node") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "@types") == NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "xxx") != NULL);
        AGENT_TEST_ASSERT(strstr(f.last_body, "\xe2") == NULL);
    }
    ds4_dec_close(d);

    /* A worktree's .git is a file: the branch is the worktree's, and the workspace
     * is still the repository's name, because the graph belongs to the repository. */
    {
        char dir[] = "/tmp/ds4-dec-wt-XXXXXX", cmd[512], repo[PATH_MAX], tree[PATH_MAX];
        const char *section;
        AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
        snprintf(repo, sizeof(repo), "%s/myrepo", dir);
        snprintf(tree, sizeof(tree), "%s/elsewhere", dir);
        snprintf(cmd, sizeof(cmd),
                 "git init -q %s && git -C %s -c user.email=t@t -c user.name=t commit -q "
                 "--allow-empty -m x && git -C %s worktree add -q -b side %s", repo, repo, repo, tree);
        AGENT_TEST_ASSERT(system(cmd) == 0);
        unsetenv("DECIDUOUS_WORKSPACE");
        unsetenv("DECIDUOUS_BRANCH");
        d = ds4_dec_open(tree, "tester");
        AGENT_TEST_ASSERT(d != NULL);
        section = ds4_dec_prompt_section(d);
        AGENT_TEST_ASSERT(strstr(section, "Workspace \"myrepo\", branch \"side\"") != NULL);
        ds4_dec_close(d);
        snprintf(cmd, sizeof(cmd), "rm -rf %s", dir);
        AGENT_TEST_ASSERT(system(cmd) == 0);
    }

    /* The session is told the moments the server asks for, action and outcome
     * among them, because a teaching that leaves them out gets a graph without. */
    {
        const char *section;
        setenv("DECIDUOUS_WORKSPACE", "ds4-selftest", 1);
        setenv("DECIDUOUS_BRANCH", "main", 1);
        d = ds4_dec_open("/tmp", "tester");
        AGENT_TEST_ASSERT(d != NULL);
        section = ds4_dec_prompt_section(d);
        AGENT_TEST_ASSERT(strstr(section, "works or fails") != NULL);
        AGENT_TEST_ASSERT(strstr(section, "action and outcome") != NULL);
        AGENT_TEST_ASSERT(strstr(section, "do not narrate") == NULL);

        /* A reminder waits for work to remind about: an ls that exits 0 is not a
         * step, and a long run of edits with nothing recorded earns another word. */
        out = ds4_dec_bind_goal(d, "reminders follow the work");
        free(out);
        AGENT_TEST_ASSERT(ds4_dec_note_result(d, "bash", "ls", "exit_status=0\n", 0) == NULL);
        out = ds4_dec_note_result(d, "edit", "a.c", "Edited\n", -1);
        AGENT_TEST_ASSERT(out != NULL);
        free(out);
        out = ds4_dec_note_result(d, "bash", "make", "exit_status=0\n", 0);
        AGENT_TEST_ASSERT(out != NULL && strstr(out, "op=turn") != NULL);
        free(out);
        int nudges = 0;
        for (int i = 0; i < 8; i++) {
            out = ds4_dec_note_result(d, "edit", "a.c", "Edited\n", -1);
            if (out) nudges++;
            free(out);
        }
        AGENT_TEST_ASSERT(nudges == 1);
        ds4_dec_close(d);
    }
    fake_mcp_stop(&f);
    unsetenv("DECIDUOUS_WORKSPACE");
    unsetenv("DECIDUOUS_BRANCH");
}

/* A hooks file in a directory of its own, loaded the way a session loads it. */
static ds4_hooks *hooks_from(const char *dir, const char *text) {
    char path[PATH_MAX];
    char err[PATH_MAX + 80];
    snprintf(path, sizeof(path), "%s/.ds4", dir);
    mkdir(path, 0755);
    snprintf(path, sizeof(path), "%s/.ds4/hooks", dir);
    FILE *f = fopen(path, "w");
    AGENT_TEST_ASSERT(f != NULL);
    fputs(text, f);
    fclose(f);
    return ds4_hooks_load(dir, err, sizeof(err));
}

static void test_put_file(const char *path, const char *data, size_t len) {
    FILE *fp = fopen(path, "wb");
    AGENT_TEST_ASSERT(fp != NULL);
    if (!fp) return;
    AGENT_TEST_ASSERT(fwrite(data, 1, len, fp) == len);
    fclose(fp);
}

static void test_permissions(void) {
    /* What must not slip through as reading. */
    static const char *const asks[] = {
        "rm -rf build", "ls; rm x", "ls && rm x", "cat a > b", "cat a | sh", "git push",
        "git status; rm x", "find . -delete", "find . -exec rm {} +", "git diff --output=x",
        "git diff --ext-diff", "rg --pre sh x", "echo $(rm x)", "ls `rm x`", "cat a\nrm x",
        "tail -f a & rm x", "git -c core.pager=sh log", "python3 -c x", "", "ls | rm x",
    };
    for (size_t i = 0; i < sizeof(asks) / sizeof(asks[0]); i++)
        AGENT_TEST_ASSERT(!ds4_permit_bash_reads_only(asks[i]));
    static const char *const reads[] = {
        "ls -la", "pwd", "git status", "git diff --stat", "git log -5 --oneline",
        "cat a.txt | wc -l", "grep -n foo a.c | head -5",
    };
    for (size_t i = 0; i < sizeof(reads) / sizeof(reads[0]); i++)
        AGENT_TEST_ASSERT(ds4_permit_bash_reads_only(reads[i]));

    ds4_permit *p = ds4_permit_new(DS4_PERMIT_ASK);
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "edit", "a.c"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "write", "a.c"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "make"));
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "bash", "git status"));
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "read", "a.c"));
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "search", "x"));

    /* An always holds for that command, and only with nothing added to it. */
    AGENT_TEST_ASSERT(!strcmp(ds4_permit_always_covers(p, "bash", "npm test --watch"), "npm test ..."));
    ds4_permit_allow_always(p, "bash", "npm test --watch");
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "bash", "npm test"));
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "bash", "npm test -- a"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "npm testing"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "npm test; rm -rf ~"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "npm test && curl x | sh"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "npm publish"));

    /* The prompt shows how far one word reaches, and a compound stays exact. */
    AGENT_TEST_ASSERT(!strcmp(ds4_permit_always_covers(p, "bash", "rm -rf build"), "rm ..."));
    AGENT_TEST_ASSERT(!strcmp(ds4_permit_always_covers(p, "bash", "make a && make b"), "make a && make b"));
    ds4_permit_allow_always(p, "bash", "make a && make b");
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "bash", "make a && make b"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "make a && make c"));

    ds4_permit_allow_always(p, "edit", "a.c");
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "write", "b.c"));

    ds4_permit_set_mode(p, DS4_PERMIT_EDITS);
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "edit", "z"));
    AGENT_TEST_ASSERT(ds4_permit_needs_asking(p, "bash", "make z"));
    ds4_permit_set_mode(p, DS4_PERMIT_ALL);
    AGENT_TEST_ASSERT(!ds4_permit_needs_asking(p, "bash", "rm -rf x"));
    ds4_permit_free(p);

    ds4_permit_mode mode;
    AGENT_TEST_ASSERT(ds4_permit_parse_mode("edits", &mode) && mode == DS4_PERMIT_EDITS);
    AGENT_TEST_ASSERT(!ds4_permit_parse_mode("yes", &mode));
}

/* The wiring: a session with nobody to ask refuses, and says so, and the tool does not run. */
static void test_permissions_refuse_a_tool(void) {
    char marker[PATH_MAX];
    snprintf(marker, sizeof(marker), "%s/must-not-exist", test_output_dir ? test_output_dir : "/tmp");
    unlink(marker);
    agent_config cfg = {0};
    cfg.non_interactive = true;
    agent_worker w = {0};
    w.cfg = &cfg;
    w.permit = ds4_permit_new(DS4_PERMIT_ASK);
    agent_tool_call call = {0};
    call.name = xstrdup("write");
    test_tool_arg(&call, "path", marker);
    test_tool_arg(&call, "content", "x");
    agent_tool_observation obs;
    agent_tool_observation_init(&obs);
    AGENT_TEST_ASSERT(agent_tool_refused_by_person(&w, &call, &obs));
    AGENT_TEST_ASSERT(obs.part_count > 0 && strstr(obs.parts[obs.part_count - 1].text, "nobody is here to ask"));
    AGENT_TEST_ASSERT(access(marker, F_OK) != 0);
    agent_tool_observation_free(&obs);
    agent_tool_call_free(&call);
    ds4_permit_free(w.permit);
}

static void test_undo(void) {
    char dir[] = "/tmp/ds4-undo-XXXXXX";
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    char a[PATH_MAX], b[PATH_MAX];
    snprintf(a, sizeof(a), "%s/a.txt", dir);
    snprintf(b, sizeof(b), "%s/new.txt", dir);
    test_put_file(a, "one\n", 4);
    chmod(a, 0750);

    ds4_undo *u = ds4_undo_new();
    AGENT_TEST_ASSERT(ds4_undo_last(u) == NULL);

    /* Two edits in a turn come back to what the turn began with. */
    ds4_undo_begin_turn(u);
    ds4_undo_note(u, a);
    test_put_file(a, "two\n", 4);
    ds4_undo_note(u, a);
    test_put_file(a, "three\n", 6);
    ds4_undo_note(u, b);
    test_put_file(b, "made\n", 5);

    /* A later turn that changed nothing is passed over. */
    ds4_undo_begin_turn(u);
    ds4_undo_begin_turn(u);
    ds4_undo_note(u, a);
    test_put_file(a, "four\n", 5);
    AGENT_TEST_ASSERT(ds4_undo_depth(u) == 2);

    char *said = ds4_undo_last(u);
    AGENT_TEST_ASSERT(said && strstr(said, "restored") && strstr(said, "a.txt"));
    free(said);
    FILE *fp = fopen(a, "r");
    char line[16] = {0};
    AGENT_TEST_ASSERT(fp && fgets(line, sizeof(line), fp) && !strcmp(line, "three\n"));
    if (fp) fclose(fp);

    said = ds4_undo_last(u);
    AGENT_TEST_ASSERT(said && strstr(said, "removed") && strstr(said, "new.txt"));
    free(said);
    AGENT_TEST_ASSERT(access(b, F_OK) != 0);
    fp = fopen(a, "r");
    AGENT_TEST_ASSERT(fp && fgets(line, sizeof(line), fp) && !strcmp(line, "one\n"));
    if (fp) fclose(fp);
    struct stat st;
    AGENT_TEST_ASSERT(stat(a, &st) == 0 && (st.st_mode & 07777) == 0750);
    AGENT_TEST_ASSERT(ds4_undo_depth(u) == 0);
    AGENT_TEST_ASSERT(ds4_undo_last(u) == NULL);
    ds4_undo_free(u);
    unlink(a);
    rmdir(dir);
}

static void test_prompt_input(void) {
    char dir[] = "/tmp/ds4-input-XXXXXX";
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    char path[PATH_MAX], sub[PATH_MAX], home[PATH_MAX];
    snprintf(path, sizeof(path), "%s/.git", dir);
    AGENT_TEST_ASSERT(mkdir(path, 0700) == 0);
    snprintf(sub, sizeof(sub), "%s/src", dir);
    AGENT_TEST_ASSERT(mkdir(sub, 0700) == 0);
    snprintf(home, sizeof(home), "%s/home", dir);
    AGENT_TEST_ASSERT(mkdir(home, 0700) == 0);
    snprintf(path, sizeof(path), "%s/.ds4", home);
    AGENT_TEST_ASSERT(mkdir(path, 0700) == 0);

    AGENT_TEST_ASSERT(ds4_input_instructions(sub, NULL) == NULL);

    /* Mine, then the root's, then the nearest. AGENT.md wins over CLAUDE.md in a directory. */
    snprintf(path, sizeof(path), "%s/.ds4/AGENT.md", home);
    test_put_file(path, "MINE", 4);
    snprintf(path, sizeof(path), "%s/AGENT.md", dir);
    test_put_file(path, "ROOT", 4);
    snprintf(path, sizeof(path), "%s/CLAUDE.md", dir);
    test_put_file(path, "SHADOWED", 8);
    snprintf(path, sizeof(path), "%s/CLAUDE.md", sub);
    test_put_file(path, "NEAR", 4);
    char *found = ds4_input_instructions(sub, home);
    AGENT_TEST_ASSERT(found != NULL);
    if (found) {
        const char *mine = strstr(found, "MINE"), *root = strstr(found, "ROOT"), *near = strstr(found, "NEAR");
        AGENT_TEST_ASSERT(mine && root && near && mine < root && root < near);
        AGENT_TEST_ASSERT(!strstr(found, "SHADOWED"));
    }
    free(found);

    /* A huge file is cut, and says so. */
    size_t big = DS4_INPUT_INSTRUCTION_BYTES * 2;
    char *fill = xmalloc(big);
    memset(fill, 'x', big);
    snprintf(path, sizeof(path), "%s/AGENT.md", dir);
    test_put_file(path, fill, big);
    free(fill);
    found = ds4_input_instructions(dir, NULL);
    AGENT_TEST_ASSERT(found && strstr(found, "cut off here") &&
                      strlen(found) < DS4_INPUT_INSTRUCTION_BYTES + 512);
    free(found);

    /* Mentions: only a word naming a real file. */
    snprintf(path, sizeof(path), "%s/note.txt", dir);
    test_put_file(path, "the-contents", 12);
    char prompt[PATH_MAX + 64];
    snprintf(prompt, sizeof(prompt), "fix @%s, please", path);
    char *expanded = ds4_input_expand_mentions(prompt);
    AGENT_TEST_ASSERT(expanded && !strncmp(expanded, prompt, strlen(prompt)) && strstr(expanded, "the-contents"));
    free(expanded);
    AGENT_TEST_ASSERT(ds4_input_expand_mentions("mail me@example.com about @nothing/here") == NULL);
    AGENT_TEST_ASSERT(ds4_input_expand_mentions("no mention") == NULL);
    snprintf(prompt, sizeof(prompt), "@%s", dir);
    AGENT_TEST_ASSERT(ds4_input_expand_mentions(prompt) == NULL);

    /* Commands. */
    snprintf(path, sizeof(path), "%s/.ds4", dir);
    AGENT_TEST_ASSERT(mkdir(path, 0700) == 0);
    snprintf(path, sizeof(path), "%s/.ds4/commands", dir);
    AGENT_TEST_ASSERT(mkdir(path, 0700) == 0);
    snprintf(path, sizeof(path), "%s/.ds4/commands/ship.md", dir);
    test_put_file(path, "Ship $ARGUMENTS now, $ARGUMENTS!", 32);
    snprintf(path, sizeof(path), "%s/.ds4/commands/plain.md", dir);
    test_put_file(path, "Do it", 5);
    snprintf(path, sizeof(path), "%s/.ds4/commands/review.md", dir);
    test_put_file(path, "Our review", 10);

    char *c = ds4_input_command_prompt("/ship v2", sub, home);
    AGENT_TEST_ASSERT(c && !strcmp(c, "Ship v2 now, v2!"));
    free(c);
    c = ds4_input_command_prompt("/plain carefully", sub, home);
    AGENT_TEST_ASSERT(c && !strcmp(c, "Do it\n\ncarefully"));
    free(c);
    c = ds4_input_command_prompt("/review", sub, home);
    AGENT_TEST_ASSERT(c && !strcmp(c, "Our review"));
    free(c);
    c = ds4_input_command_prompt("/init", sub, home);
    AGENT_TEST_ASSERT(c && strstr(c, "AGENT.md") && !strstr(c, "$ARGUMENTS"));
    free(c);
    AGENT_TEST_ASSERT(ds4_input_command_prompt("/nothing", sub, home) == NULL);
    AGENT_TEST_ASSERT(ds4_input_command_prompt("/../../etc/passwd", sub, home) == NULL);
    AGENT_TEST_ASSERT(ds4_input_command_prompt("not a command", sub, home) == NULL);
    char *list = ds4_input_command_list(sub, home);
    AGENT_TEST_ASSERT(strstr(list, "/ship") && strstr(list, "/init"));
    free(list);

    /* The shell. */
    char *ran = ds4_input_run_shell("echo out; echo err >&2; exit 3");
    AGENT_TEST_ASSERT(strstr(ran, "out") && strstr(ran, "err") && strstr(ran, "[exit 3]"));
    free(ran);

    char command[PATH_MAX + 16];
    snprintf(command, sizeof(command), "rm -rf %s", dir);
    AGENT_TEST_ASSERT(system(command) == 0);
}

/* In a child with a real terminal, because the point is what a terminal shares. */
static void test_output_descriptions(void) {
    int master = posix_openpt(O_RDWR | O_NOCTTY);
    AGENT_TEST_ASSERT(master >= 0);
    if (master < 0) return;
    AGENT_TEST_ASSERT(grantpt(master) == 0 && unlockpt(master) == 0);
    char *name = ptsname(master);
    pid_t pid = fork();
    AGENT_TEST_ASSERT(pid >= 0);
    if (pid == 0) {
        int tty = open(name, O_RDWR);
        if (tty < 0) _exit(9);
        dup2(tty, STDIN_FILENO);
        dup2(tty, STDOUT_FILENO);
        dup2(tty, STDERR_FILENO);
        fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL, 0) | O_NONBLOCK);
        if (!(fcntl(STDOUT_FILENO, F_GETFL, 0) & O_NONBLOCK)) _exit(1);  /* the premise */
        fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL, 0) & ~O_NONBLOCK);
        agent_own_output_descriptions();
        fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL, 0) | O_NONBLOCK);
        _exit(fcntl(STDOUT_FILENO, F_GETFL, 0) & O_NONBLOCK ? 2 : 0);
    }
    int status = 1;
    waitpid(pid, &status, 0);
    close(master);
    AGENT_TEST_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

static void test_todo_and_edit_all(void) {
    int done = 0, total = 0;
    AGENT_TEST_ASSERT(ds4_input_todo_counts("[x] one\n[>] two\n[ ] three\n", &done, &total));
    AGENT_TEST_ASSERT(done == 1 && total == 3);
    AGENT_TEST_ASSERT(ds4_input_todo_counts("  [ ] indented\n\n[x] after a gap", &done, &total));
    AGENT_TEST_ASSERT(done == 1 && total == 2);
    AGENT_TEST_ASSERT(!ds4_input_todo_counts("", &done, &total));
    AGENT_TEST_ASSERT(!ds4_input_todo_counts(NULL, &done, &total));
    AGENT_TEST_ASSERT(!ds4_input_todo_counts("- not a task", &done, &total));
    AGENT_TEST_ASSERT(!ds4_input_todo_counts("[ ] ok\nnot one", &done, &total));

    agent_config cfg = {0};
    agent_worker w = {0};
    w.cfg = &cfg;
    pthread_mutex_init(&w.mu, NULL);
    agent_tool_call call = {0};
    call.name = xstrdup("todo");
    test_tool_arg(&call, "items", "[x] a\n[ ] b");
    char *res = agent_execute_tool_call(&w, &call);
    AGENT_TEST_ASSERT(strstr(res, "1 of 2"));
    free(res);
    AGENT_TEST_ASSERT(w.todo && w.status.todo_total == 2 && w.status.todo_done == 1);
    char status[256];
    build_status_text(&w.status, status, sizeof(status));
    AGENT_TEST_ASSERT(strstr(status, "tasks 1/2"));

    /* The list comes back after compaction, with or without bash jobs. */
    char *back = agent_bash_jobs_compaction_observation(&w);
    AGENT_TEST_ASSERT(back && strstr(back, "[ ] b"));
    free(back);

    agent_tool_call_free(&call);
    memset(&call, 0, sizeof(call));
    call.name = xstrdup("todo");
    test_tool_arg(&call, "items", "not a list");
    res = agent_execute_tool_call(&w, &call);
    AGENT_TEST_ASSERT(strstr(res, "Tool error"));
    free(res);
    AGENT_TEST_ASSERT(w.status.todo_total == 2);  /* a bad list changes nothing */
    agent_tool_call_free(&call);
    agent_todo_clear(&w);
    AGENT_TEST_ASSERT(!w.todo && w.status.todo_total == 0);

    char dir[] = "/tmp/ds4-editall-XXXXXX";
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/a.txt", dir);
    test_put_file(path, "foo bar foo\nkeep\nfoo", 20);
    memset(&call, 0, sizeof(call));
    call.name = xstrdup("edit");
    test_tool_arg(&call, "path", path);
    test_tool_arg(&call, "old", "foo");
    test_tool_arg(&call, "new", "x");
    res = agent_tool_edit(&w, &call);  /* without all, three matches are an error */
    AGENT_TEST_ASSERT(strstr(res, "Tool error"));
    free(res);
    test_tool_arg(&call, "all", "true");
    res = agent_tool_edit(&w, &call);
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    free(res);
    char body[64] = {0};
    FILE *fp = fopen(path, "r");
    AGENT_TEST_ASSERT(fp && fread(body, 1, sizeof(body) - 1, fp) > 0);
    if (fp) fclose(fp);
    AGENT_TEST_ASSERT(!strcmp(body, "x bar x\nkeep\nx"));
    agent_tool_call_free(&call);
    unlink(path);
    rmdir(dir);
    pthread_mutex_destroy(&w.mu);
}

static void test_hooks_engine(void) {
    char dir[] = "/tmp/ds4-hooks-XXXXXX", cmd[128], err[PATH_MAX + 80];
    ds4_hooks *h;
    ds4_hook_result r;

    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    AGENT_TEST_ASSERT(ds4_hooks_load(dir, err, sizeof(err)) == NULL);
    AGENT_TEST_ASSERT(err[0] == '\0'); /* no file is not a failure */

    /* Nothing happens without hooks, and that has to be safe to ask. */
    r = ds4_hooks_run(NULL, DS4_HOOK_PRE_TOOL, "bash", "ls", NULL, -1);
    AGENT_TEST_ASSERT(!r.blocked && r.output && !r.output[0]);
    free(r.output);

    /* A rule that does not parse is said, never quietly dropped. */
    AGENT_TEST_ASSERT(hooks_from(dir, "pre_tool bash\n") == NULL);
    {
        char complain[PATH_MAX + 80];
        AGENT_TEST_ASSERT(ds4_hooks_load(dir, complain, sizeof(complain)) == NULL);
        AGENT_TEST_ASSERT(strstr(complain, ":1:") != NULL);
    }
    AGENT_TEST_ASSERT(hooks_from(dir, "before_tool bash * true\n") == NULL);

    h = hooks_from(dir,
                   "# a comment, and a blank line\n\n"
                   "pre_tool  bash  *--no-verify*   echo refused here; exit 2\n"
                   "pre_tool  bash  ls*             echo looking at $DS4_HOOK_ARG in $(basename $PWD)\n"
                   "pre_tool  read  *               echo not for read; exit 2\n"
                   "pre_tool  bash  broken*         exit 7\n"
                   "post_tool bash  *               echo after $DS4_HOOK_EXIT: $DS4_HOOK_RESULT\n"
                   "post_tool bash  refuse*         exit 2\n"
                   "session_start * *               echo welcome\n");
    AGENT_TEST_ASSERT(h != NULL);
    AGENT_TEST_ASSERT(ds4_hooks_count(h) == 7);

    r = ds4_hooks_run(h, DS4_HOOK_PRE_TOOL, "bash", "git commit --no-verify -m x", NULL, -1);
    AGENT_TEST_ASSERT(r.blocked && strstr(r.output, "refused here") != NULL);
    free(r.output);

    /* Exit 0 passes what it printed along; a hook runs at the root it was loaded for. */
    r = ds4_hooks_run(h, DS4_HOOK_PRE_TOOL, "bash", "ls -la", NULL, -1);
    AGENT_TEST_ASSERT(!r.blocked && strstr(r.output, "looking at ls -la") != NULL);
    AGENT_TEST_ASSERT(strstr(r.output, strrchr(dir, '/') + 1) != NULL);
    free(r.output);

    /* A rule for one tool leaves the others alone, and an unmatched call is silent. */
    r = ds4_hooks_run(h, DS4_HOOK_PRE_TOOL, "bash", "make", NULL, -1);
    AGENT_TEST_ASSERT(!r.blocked && !r.output[0]);
    free(r.output);
    r = ds4_hooks_run(h, DS4_HOOK_PRE_TOOL, "read", "a.c", NULL, -1);
    AGENT_TEST_ASSERT(r.blocked);
    free(r.output);

    /* A broken hook is reported and does not stop the work. */
    r = ds4_hooks_run(h, DS4_HOOK_PRE_TOOL, "bash", "broken thing", NULL, -1);
    AGENT_TEST_ASSERT(!r.blocked && strstr(r.output, "hook failed") != NULL);
    free(r.output);

    /* The tool has already run, so exit 2 after it can refuse nothing. */
    r = ds4_hooks_run(h, DS4_HOOK_POST_TOOL, "bash", "refuse later", "it worked", 0);
    AGENT_TEST_ASSERT(!r.blocked);
    AGENT_TEST_ASSERT(strstr(r.output, "after 0: it worked") != NULL);
    free(r.output);

    r = ds4_hooks_run(h, DS4_HOOK_SESSION_START, "", "", NULL, -1);
    AGENT_TEST_ASSERT(strstr(r.output, "welcome") != NULL);
    free(r.output);
    ds4_hooks_free(h);

    /* The rules this repository ships have to parse and mean what they say. */
    {
        char complaint[PATH_MAX + 80];
        ds4_hooks *shipped = ds4_hooks_load(".", complaint, sizeof(complaint));
        AGENT_TEST_ASSERT(shipped != NULL);
        r = ds4_hooks_run(shipped, DS4_HOOK_PRE_TOOL, "bash", "git commit --no-verify -m x", NULL, -1);
        AGENT_TEST_ASSERT(r.blocked);
        free(r.output);
        r = ds4_hooks_run(shipped, DS4_HOOK_PRE_TOOL, "bash", "git push --no-verify fork main", NULL, -1);
        AGENT_TEST_ASSERT(r.blocked);
        free(r.output);
        r = ds4_hooks_run(shipped, DS4_HOOK_PRE_TOOL, "bash", "git commit -m x", NULL, -1);
        AGENT_TEST_ASSERT(!r.blocked);
        free(r.output);
        r = ds4_hooks_run(shipped, DS4_HOOK_POST_TOOL, "bash", "git commit -m x", "done", 0);
        AGENT_TEST_ASSERT(strstr(r.output, "hook failed") == NULL);
        AGENT_TEST_ASSERT(r.output[0] != '\0');
        free(r.output);
        ds4_hooks_free(shipped);
    }

    /* The agent's own loop: a refused tool does not run, and the model is told. */
    {
        agent_worker w = {0};
        agent_tool_calls calls = {0};
        agent_tool_call call = {0};
        char target[PATH_MAX + 16];
        agent_tool_arg arg = {.name = (char *)"command", .value = target};
        snprintf(target, sizeof(target), "touch %s/ran --no-verify", dir);
        w.hooks = hooks_from(dir, "pre_tool bash *--no-verify* echo not that; exit 2\n");
        AGENT_TEST_ASSERT(w.hooks != NULL);
        call.name = (char *)"bash";
        call.args = &arg;
        call.argc = 1;
        calls.v = &call;
        calls.len = 1;
        agent_tool_observation obs = agent_execute_tool_observation(&w, &calls);
        AGENT_TEST_ASSERT(strstr(obs.parts[0].text, "refused by a hook") != NULL);
        AGENT_TEST_ASSERT(strstr(obs.parts[0].text, "not that") != NULL);
        snprintf(target, sizeof(target), "%s/ran", dir);
        AGENT_TEST_ASSERT(access(target, F_OK) != 0);
        agent_tool_observation_free(&obs);
        ds4_hooks_free(w.hooks);
    }
    snprintf(cmd, sizeof(cmd), "rm -rf %s", dir);
    AGENT_TEST_ASSERT(system(cmd) == 0);
}

/* The graph's side of git, in a throwaway repository against the real server: what the
 * hooks rely on is what git and the server really do, so neither is faked here. */
static void test_deciduous_git(void) {
    char dir[] = "/tmp/ds4-git-XXXXXX", cmd[PATH_MAX], err[512], old_sha[64];
    int problems = -1;
    char *goal_out, *out;

    /* A branch per run: the last run's repository is gone, so its hashes really are
     * stale, and they would be found. */
    char branch[64];
    snprintf(branch, sizeof(branch), "git-selftest-%d-%ld", (int)getpid(), (long)time(NULL));
    setenv("DECIDUOUS_WORKSPACE", "ds4-selftest", 1);
    setenv("DECIDUOUS_BRANCH", branch, 1);
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
#define GIT(...) do { snprintf(cmd, sizeof(cmd), __VA_ARGS__); \
        AGENT_TEST_ASSERT(system(cmd) == 0); } while (0)
    GIT("cd %s && git init -q . && git config user.email t@t && git config user.name t", dir);
    GIT("cd %s && echo one > a && git add a && git commit -q -m 'first change %d'", dir, (int)getpid());

    ds4_dec *d = ds4_dec_open(dir, "tester");
    if (!d) {
        fprintf(stderr, "ds4-agent tests: deciduous server not reachable; git graph tests skipped\n");
        unsetenv("DECIDUOUS_BRANCH");
        return;
    }
    goal_out = ds4_dec_bind_goal(d, "keep the graph and git in step");
    free(goal_out);
    AGENT_TEST_ASSERT(getenv("DS4_DEC_GOAL") && !strcmp(getenv("DS4_DEC_GOAL"), ds4_dec_goal_id(d)));

    /* A commit no node names is what the audit exists to find. */
    out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
    AGENT_TEST_ASSERT(out && strstr(out, "unlinked:") != NULL);
    AGENT_TEST_ASSERT(problems >= 1);
    free(out);

    /* A commit with no trailer and no goal given has nowhere to go. */
    AGENT_TEST_ASSERT(ds4_dec_git_link(d, NULL, "HEAD", err, sizeof(err)) == NULL);
    AGENT_TEST_ASSERT(strstr(err, "trailer") != NULL);

    /* Revisions reach a shell, so only what a revision can be gets that far. */
    AGENT_TEST_ASSERT(ds4_dec_git_link(d, "x", "HEAD;touch /tmp/ds4-pwned", err, sizeof(err)) == NULL);
    AGENT_TEST_ASSERT(strstr(err, "not a revision") != NULL);
    AGENT_TEST_ASSERT(ds4_dec_git_audit(d, "$(id)", &problems, err, sizeof(err)) == NULL);

    out = ds4_dec_git_link(d, ds4_dec_goal_id(d), "HEAD", err, sizeof(err));
    AGENT_TEST_ASSERT(out && strstr(out, "linked") != NULL);
    free(out);
    out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
    AGENT_TEST_ASSERT(out && strstr(out, "0 unlinked") != NULL);
    free(out);

    /* Rewriting history is what stales a hash. The old one is then reported as gone,
     * and repairing it moves the node to the new one. */
    FILE *p;
    snprintf(cmd, sizeof(cmd), "git -C %s rev-parse HEAD", dir);
    p = popen(cmd, "r");
    AGENT_TEST_ASSERT(p && fgets(old_sha, sizeof(old_sha), p));
    pclose(p);
    old_sha[strcspn(old_sha, "\n")] = '\0';
    GIT("cd %s && echo two >> a && git add a && git commit -q --amend --no-edit", dir);
    GIT("cd %s && git reflog expire --expire=now --all && git gc -q --prune=now", dir);
    out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
    AGENT_TEST_ASSERT(out && strstr(out, "stale:") != NULL);
    AGENT_TEST_ASSERT(strstr(out, old_sha) != NULL);
    free(out);

    out = ds4_dec_git_rewrite(d, old_sha, "HEAD", err, sizeof(err));
    AGENT_TEST_ASSERT(out && strstr(out, "in 1 node") != NULL);
    free(out);
    out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
    AGENT_TEST_ASSERT(out && problems == 0);
    free(out);

    /* A hash is only claimed after the word commit: bare hex in this graph's text is
     * mostly node id prefixes, and calling those stale would make the audit noise. */
    {
        const ds4_dec_arg gone[] = {{"title", "a claim about history"},
                                    {"description", "Commits abc1234, def5678. See a1b2c3d4, and "
                                                    "commit discipline for the directory (4931eb9d)."}};
        ds4_dec_call note = {.tool = "note", .args = gone, .argc = 2};
        out = ds4_dec_execute(d, &note, err, sizeof(err));
        AGENT_TEST_ASSERT(out != NULL);
        free(out);
        out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
        AGENT_TEST_ASSERT(out && strstr(out, "names abc1234") != NULL);
        AGENT_TEST_ASSERT(strstr(out, "names def5678") != NULL);
        AGENT_TEST_ASSERT(strstr(out, "a1b2c3d4") == NULL);
        AGENT_TEST_ASSERT(strstr(out, "4931eb9d") == NULL);
        free(out);

        /* About one short hash in twenty-seven is all digits, and rewriting a mention
         * can make one. It is still a hash, and the list goes on after it. */
        {
            const ds4_dec_arg digits[] = {{"title", "a claim in digits"},
                                          {"description", "Commits 7654321, fed8765."}};
            ds4_dec_call claim = {.tool = "note", .args = digits, .argc = 2};
            out = ds4_dec_execute(d, &claim, err, sizeof(err));
            AGENT_TEST_ASSERT(out != NULL);
            free(out);
            out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
            AGENT_TEST_ASSERT(out && strstr(out, "names 7654321") != NULL);
            AGENT_TEST_ASSERT(strstr(out, "names fed8765") != NULL);
            free(out);
        }

        /* A mention in text moves too, at the length it was written. */
        out = ds4_dec_git_rewrite(d, "abc1234", "HEAD", err, sizeof(err));
        AGENT_TEST_ASSERT(out && strstr(out, "in 1 node") != NULL);
        free(out);
        out = ds4_dec_git_audit(d, "HEAD", &problems, err, sizeof(err));
        AGENT_TEST_ASSERT(out && strstr(out, "abc1234") == NULL);
        AGENT_TEST_ASSERT(strstr(out, "names def5678") != NULL);
        free(out);
        out = ds4_dec_git_rewrite(d, "def5678", "HEAD", err, sizeof(err));
        free(out);
    }
#undef GIT
    ds4_dec_close(d);
    unsetenv("DS4_DEC_GOAL");
    unsetenv("DECIDUOUS_WORKSPACE");
    unsetenv("DECIDUOUS_BRANCH");
    snprintf(cmd, sizeof(cmd), "rm -rf %s", dir);
    AGENT_TEST_ASSERT(system(cmd) == 0);
}

static void test_deciduous_graph(void) {
    char dir[] = "/tmp/ds4-dec-XXXXXX";
    char saved[PATH_MAX], root[PATH_MAX], *res;
    char *digest, *brief, *closing, *refused;
    const char *goal_id;
    const char *note;
    agent_worker w = {0};
    agent_worker blind = {0};

    AGENT_TEST_ASSERT(getcwd(saved, sizeof(saved)) != NULL);
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    AGENT_TEST_ASSERT(chdir(dir) == 0);
    AGENT_TEST_ASSERT(system("git init -q . >/dev/null 2>&1") == 0);
    AGENT_TEST_ASSERT(ds4_dec_find_root(NULL, root, sizeof(root)));

    /* One workspace and one branch for every run of this test: recognisable, and
     * never mistaken for somebody's project. */
    setenv("DECIDUOUS_WORKSPACE", "ds4-selftest", 1);
    setenv("DECIDUOUS_BRANCH", "main", 1);

    w.dec = ds4_dec_open(root, "tester");
    if (!w.dec) {
        fprintf(stderr, "ds4-agent tests: deciduous server not reachable (%s); graph tests skipped\n",
                ds4_dec_open_error());
        AGENT_TEST_ASSERT(chdir(saved) == 0);
        return;
    }
    AGENT_TEST_ASSERT(ds4_dec_active(w.dec));

    /* A decision with nothing to be about is refused, and the refusal names the
     * way out: the graph stays honest only if every node hangs under a goal. */
    res = graph_call(&w, "decide", (const graph_kv[]){
        {"title", "which seam for the graph"}, {"chosen_option", "the server API"},
        {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "Tool error") && strstr(res, "op=goal"));
    free(res);

    /* The opening request becomes the goal node, on the server, and is held. */
    res = graph_call(&w, "goal", (const graph_kv[]){
        {"prompt", "make deciduous a core concept of the ds4 harness"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "Goal recorded on the server") != NULL);
    AGENT_TEST_ASSERT(strstr(res, "held by this session") != NULL);
    AGENT_TEST_ASSERT(ds4_dec_goal_bound(w.dec));
    goal_id = ds4_dec_goal_id(w.dec);
    AGENT_TEST_ASSERT(goal_id && strlen(goal_id) == 36 && strchr(goal_id, '-'));
    free(res);

    /* A session holds one goal: a second request says so instead of quietly
     * writing a second node beside the first. */
    res = graph_call(&w, "goal", (const graph_kv[]){
        {"prompt", "something else entirely"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "already holds") != NULL);
    free(res);

    /* A fact is attached to the goal it matters for, in one call. */
    res = graph_call(&w, "note", (const graph_kv[]){
        {"title", "the MCP endpoint answers plain JSON, not SSE"},
        {"description", "initialize and tools/call return application/json; the client "
                        "must dechunk it"},
        {"why", "the client would otherwise wait for an event stream that never comes"},
        {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "Observation recorded") != NULL);
    AGENT_TEST_ASSERT(strstr(res, "attached to the goal") != NULL);
    free(res);

    /* A real choice: the server makes the option nodes itself, so ds4 sends the
     * titles and gets back what it closed off. */
    res = graph_call(&w, "decide", (const graph_kv[]){
        {"title", "how ds4 reaches the graph"},
        {"chosen_option", "the server API over HTTP"},
        {"rejected_option", "the deciduous CLI with a local SQLite cache"},
        {"rationale", "the server holds every workspace in one Postgres and validates "
                      "arguments strictly; a local cache would fork the truth per machine"},
        {NULL, NULL}});
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    AGENT_TEST_ASSERT(strstr(res, "recorded as rejected") != NULL);
    free(res);

    res = graph_call(&w, "turn", (const graph_kv[]){
        {"summary", "the seam was moved onto the server API"},
        {"observation", "add_node is idempotent when a change_id is supplied"},
        {"outcome", "retries cannot leave duplicate nodes behind"},
        {NULL, NULL}});
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    free(res);

    /* Reading is a question, and an unanswered question is an honest answer. */
    res = graph_call(&w, "graph", (const graph_kv[]){
        {"question", "which option was rejected for reaching the graph"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    free(res);

    res = graph_call(&w, "graph", (const graph_kv[]){
        {"question", "zzqx nothing in this shape"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    free(res);

    /* The board: post as this session, then read it back with all=1. */
    res = graph_call(&w, "board", (const graph_kv[]){
        {"subject", "graph seam now writes through the API"},
        {"body", "deciduous is one tool with ops; nothing local is written"},
        {"why", "so sessions agree on where decisions live"},
        {NULL, NULL}});
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    AGENT_TEST_ASSERT(strstr(res, "Posted to the board as tester") != NULL);
    free(res);

    res = graph_call(&w, "board", (const graph_kv[]){{"all", "1"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(!strstr(res, "Tool error"));
    AGENT_TEST_ASSERT(strstr(res, "graph seam now writes through the API") != NULL);
    free(res);

    /* A half-posted message is not posted: the server would reject it anyway, and
     * ds4 says so before making the request. */
    res = graph_call(&w, "board", (const graph_kv[]){{"subject", "only a headline"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "Tool error") && strstr(res, "subject and body"));
    free(res);

    /* Moments, not provenance: the harness never writes for itself, it reminds. */
    res = graph_call(&w, "status", (const graph_kv[]){
        {"node_id", goal_id}, {"status", "active"}, {NULL, NULL}});
    free(res);
    note = ds4_dec_note_result(w.dec, "edit", "ds4_agent.c",
                               "Tool result 1 (edit): Edited ds4_agent.c\n", -1);
    AGENT_TEST_ASSERT(note != NULL && strstr(note, "fork in the road") != NULL);
    {
        const char *again = ds4_dec_note_result(w.dec, "edit", "ds4_agent.c",
                                                "Tool result 1 (edit): Edited again\n", -1);
        AGENT_TEST_ASSERT(again == NULL);
    }
    note = ds4_dec_note_result(w.dec, "bash", "make ds4_agent_test",
                               "bash job=1 pid=1 status=done\nexit_status=0\n", 0);
    AGENT_TEST_ASSERT(note != NULL && strstr(note, "op=turn") != NULL);
    note = ds4_dec_note_result(w.dec, "bash", "make test",
                               "bash job=2 pid=2 status=done\nexit_status=2\n", 2);
    AGENT_TEST_ASSERT(note == NULL);
    note = ds4_dec_note_result(w.dec, "read", "ds4_agent.c", "read 40 lines\n", -1);
    AGENT_TEST_ASSERT(note == NULL);

    /* Compaction replaces the transcript; the graph keeps what mattered. */
    digest = ds4_dec_compaction_digest(w.dec);
    AGENT_TEST_ASSERT(digest && strstr(digest, "ds4-selftest") != NULL);
    AGENT_TEST_ASSERT(strstr(digest, "Goal held by this session:") != NULL);
    free(digest);

    note = ds4_dec_recovery_note(w.dec);
    AGENT_TEST_ASSERT(note && strstr(note, "holds the goal") != NULL);

    /* What the graph already holds is shown before the session acts, not after
     * it wonders: the briefing names the goal, the decisions under it, and where
     * an answer was already rejected. */
    brief = ds4_dec_briefing(w.dec);
    AGENT_TEST_ASSERT(brief && strstr(brief, "What the graph already holds") != NULL);
    AGENT_TEST_ASSERT(strstr(brief, "make deciduous a core concept") != NULL);
    AGENT_TEST_ASSERT(strstr(brief, "how ds4 reaches the graph") != NULL);
    AGENT_TEST_ASSERT(strstr(brief, "Ask op=graph") != NULL);
    free(brief);

    /* Nothing to brief and nothing to post: a handle that wrote no moment has no
     * news, and silence is what it owes the workspace. */
    {
        ds4_dec *quiet = ds4_dec_open(root, "quiet");
        AGENT_TEST_ASSERT(quiet != NULL);
        AGENT_TEST_ASSERT(ds4_dec_briefing(quiet) == NULL);
        AGENT_TEST_ASSERT(ds4_dec_close_session(quiet) == NULL);
        ds4_dec_close(quiet);
    }

    /* The other agents hear what this session decided, once, because it recorded
     * moments; the headline names the goal so they can find the reasoning. */
    closing = ds4_dec_close_session(w.dec);
    AGENT_TEST_ASSERT(closing && strstr(closing, "closing note posted") != NULL);
    AGENT_TEST_ASSERT(strstr(closing, "make deciduous a core concept") != NULL);
    AGENT_TEST_ASSERT(strstr(closing, "1 decision, 1 step, 1 note") != NULL);
    res = graph_call(&w, "board", (const graph_kv[]){{"all", "1"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "1 decision, 1 step, 1 note") != NULL);
    free(res);
    free(closing);
    /* The same session posts again only after writing again. */
    AGENT_TEST_ASSERT(ds4_dec_close_session(w.dec) == NULL);

    /* A new session in the same workspace should claim the goal that exists rather
     * than write a duplicate beside it: release names it, and op=status claims it. */
    char held_goal[64];
    snprintf(held_goal, sizeof(held_goal), "%s", goal_id);
    goal_id = held_goal;
    ds4_dec_release_goal(w.dec);
    AGENT_TEST_ASSERT(!ds4_dec_goal_bound(w.dec));
    AGENT_TEST_ASSERT(ds4_dec_goal_id(w.dec) == NULL);
    {
        const char *released = ds4_dec_recovery_note(w.dec);
        AGENT_TEST_ASSERT(released && strstr(released, "has not claimed it") != NULL);
        AGENT_TEST_ASSERT(strstr(released, goal_id) != NULL);

        /* Released means released: after /new nothing files under the old goal. */
        res = graph_call(&w, "note", (const graph_kv[]){
            {"title", "must not land under the old goal"}, {"description", "x"}, {NULL, NULL}});
        AGENT_TEST_ASSERT(strstr(res, "no goal is bound") != NULL);
        free(res);

        agent_worker second = {0};
        char *claim;
        second.dec = ds4_dec_open(root, "second");
        AGENT_TEST_ASSERT(ds4_dec_active(second.dec));
        AGENT_TEST_ASSERT(!ds4_dec_goal_bound(second.dec));
        /* A session with no goal has no subtree to be briefed about. */
        AGENT_TEST_ASSERT(ds4_dec_briefing(second.dec) == NULL);
        claim = graph_call(&second, "status", (const graph_kv[]){
            {"node_id", goal_id}, {"status", "active"}, {NULL, NULL}});
        AGENT_TEST_ASSERT(strstr(claim, "is now this session's bound goal") != NULL);
        AGENT_TEST_ASSERT(ds4_dec_goal_bound(second.dec));
        free(claim);

        /* Moving a goal to a finished state is not picking it up. */
        {
            ds4_dec *third = ds4_dec_open(root, "third");
            AGENT_TEST_ASSERT(third != NULL);
            agent_worker holder = {0};
            holder.dec = third;
            claim = graph_call(&holder, "status", (const graph_kv[]){
                {"node_id", goal_id}, {"status", "pending"}, {NULL, NULL}});
            AGENT_TEST_ASSERT(strstr(claim, "bound goal") == NULL);
            AGENT_TEST_ASSERT(!ds4_dec_goal_bound(third));
            free(claim);
            ds4_dec_close(third);
        }

        /* Finishing a goal belongs to the operator alone: ds4 never decides a goal
         * is done, and a handle that holds no goal has nothing to finish. */
        refused = ds4_dec_mark_goal_done(w.dec);
        AGENT_TEST_ASSERT(refused != NULL && strstr(refused, "no goal is bound") != NULL);
        free(refused);

        /* The server's vocabulary for writing a status is pending, active,
         * completed, rejected, superseded, abandoned.  The deciduous CLI help
         * prints "done" and "parked", and the server accepts neither for a
         * write - it even lists a "done" filter for reads that can never match
         * anything.  ds4 says completed, and when the server refuses a write it
         * says so in its own words rather than retrying a guess. */
        res = graph_call(&second, "status", (const graph_kv[]){
            {"node_id", goal_id}, {"status", "done"}, {NULL, NULL}});
        AGENT_TEST_ASSERT(strstr(res, "status must be one of") != NULL);
        AGENT_TEST_ASSERT(strstr(res, "completed") != NULL);
        AGENT_TEST_ASSERT(strstr(res, "The graph did not record this") != NULL);
        free(res);

        closing = ds4_dec_mark_goal_done(second.dec);
        AGENT_TEST_ASSERT(closing != NULL &&
                          strstr(closing, "goal completed on the server") != NULL);
        AGENT_TEST_ASSERT(strstr(closing, "make deciduous a core concept") != NULL);
        /* The server echoes the status it stored; that is the proof, not ds4's
         * own wording. */
        AGENT_TEST_ASSERT(strstr(closing, "(now completed)") != NULL);
        free(closing);
        ds4_dec_close(second.dec);
    }

    /* A released session takes the next request as a goal of its own, and the
     * goal it let go of stops being offered. */
    {
        char *fresh = ds4_dec_bind_goal(w.dec, "how ds4 reaches the graph after /new");
        AGENT_TEST_ASSERT(fresh && strstr(fresh, "Goal recorded") != NULL);
        free(fresh);
        AGENT_TEST_ASSERT(ds4_dec_goal_bound(w.dec));
        AGENT_TEST_ASSERT(strcmp(ds4_dec_goal_id(w.dec), held_goal) != 0);
        note = ds4_dec_recovery_note(w.dec);
        AGENT_TEST_ASSERT(note && strstr(note, "holds the goal") != NULL);

        /* A new goal has nothing under it, which is when a model is likeliest to
         * decide again what earlier work settled: the briefing goes and looks. */
        brief = ds4_dec_briefing(w.dec);
        AGENT_TEST_ASSERT(brief && strstr(brief, "Decided in earlier work") != NULL);
        AGENT_TEST_ASSERT(strstr(brief, "how ds4 reaches the graph") != NULL);
        free(brief);

        /* Message numbers go out as numbers and come back as numbers. */
        res = graph_call(&w, "board", (const graph_kv[]){
            {"subject", "numbered"}, {"body", "first"}, {NULL, NULL}});
        const char *posted = strstr(res, "message #");
        AGENT_TEST_ASSERT(posted != NULL);
        char number[32];
        snprintf(number, sizeof(number), "%ld", posted ? strtol(posted + 9, NULL, 10) : 0);
        free(res);
        res = graph_call(&w, "board", (const graph_kv[]){
            {"subject", "answered"}, {"body", "second"}, {"reply_to", number}, {NULL, NULL}});
        AGENT_TEST_ASSERT(strstr(res, "Posted to the board") != NULL);
        free(res);
        res = graph_call(&w, "board", (const graph_kv[]){{"all", "1"}, {NULL, NULL}});
        AGENT_TEST_ASSERT(strstr(res, "(reply to #") != NULL);
        free(res);
    }

    /* The op is what selects the server tool, so a bad one is named back. */
    res = graph_call(&w, "nonsense", (const graph_kv[]){{"title", "x"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "Tool error") && strstr(res, "has no op") != NULL);
    free(res);
    res = graph_call(&w, NULL, (const graph_kv[]){{"title", "x"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "Tool error") && strstr(res, "op=decide") != NULL);
    free(res);

    /* Auto-binding the opening request as the goal is the default, but only for
     * text that carries intent: a slash command or "hi" is not a goal. */
    AGENT_TEST_ASSERT(!agent_text_is_goal_worthy(NULL));
    AGENT_TEST_ASSERT(!agent_text_is_goal_worthy("hi"));
    AGENT_TEST_ASSERT(!agent_text_is_goal_worthy("/new"));
    AGENT_TEST_ASSERT(!agent_text_is_goal_worthy("short text"));
    AGENT_TEST_ASSERT(agent_text_is_goal_worthy("fix the compaction boundary bug"));

    /* Without a live server the tool explains itself instead of writing. */
    res = graph_call(&blind, "graph", (const graph_kv[]){{"question", "what was decided"}, {NULL, NULL}});
    AGENT_TEST_ASSERT(strstr(res, "no decision graph is open") != NULL);
    free(res);

    ds4_dec_close(w.dec);
    w.dec = NULL;
    AGENT_TEST_ASSERT(chdir(saved) == 0);
}

/* Model-free real-PTY driver for tests/ds4_agent_terminal_test.py. */
static int test_terminal_driver(void) {
    agent_editor ed = {0};
    linenoiseSetMultiLine(1);
    if (editor_start(&ed, "ds4-agent> ", "ready", NULL)) return 2;
    double start = now_sec(), next = start;
    char *answer = NULL;
    unsigned tick = 0;
    while (now_sec() - start < 10 && !answer) {
        struct pollfd pfd = {.fd = STDIN_FILENO, .events = POLLIN};
        poll(&pfd, 1, 10);
        if (pfd.revents & POLLIN) editor_read_stdin(&ed);
        while (linenoiseEditQueuedInput(&ed.edit)) {
            char *line = linenoiseEditFeed(&ed.edit);
            if (line == linenoiseEditMore) continue;
            if (line) answer = line;
            else answer = xstrdup("<input error>");
            break;
        }
        if (now_sec() >= next) {
            char status[80];
            snprintf(status, sizeof(status), "generation %u", ++tick);
            if (tick % 4 == 0) {
                const char output[] = "model output \xe4\xb8\xad\n";
                editor_write_async(&ed, output, sizeof(output) - 1, "ds4-agent> ", status, false);
            } else editor_set_prompt_status(&ed, "ds4-agent> ", status);
            next = now_sec() + 0.05;
        }
    }
    editor_stop(&ed);
    editor_restore_terminal_layout(&ed);
    if (!answer) return 3;
    printf("\nRESULT:");
    for (size_t i = 0; i < strlen(answer); i++) printf("%02x", (unsigned char)answer[i]);
    puts("");
    free(answer);
    return 0;
}

static void test_observation_error_is_not_context_exhaustion(void) {
    agent_worker worker = {0};
    ds4_tokens_push(&worker.transcript, 42);
    agent_tool_observation observation;
    agent_tool_observation_init(&observation);
    agent_tool_observation_puts(&observation, "image result");
    ds4_vision_embedding invalid = {0};
    agent_tool_observation_add_image(&observation, &invalid);
    char err[160] = {0};
    int count = -1;
    AGENT_TEST_ASSERT(agent_tool_observation_fits(&worker, &observation, 16,
                                                 &count, err, sizeof(err)) == -1);
    AGENT_TEST_ASSERT(strstr(err, "invalid image observation") != NULL);
    AGENT_TEST_ASSERT(count == -1);
    AGENT_TEST_ASSERT(worker.transcript.len == 1 && worker.transcript.v[0] == 42);
    agent_tool_observation_free(&observation);
    ds4_tokens_free(&worker.transcript);
}

static void test_compaction_boundaries(void) {
    agent_dsml_parser parser = {.state = AGENT_DSML_SEARCH};
    agent_stream_renderer stream = {.parser = &parser};
    AGENT_TEST_ASSERT(!agent_stream_compaction_needs_lookahead(&stream));
    stream.pending_len = 1;
    AGENT_TEST_ASSERT(agent_stream_compaction_needs_lookahead(&stream));
    stream.pending_len = 0;
    stream.dsml_start_len = 1;
    AGENT_TEST_ASSERT(agent_stream_compaction_needs_lookahead(&stream));
    stream.dsml_active = true;
    AGENT_TEST_ASSERT(!agent_stream_compaction_needs_lookahead(&stream));
    stream.dsml_active = false;
    parser.state = AGENT_DSML_PARAM_VALUE;
    AGENT_TEST_ASSERT(!agent_stream_compaction_needs_lookahead(&stream));
    int data[1000] = {0};
    ds4_tokens tokens = {.v = data, .len = 1000};
    AGENT_TEST_ASSERT(agent_compact_tail_boundary(&tokens, 1000, 100, 100, 42) == 900);
    data[850] = 42;
    AGENT_TEST_ASSERT(agent_compact_tail_boundary(&tokens, 1000, 100, 100, 42) == 850);
    data[950] = 42;
    AGENT_TEST_ASSERT(agent_compact_tail_boundary(&tokens, 1000, 100, 100, 42) == 950);
    data[850] = data[950] = 0;
    data[799] = 42;
    AGENT_TEST_ASSERT(agent_compact_tail_boundary(&tokens, 1000, 100, 100, 42) == 900);
    AGENT_TEST_ASSERT(agent_compact_tail_boundary(&tokens, 150, 100, 100, 42) == 100);
    AGENT_TEST_ASSERT(agent_compact_tail_boundary(&tokens, 1000, 100, 100, -1) == 900);
    AGENT_TEST_ASSERT(agent_compact_summary_budget(4096) == 512);
    AGENT_TEST_ASSERT(agent_compact_summary_budget(100000) == 4096);
    AGENT_TEST_ASSERT(agent_compact_summary_budget(1024) == 256);
    ds4_vision_span spans[2] = {
        {.token_start = 100, .embedding = {.token_count = 50}},
        {.token_start = 200, .embedding = {.token_count = 30}},
    };
    for (int glm = 0; glm <= 1; glm++) {
        for (int pos = 0; pos < 260; pos++) {
            int expected = pos;
            for (size_t i = 0; i < 2; i++) {
                int start = (int)spans[i].token_start - glm;
                int end = (int)(spans[i].token_start + spans[i].embedding.token_count) + glm;
                if (pos > start && pos < end) expected = start;
            }
            AGENT_TEST_ASSERT(agent_compact_image_boundary(spans, 2, glm, pos) == expected);
        }
    }
    AGENT_TEST_ASSERT(agent_compact_image_boundary(NULL, 0, false, 77) == 77);
}

static int test_v41_thinking(const char *model) {
    ds4_engine_options opt = {.model_path = model, .backend = DS4_BACKEND_METAL,
        .ssd_streaming = true, .ssd_streaming_cache_experts = 512,
        .context_size = 256, .power_percent = 100};
    agent_config cfg = {.gen = {.ctx_size = 256, .think_mode = DS4_THINK_HIGH}};
    agent_worker w = {.cfg = &cfg, .initialized = true,
        .wake_fd = {-1, -1}, .status = {.state = AGENT_WORKER_IDLE}};
    pthread_mutex_init(&w.mu, NULL);
    AGENT_TEST_ASSERT(ds4_engine_open(&w.engine, &opt) == 0);
    if (!w.engine) return 1;
    AGENT_TEST_ASSERT(ds4_session_create(&w.session, w.engine, 256) == 0);
    if (!w.session) { ds4_engine_close(w.engine); return 1; }
    /* Simulate a restored session whose effort differs from the CLI default. */
    agent_numeric_think_prefix(w.engine, DS4_THINK_MAX, &w.transcript);
    ds4_tokens suffix = {0};
    ds4_tokenize_text(w.engine, "System text.\n\n", &suffix);
    ds4_chat_append_message(w.engine, &suffix, "user", "Hello");
    ds4_chat_append_message(w.engine, &suffix, "assistant", "Hello again.");
    const int first_image_offset = w.transcript.len;
    for (int i = 0; i < suffix.len; i++) ds4_tokens_push(&w.transcript, suffix.v[i]);
    w.images = calloc(1, sizeof(*w.images));
    w.image_count = 1;
    w.images[0].token_start = (uint32_t)first_image_offset;
    const int levels[] = {25, 0, 100, 1, 75, 75, 0};
    for (size_t i = 0; i < sizeof(levels) / sizeof(*levels); i++) {
        char err[160] = {0};
        AGENT_TEST_ASSERT(ds4_session_sync(w.session, &w.transcript, err, sizeof(err)) == 0);
        const int before = w.transcript.len;
        w.requested_think = (ds4_think_mode)(DS4_THINK_LEVEL_BASE + levels[i]);
        const bool changed = effective_think_mode(&cfg) != w.requested_think;
        w.think_requested = true;
        AGENT_TEST_ASSERT(!worker_is_idle(&w));
        AGENT_TEST_ASSERT(!worker_submit(&w, "must wait"));
        worker_apply_requested_think(&w);
        AGENT_TEST_ASSERT(worker_is_idle(&w));
        AGENT_TEST_ASSERT(ds4_session_pos(w.session) == (changed ? 0 : before));
        ds4_tokens expected = {0};
        agent_numeric_think_prefix(w.engine, w.requested_think, &expected);
        AGENT_TEST_ASSERT(w.images[0].token_start == (uint32_t)expected.len);
        for (int j = 0; j < suffix.len; j++) ds4_tokens_push(&expected, suffix.v[j]);
        AGENT_TEST_ASSERT(w.transcript.len == expected.len &&
                           ds4_tokens_starts_with(&w.transcript, &expected));
        ds4_tokens_free(&expected);
    }
    cfg.gen.raw_prompt = true;
    w.requested_think = DS4_THINK_MAX;
    worker_apply_requested_think(&w);
    AGENT_TEST_ASSERT(ds4_think_mode_level(cfg.gen.think_mode) == 0);
    AGENT_TEST_ASSERT(strstr(w.out, "requires a V4.1 chat session"));
    cfg.gen.raw_prompt = false;
    while (w.transcript.len < 250) ds4_tokens_push(&w.transcript, ds4_token_eos(w.engine));
    worker_apply_requested_think(&w);
    AGENT_TEST_ASSERT(ds4_think_mode_level(cfg.gen.think_mode) == 0 && w.transcript.len == 250);
    AGENT_TEST_ASSERT(strstr(w.out, "no context room"));
    free(w.out); free(w.images);
    ds4_tokens_free(&suffix); ds4_tokens_free(&w.transcript);
    ds4_session_free(w.session); ds4_engine_close(w.engine);
    pthread_mutex_destroy(&w.mu);
    puts("V4.1 agent thinking levels, restored prefix, cache invalidation: done");
    return agent_test_failures ? 1 : 0;
}

static void test_qwen_tool_syntax(void) {
    const char text[] =
        "<think>Plan.</think>\n<tool_call>\n<function=list>\n"
        "<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>";
    for (size_t split = 0; split < sizeof(text); split++) {
        char *first = xstrndup(text, split);
        const char *chunks[] = {first, text + split};
        agent_dsml_parser p;
        char *out = agent_test_stream_capture(AGENT_TOOL_SYNTAX_QWEN, chunks, 2, &p, NULL);
        AGENT_TEST_ASSERT(p.state == AGENT_DSML_DONE && p.calls.len == 1);
        if (p.calls.len == 1) AGENT_TEST_ASSERT(!strcmp(p.calls.v[0].name, "list"));
        free(first);
        free(out);
        agent_dsml_parser_free(&p);
    }
    AGENT_TEST_ASSERT(agent_syntax_is_xml_tool_call(AGENT_TOOL_SYNTAX_QWEN));
    AGENT_TEST_ASSERT(agent_syntax_is_xml_tool_call(AGENT_TOOL_SYNTAX_GLM));
    AGENT_TEST_ASSERT(!agent_syntax_is_xml_tool_call(AGENT_TOOL_SYNTAX_DSML41));
    AGENT_TEST_ASSERT(!agent_syntax_is_xml_tool_call(AGENT_TOOL_SYNTAX_DSML));
}

static void test_v41_tool_syntax(void) {
    const char text[] =
        "<think>Plan.</think>\n\n<｜DSML｜ calls>\n"
        "<｜DSML｜ invoke name=\"write\">\n"
        "<｜DSML｜ parameter name=\"path\" string=\"true\">a.txt</｜DSML｜ parameter>\n"
        "<｜DSML｜ parameter name=\"content\" string=\"true\">x </think> "
        "&lt;/｜DSML｜ parameter> &amp;lt;/｜DSML｜ parameter></｜DSML｜ parameter>\n"
        "</｜DSML｜ invoke>\n<｜DSML｜ invoke name=\"list\">\n"
        "<｜DSML｜ parameter name=\"path\" string=\"true\">.</｜DSML｜ parameter>\n"
        "</｜DSML｜ invoke>\n</｜DSML｜ calls>";
    const char expected[] = "x </think> </｜DSML｜ parameter> &lt;/｜DSML｜ parameter>";
    for (size_t split = 0; split < sizeof(text); split++) {
        char *first = xstrndup(text, split);
        const char *chunks[] = {first, text + split};
        agent_dsml_parser p;
        char *out = agent_test_stream_capture(AGENT_TOOL_SYNTAX_DSML41, chunks, 2, &p, NULL);
        AGENT_TEST_ASSERT(p.state == AGENT_DSML_DONE && p.calls.len == 2);
        if (p.state != AGENT_DSML_DONE || p.calls.len != 2) {
            fprintf(stderr, "V4.1 split=%zu state=%d calls=%d error=%s raw=%s\n",
                    split, p.state, p.calls.len, p.error, p.raw ? p.raw : "(none)");
            free(first); free(out); agent_dsml_parser_free(&p);
            break;
        }
        if (p.calls.len == 2) {
            AGENT_TEST_ASSERT(!strcmp(p.calls.v[0].name, "write"));
            AGENT_TEST_ASSERT(!strcmp(agent_tool_arg_value(&p.calls.v[0], "path"), "a.txt"));
            AGENT_TEST_ASSERT(!strcmp(agent_tool_arg_value(&p.calls.v[0], "content"), expected));
            AGENT_TEST_ASSERT(!strcmp(p.calls.v[1].name, "list"));
        }
        AGENT_TEST_ASSERT(!strstr(out, "<｜DSML｜ calls>"));
        AGENT_TEST_ASSERT(p.raw && strstr(p.raw, "<｜DSML｜ calls>") == p.raw);
        free(first); free(out); agent_dsml_parser_free(&p);
    }
    const char *inside[] = {"<think><｜DSML｜ calls><｜DSML｜ invoke name=\"list\">"
        "</｜DSML｜ invoke></｜DSML｜ calls></think>Done"};
    agent_dsml_parser p;
    bool early = false;
    char *out = agent_test_stream_capture(AGENT_TOOL_SYNTAX_DSML41, inside, 1, &p, &early);
    AGENT_TEST_ASSERT(early && p.calls.len == 0 && strstr(out, "tool call ignored"));
    free(out); agent_dsml_parser_free(&p);
    for (int upto = 0; upto < 2; upto++) {
        char *old = agent_build_dsml_tools_prompt(upto, false);
        char *prompt = agent_dsml41_tools_prompt(old);
        AGENT_TEST_ASSERT(strstr(prompt, "<｜DSML｜ calls>"));
        AGENT_TEST_ASSERT(strstr(prompt, "&amp;lt;/｜DSML｜ parameter>"));
        AGENT_TEST_ASSERT(!strstr(prompt, "｜DSML｜tool_calls") &&
                           !strstr(prompt, "｜DSML｜invoke") &&
                           !strstr(prompt, "｜DSML｜parameter"));
        free(old); free(prompt);
    }
}

/* Model-backed regression: save an unsynchronizable transcript, then rebuild
 * it in a larger context using the normal stripped-session loader. */
static int test_full_context_save(const char *model) {
    ds4_engine_options opt = {.model_path = model, .backend = default_backend(),
        .context_size = 512, .power_percent = 100};
    agent_config cfg = {.gen = {.ctx_size = 256}, .non_interactive = true};
    agent_worker w = {.cfg = &cfg, .initialized = true, .user_activity = true,
        .wake_fd = {-1, -1}, .status = {.state = AGENT_WORKER_IDLE}};
    pthread_mutex_init(&w.mu, NULL);
    char dir[] = "/tmp/ds4-agent-full-save-XXXXXX";
    AGENT_TEST_ASSERT(mkdtemp(dir) != NULL);
    w.cache_dir = dir;
    w.session_title = xstrdup("Full transcript recovery");
    w.session_created_at = 123456;
    AGENT_TEST_ASSERT(ds4_engine_open(&w.engine, &opt) == 0);
    if (!w.engine) return 1;
    ds4_tokens complete = {0};
    ds4_chat_begin(w.engine, &complete);
    for (int i = 0; i < 60; i++)
        ds4_chat_append_message(w.engine, &complete, "user", "Explain the colors of a rainbow.");
    AGENT_TEST_ASSERT(complete.len > 257);
    for (int length = 256; length <= 257; length++) {
        AGENT_TEST_ASSERT(ds4_session_create(&w.session, w.engine, 256) == 0);
        if (!w.session) break;
        ds4_tokens slice = complete;
        slice.len = length;
        ds4_tokens_copy(&w.transcript, &slice);
        w.session_dirty = true;
        char err[256] = {0}, sha[41];
        int saved_tokens = 0;
        AGENT_TEST_ASSERT(agent_worker_save_session_now(&w, sha, &saved_tokens, err, sizeof(err)));
        AGENT_TEST_ASSERT(saved_tokens == length && !w.session_dirty);
        AGENT_TEST_ASSERT(ds4_session_pos(w.session) == 0);
        char *path = agent_kv_path_for_sha(dir, sha);
        FILE *fp = fopen(path, "rb");
        AGENT_TEST_ASSERT(fp != NULL);
        if (!fp) { free(path); ds4_session_free(w.session); w.session = NULL; break; }
        ds4_kvstore_entry hdr = {0};
        uint32_t text_bytes = 0;
        AGENT_TEST_ASSERT(ds4_kvstore_read_header(fp, &hdr, &text_bytes));
        AGENT_TEST_ASSERT(hdr.payload_bytes == 0 && hdr.tokens == (uint32_t)length);
        char *text = NULL, *title = NULL;
        AGENT_TEST_ASSERT(agent_kv_read_text(fp, text_bytes, &text, err, sizeof(err)));
        AGENT_TEST_ASSERT(agent_kv_read_title_trailer(fp, &hdr, &title, err, sizeof(err)));
        AGENT_TEST_ASSERT(title && !strcmp(title, w.session_title));
        fclose(fp);
        size_t expected_len = 0;
        char *expected = ds4_kvstore_render_tokens_text(w.engine, &w.transcript, &expected_len);
        AGENT_TEST_ASSERT(text && expected && text_bytes == expected_len && !strcmp(text, expected));
        free(expected); free(text); free(title);
        ds4_session_free(w.session);
        w.session = NULL;
        AGENT_TEST_ASSERT(ds4_session_create(&w.session, w.engine, 512) == 0);
        cfg.gen.ctx_size = 512;
        ds4_tokens restored = {0};
        agent_kv_session_meta meta = {0};
        AGENT_TEST_ASSERT(agent_kv_load_path(&w, path, sha, NULL, 0, &restored, &meta, err, sizeof(err)));
        AGENT_TEST_ASSERT(agent_tokens_equal(&w.transcript, &restored));
        AGENT_TEST_ASSERT(meta.created_at == w.session_created_at && meta.title && !strcmp(meta.title, w.session_title));
        ds4_token_score score;
        AGENT_TEST_ASSERT(ds4_session_top_logprobs(w.session, &score, 1) == 1);
        agent_kv_session_meta_free(&meta);
        ds4_tokens_free(&restored);
        ds4_tokens_free(&w.transcript);
        ds4_session_free(w.session); w.session = NULL;
        cfg.gen.ctx_size = 256;
        unlink(path); free(path);
    }
    ds4_tokens_free(&complete);
    ds4_engine_close(w.engine);
    free(w.session_title);
    pthread_mutex_destroy(&w.mu);
    rmdir(dir);
    return agent_test_failures ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "--full-context-save")) return test_full_context_save(argv[2]);
    if (argc == 3 && !strcmp(argv[1], "--think-fixture")) return test_v41_thinking(argv[2]);
    if (argc == 2 && !strcmp(argv[1], "--terminal-driver")) return test_terminal_driver();
    if (argc == 3 && !strcmp(argv[1], "--terminal-fixtures")) test_output_dir = argv[2];
    char *options[] = {"ds4-agent", "--model", "qwen.gguf",
                    "--vision", "mmproj.gguf", "--non-interactive", "-p", "test"};
    agent_config cfg = parse_options((int)(sizeof(options) / sizeof(options[0])), options);
    AGENT_TEST_ASSERT(cfg.engine.vision_path && !strcmp(cfg.engine.vision_path, "mmproj.gguf"));
    AGENT_TEST_ASSERT(cfg.engine.model_path && !strcmp(cfg.engine.model_path, "qwen.gguf"));
    {
        char *goptions[] = {"ds4-agent", "--model", "qwen.gguf", "--goal", "ship the POC",
                            "--label", "coworker", "--graph", "off", "--non-interactive",
                            "-p", "test"};
        char *boptions[] = {"ds4-agent", "--model", "qwen.gguf", "--graph", "on",
                            "--non-interactive", "-p", "test"};
        agent_config gcfg = parse_options((int)(sizeof(goptions) / sizeof(goptions[0])), goptions);
        agent_config bcfg = parse_options((int)(sizeof(boptions) / sizeof(boptions[0])), boptions);
        AGENT_TEST_ASSERT(gcfg.goal && !strcmp(gcfg.goal, "ship the POC"));
        AGENT_TEST_ASSERT(gcfg.dec_label && !strcmp(gcfg.dec_label, "coworker"));
        AGENT_TEST_ASSERT(gcfg.graph_off);
        AGENT_TEST_ASSERT(!bcfg.graph_off);
    }
    ds4_agent_unit_tests_run();
    test_permission_answers();
    test_v41_tool_syntax();
    test_qwen_tool_syntax();
    test_compaction_boundaries();
    test_observation_error_is_not_context_exhaustion();
    test_atomic_file_tools();
    test_streaming_file_tools();
    test_shell_spawn();
    test_background_jobs();
    test_fragmented_terminal_input();
    test_shell_terminal_controls();
    test_markdown_literals();
    test_hint_rendering();
    test_unicode_output_and_footer();
    test_footer_only_updates();
    test_tool_contracts();
    test_hooks_engine();
    test_permissions();
    test_permissions_refuse_a_tool();
    test_undo();
    test_prompt_input();
    test_output_descriptions();
    test_todo_and_edit_all();
    test_deciduous_git();
    test_deciduous_server_choice();
    test_deciduous_seam_failures();
    test_deciduous_graph();
    if (agent_test_failures) {
        fprintf(stderr, "ds4-agent tests: %d failure(s)\n",
                agent_test_failures);
        return 1;
    }
    puts("ds4-agent tests: ok");
    return 0;
}
