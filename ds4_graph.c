/* ds4-graph: the decision graph's side of git. Git hooks call this because they have
 * to be quick and ds4-agent loads a model; the logic is in ds4_deciduous.c, shared with
 * the agent's op=audit, so there is one answer to whether the graph and git agree. */

#include "ds4_deciduous.h"

#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define ZERO_SHA "0000000000000000000000000000000000000000"

static int usage(void) {
    fputs("usage: ds4-graph audit [RANGE]\n"
          "       ds4-graph goal TEXT\n"
          "       ds4-graph link GOAL_ID REV|RANGE\n"
          "       ds4-graph rewrite OLD_HASH NEW_HASH\n"
          "       ds4-graph install\n"
          "       ds4-graph hook commit-msg FILE | post-commit | post-rewrite | pre-push\n", stderr);
    return 2;
}

static ds4_dec *open_graph(void) {
    char root[PATH_MAX];
    if (!ds4_dec_find_root(NULL, root, sizeof(root))) return NULL;
    return ds4_dec_open(root, "ds4-git");
}

/* The goal an agent session exports is stamped on the commit, as a trailer because
 * that is the one thing about a commit that survives being rewritten. A commit made
 * by hand has none and says so here, rather than at the push that refuses it. */
static int hook_commit_msg(const char *file) {
    char cmd[PATH_MAX + 200], line[256];
    const char *goal = getenv("DS4_DEC_GOAL");
    FILE *f = fopen(file, "r");
    bool stamped = false;
    if (f) {
        while (fgets(line, sizeof(line), f))
            if (!strncmp(line, DS4_DEC_GOAL_TRAILER ":", strlen(DS4_DEC_GOAL_TRAILER) + 1)) stamped = true;
        fclose(f);
    }
    if (stamped) return 0;
    if (!goal || !goal[0]) {
        fputs("ds4-graph: this commit names no goal. Set DS4_DEC_GOAL, or add a "
              DS4_DEC_GOAL_TRAILER ": trailer, or a push will refuse it.\n", stderr);
        return 0;
    }
    for (const char *c = goal; *c; c++) {
        if (!isxdigit((unsigned char)*c) && *c != '-') {
            fputs("ds4-graph: DS4_DEC_GOAL is not a node id\n", stderr);
            return 1;
        }
    }
    if (strchr(file, '\'')) return 0;
    snprintf(cmd, sizeof(cmd), "git interpret-trailers --in-place --if-exists doNothing "
                               "--trailer '" DS4_DEC_GOAL_TRAILER ": %s' '%s'", goal, file);
    return system(cmd) == 0 ? 0 : 1;
}

/* A commit is already made when this runs, so a graph that cannot be reached is
 * reported and nothing more: the push is where it counts. */
static int hook_post_commit(void) {
    char err[512] = {0};
    ds4_dec *d = open_graph();
    if (!d) {
        fprintf(stderr, "ds4-graph: commit not linked: %s\n", ds4_dec_open_error());
        return 0;
    }
    char *out = ds4_dec_git_link(d, NULL, "HEAD", err, sizeof(err));
    if (out) printf("ds4-graph: %s\n", out);
    else fprintf(stderr, "ds4-graph: commit not linked: %s\n", err);
    free(out);
    ds4_dec_close(d);
    return 0;
}

static int hook_post_rewrite(void) {
    char line[256], old_sha[64], new_sha[64], err[512] = {0};
    ds4_dec *d = open_graph();
    if (!d) {
        fprintf(stderr, "ds4-graph: hashes not updated, run ds4-graph rewrite by hand: %s\n",
                ds4_dec_open_error());
        return 0;
    }
    while (fgets(line, sizeof(line), stdin)) {
        if (sscanf(line, "%63s %63s", old_sha, new_sha) != 2) continue;
        char *out = ds4_dec_git_rewrite(d, old_sha, new_sha, err, sizeof(err));
        if (out) printf("ds4-graph: %s\n", out);
        else fprintf(stderr, "ds4-graph: %s not updated: %s\n", old_sha, err);
        free(out);
    }
    ds4_dec_close(d);
    return 0;
}

static int run_audit(ds4_dec *d, const char *range) {
    char err[512] = {0};
    int problems = 0;
    char *report = ds4_dec_git_audit(d, range, &problems, err, sizeof(err));
    if (!report) {
        fprintf(stderr, "ds4-graph: audit could not run: %s\n", err);
        return 2;
    }
    fputs(report, problems ? stderr : stdout);
    free(report);
    return problems ? 1 : 0;
}

/* The gate. What is pushed publishes its history, so a push the graph cannot vouch for
 * stops here, and so does one it cannot check. git push --no-verify is how a person
 * says they mean it. */
static int hook_pre_push(void) {
    char line[512], local_ref[200], local_sha[64], remote_ref[200], remote_sha[64];
    char range[200];
    ds4_dec *d = open_graph();
    if (!d) {
        fprintf(stderr, "ds4-graph: push refused, the graph cannot be checked: %s\n",
                ds4_dec_open_error());
        return 1;
    }
    int rc = 0;
    while (fgets(line, sizeof(line), stdin)) {
        if (sscanf(line, "%199s %63s %199s %63s", local_ref, local_sha, remote_ref, remote_sha) != 4)
            continue;
        if (!strcmp(local_sha, ZERO_SHA)) continue; /* deleting a branch publishes nothing */
        if (!strcmp(remote_sha, ZERO_SHA)) snprintf(range, sizeof(range), "%s --not --remotes", local_sha);
        else snprintf(range, sizeof(range), "%s..%s", remote_sha, local_sha);
        if (run_audit(d, range) != 0) rc = 1;
    }
    ds4_dec_close(d);
    if (rc) fputs("ds4-graph: push refused. ds4-graph link GOAL_ID REV links a commit; "
                  "ds4-graph rewrite OLD NEW repairs a hash.\n", stderr);
    return rc;
}

static int run_hook(int argc, char **argv) {
    if (argc < 1) return usage();
    if (!strcmp(argv[0], "commit-msg") && argc >= 2) return hook_commit_msg(argv[1]);
    if (!strcmp(argv[0], "post-commit")) return hook_post_commit();
    if (!strcmp(argv[0], "post-rewrite")) return hook_post_rewrite();
    if (!strcmp(argv[0], "pre-push")) return hook_pre_push();
    return usage();
}

int main(int argc, char **argv) {
    if (argc < 2) return usage();
    /* Commits belong in the graph the agent writes to. The hook tests turn this
     * off, because they must never reach a real graph. */
    ds4_dec_use_user_server(!getenv("DS4_GRAPH_LOCAL"));
    const char *cmd = argv[1];
    if (!strcmp(cmd, "hook")) return run_hook(argc - 2, argv + 2);
    if (!strcmp(cmd, "install")) {
        int rc = system("git config core.hooksPath githooks");
        puts(rc == 0 ? "git now runs the hooks in githooks/" : "git config failed");
        return rc == 0 ? 0 : 1;
    }

    ds4_dec *d = open_graph();
    if (!d) {
        fprintf(stderr, "ds4-graph: %s\n", ds4_dec_open_error());
        return 2;
    }
    int rc = 2;
    char err[512] = {0};
    if (!strcmp(cmd, "audit")) {
        rc = run_audit(d, argc > 2 ? argv[2] : NULL);
    } else if (!strcmp(cmd, "goal") && argc == 3) {
        /* For work done by hand: export what this prints as DS4_DEC_GOAL, and what is
         * committed is stamped with it, as an agent session's commits are. */
        char *out = ds4_dec_bind_goal(d, argv[2]);
        if (ds4_dec_goal_bound(d)) puts(ds4_dec_goal_id(d));
        else fprintf(stderr, "ds4-graph: %s\n", out ? out : "the goal was not written");
        rc = ds4_dec_goal_bound(d) ? 0 : 1;
        free(out);
    } else if (!strcmp(cmd, "link") && argc == 4) {
        char *out = ds4_dec_git_link(d, argv[2], argv[3], err, sizeof(err));
        if (out) puts(out);
        else fprintf(stderr, "ds4-graph: %s\n", err);
        rc = out ? 0 : 1;
        free(out);
    } else if (!strcmp(cmd, "rewrite") && argc == 4) {
        char *out = ds4_dec_git_rewrite(d, argv[2], argv[3], err, sizeof(err));
        if (out) puts(out);
        else fprintf(stderr, "ds4-graph: %s\n", err);
        rc = out ? 0 : 1;
        free(out);
    } else {
        rc = usage();
    }
    ds4_dec_close(d);
    return rc;
}
