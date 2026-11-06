#include "ds4_undo.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct {
    char *path;
    char *data;      /* NULL when the file did not exist, or was too large */
    size_t size;
    mode_t mode;
    bool existed;
    bool too_large;
} kept_file;

typedef struct {
    kept_file *files;
    int count;
} turn;

struct ds4_undo {
    turn *turns;
    int count;
    size_t bytes;
};

ds4_undo *ds4_undo_new(void) {
    return calloc(1, sizeof(ds4_undo));
}

static void turn_clear(ds4_undo *u, turn *t) {
    for (int i = 0; i < t->count; i++) {
        u->bytes -= t->files[i].size;
        free(t->files[i].path);
        free(t->files[i].data);
    }
    free(t->files);
    t->files = NULL;
    t->count = 0;
}

void ds4_undo_free(ds4_undo *u) {
    if (!u) return;
    for (int i = 0; i < u->count; i++) turn_clear(u, &u->turns[i]);
    free(u->turns);
    free(u);
}

void ds4_undo_begin_turn(ds4_undo *u) {
    if (u->count && u->turns[u->count - 1].count == 0) return;
    turn *grown = realloc(u->turns, sizeof(turn) * (size_t)(u->count + 1));
    if (!grown) return;
    u->turns = grown;
    memset(&u->turns[u->count++], 0, sizeof(turn));
}

static void drop_oldest(ds4_undo *u) {
    turn_clear(u, &u->turns[0]);
    memmove(u->turns, u->turns + 1, sizeof(turn) * (size_t)(u->count - 1));
    u->count--;
}

static bool read_whole(const char *path, size_t size, char **out) {
    FILE *fp = fopen(path, "rb");
    if (!fp) return false;
    char *data = malloc(size ? size : 1);
    bool ok = data && fread(data, 1, size, fp) == size;
    fclose(fp);
    if (!ok) {
        free(data);
        return false;
    }
    *out = data;
    return true;
}

void ds4_undo_note(ds4_undo *u, const char *path) {
    if (!path || !path[0]) return;
    if (!u->count) ds4_undo_begin_turn(u);
    if (!u->count) return;
    turn *t = &u->turns[u->count - 1];
    for (int i = 0; i < t->count; i++)
        if (!strcmp(t->files[i].path, path)) return;

    kept_file f = {0};
    struct stat st;
    if (stat(path, &st) == 0) {
        if (!S_ISREG(st.st_mode)) return;
        f.existed = true;
        f.mode = st.st_mode & 07777;
        if ((unsigned long long)st.st_size > DS4_UNDO_MAX_FILE) f.too_large = true;
        else if (read_whole(path, (size_t)st.st_size, &f.data)) f.size = (size_t)st.st_size;
        else f.too_large = true;
    }
    kept_file *grown = realloc(t->files, sizeof(kept_file) * (size_t)(t->count + 1));
    f.path = strdup(path);
    if (!grown || !f.path) {
        if (grown) t->files = grown;
        free(f.path);
        free(f.data);
        return;
    }
    t->files = grown;
    t->files[t->count++] = f;
    u->bytes += f.size;
    while (u->bytes > DS4_UNDO_MAX_BYTES && u->count > 1) {
        drop_oldest(u);
    }
}

int ds4_undo_depth(const ds4_undo *u) {
    int depth = 0;
    for (int i = 0; i < u->count; i++)
        if (u->turns[i].count) depth++;
    return depth;
}

/* Beside the file and moved over it, so a failure cannot leave half a file where a
 * whole one was. */
static bool put_back(const kept_file *f) {
    size_t n = strlen(f->path) + 16;
    char *temp = malloc(n);
    if (!temp) return false;
    snprintf(temp, n, "%s.undoXXXXXX", f->path);
    int fd = mkstemp(temp);
    if (fd < 0) {
        free(temp);
        return false;
    }
    bool ok = true;
    for (size_t done = 0; ok && done < f->size;) {
        ssize_t w = write(fd, f->data + done, f->size - done);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) ok = false;
        else done += (size_t)w;
    }
    if (fchmod(fd, f->mode) != 0) ok = false;
    if (close(fd) != 0) ok = false;
    if (ok && rename(temp, f->path) != 0) ok = false;
    if (!ok) unlink(temp);
    free(temp);
    return ok;
}

static void say(char **text, size_t *len, const char *verb, const char *path) {
    size_t need = strlen(verb) + strlen(path) + 3;
    char *grown = realloc(*text, *len + need);
    if (!grown) return;
    *text = grown;
    *len += (size_t)snprintf(*text + *len, need, "%s %s\n", verb, path);
}

char *ds4_undo_last(ds4_undo *u) {
    int at = u->count - 1;
    while (at >= 0 && u->turns[at].count == 0) at--;
    if (at < 0) return NULL;
    turn *t = &u->turns[at];
    char *text = NULL;
    size_t len = 0;
    for (int i = t->count - 1; i >= 0; i--) {
        const kept_file *f = &t->files[i];
        if (f->too_large) say(&text, &len, "could not restore, too large to have kept:", f->path);
        else if (!f->existed) {
            if (unlink(f->path) == 0 || errno == ENOENT) say(&text, &len, "removed", f->path);
            else say(&text, &len, "could not remove", f->path);
        } else if (put_back(f)) say(&text, &len, "restored", f->path);
        else say(&text, &len, "could not restore", f->path);
    }
    turn_clear(u, t);
    u->count = at;
    return text;
}
