/* Serving a built chat page from ds4-server. The page and the inference API
 * answer from one origin, so the page asks a relative /v1 path and needs no
 * server address baked into it and no cross-origin headers. What is served is
 * the output of the page's own build, and only that: the resolver knows nothing
 * but where the built files are, and every rule here exists so that a request
 * cannot name a file outside the built directory. The endpoint has no
 * authentication, so the built directory is the boundary, not a convention.
 */

#include "ds4_ui.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define DS4_UI_MAX_FILE (32u * 1024u * 1024u)

static void say(char *err, size_t err_len, const char *message) {
    if (!err || err_len == 0) return;
    snprintf(err, err_len, "%s", message);
}

static bool name_is_usable(const char *name) {
    for (const char *c = name; *c; c++) {
        unsigned char ch = (unsigned char)*c;
        int ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                 (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' ||
                 ch == '/';
        if (!ok) return false;
    }
    return true;
}

/* One segment at a time, so ".." has no way to hide: it must match a whole
 * segment, and a segment that starts with a dot is refused - that covers both
 * the climb and the dotfiles a built directory may hold beside the page. An
 * empty segment is refused, which rules out "//" and a trailing slash. */
static bool segments_are_files(const char *name) {
    const char *c = name;
    while (*c) {
        const char *end = c;
        while (*end && *end != '/') end++;
        if (end == c) return false;
        if (c[0] == '.') return false;
        c = end;
        if (*c == '/') c++;
    }
    if (name[strlen(name) - 1] == '/') return false;
    return true;
}

ds4_ui_kind ds4_ui_classify(const char *url_path) {
    const size_t prefix_len = strlen(DS4_UI_URL_PREFIX);
    if (!url_path) return ds4_ui_none;
    if (strncmp(url_path, DS4_UI_URL_PREFIX, prefix_len) != 0) return ds4_ui_none;
    if (url_path[prefix_len] == '\0') return ds4_ui_index;
    if (url_path[prefix_len] != '/') return ds4_ui_none;
    if (url_path[prefix_len + 1] == '\0') return ds4_ui_index;
    return ds4_ui_asset;
}

bool ds4_ui_asset_path(const char *url_path, const char *dir,
                       char *out, size_t out_len, char *err, size_t err_len) {
    const size_t prefix_len = strlen(DS4_UI_URL_PREFIX) + 1;
    if (ds4_ui_classify(url_path) != ds4_ui_asset) {
        say(err, err_len, "not a page URL");
        return false;
    }
    if (!dir || !dir[0]) {
        say(err, err_len, "no built page directory is configured");
        return false;
    }
    const char *name = url_path + prefix_len;
    if (!name[0]) {
        say(err, err_len, "page URL names no file");
        return false;
    }
    /* No decoding step exists here, so an escape stays an escape and is
     * refused: %2F would otherwise become a separator after the check above. */
    if (strchr(name, '%')) {
        say(err, err_len, "page URL uses a percent escape");
        return false;
    }
    if (!name_is_usable(name)) {
        say(err, err_len, "page URL uses a character no built file name has");
        return false;
    }
    if (!segments_are_files(name)) {
        say(err, err_len, "page URL reaches outside the built directory");
        return false;
    }
    int written = snprintf(out, out_len, "%s/%s", dir, name);
    if (written < 0 || (size_t)written >= out_len) {
        say(err, err_len, "page file path is too long");
        return false;
    }
    return true;
}

const char *ds4_ui_content_type(const char *file_path) {
    static const struct {
        const char *extension;
        const char *type;
    } types[] = {
        {"html", "text/html"},
        {"htm", "text/html"},
        {"js", "application/javascript"},
        {"css", "text/css"},
        {"json", "application/json"},
        {"svg", "image/svg+xml"},
        {"png", "image/png"},
        {"jpg", "image/jpeg"},
        {"jpeg", "image/jpeg"},
        {"gif", "image/gif"},
        {"ico", "image/vnd.microsoft.icon"},
        {"woff2", "font/woff2"},
        {"txt", "text/plain"}
    };
    const size_t count = sizeof(types) / sizeof(types[0]);
    const char *dot = file_path ? strrchr(file_path, '.') : NULL;
    if (!dot || dot[0] == '\0' || dot[1] == '\0') return "application/octet-stream";
    for (size_t i = 0; i < count; i++) {
        if (strcasecmp(dot + 1, types[i].extension) == 0) return types[i].type;
    }
    return "application/octet-stream";
}

bool ds4_ui_read_file(const char *file_path, char **out_data, size_t *out_size,
                      char *err, size_t err_len) {
    if (!file_path || !file_path[0]) {
        say(err, err_len, "no page file to read");
        return false;
    }
    /* O_NOFOLLOW closes the door a check-then-open would leave open: a built
     * directory the operator did not build may hold a link into the rest of the
     * filesystem, and the reply must not follow it. */
    int fd = open(file_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
        char detail[128];
        snprintf(detail, sizeof(detail), "cannot read the page file (%s)", strerror(errno));
        say(err, err_len, detail);
        return false;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        say(err, err_len, "cannot measure the page file");
        close(fd);
        return false;
    }
    if (!S_ISREG(st.st_mode)) {
        say(err, err_len, "the page URL names something that is not a file");
        close(fd);
        return false;
    }
    if (st.st_size > (off_t)DS4_UI_MAX_FILE) {
        say(err, err_len, "the page file is too large to serve");
        close(fd);
        return false;
    }
    size_t size = (size_t)st.st_size;
    char *data = malloc(size + 1);
    if (!data) {
        say(err, err_len, "out of memory reading the page file");
        close(fd);
        return false;
    }
    size_t got = 0;
    while (got < size) {
        ssize_t n = read(fd, data + got, size - got);
        if (n == 0) break;
        if (n < 0) {
            if (errno == EINTR) continue;
            say(err, err_len, "cannot read the page file");
            free(data);
            close(fd);
            return false;
        }
        got += (size_t)n;
    }
    close(fd);
    data[got] = '\0';
    *out_data = data;
    *out_size = got;
    return true;
}
