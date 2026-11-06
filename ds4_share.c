#include "ds4_share.h"
#include "ds4_ui.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define PAGE_SUFFIX ".page"

static const char SHELL_HEAD[] =
    "<!doctype html>\n<html lang=\"en\">\n<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
    "<meta name=\"robots\" content=\"noindex\">\n<title>";
static const char SHELL_STYLE[] =
    "</title>\n<style>\n"
    ":root{color-scheme:light dark}\n"
    "html,body{height:100%;margin:0}\n"
    "body{display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}\n"
    "header{padding:6px 12px;border-bottom:1px solid #8884}\n"
    "b{margin-right:8px}\n"
    "iframe{flex:1;width:100%;border:0}\n"
    "</style>\n<header><b>";
static const char SHELL_NOTICE[] =
    "</b>Written by a language model and shared from a chat. Nothing in the frame below "
    "comes from this server, so do not type anything private into it.</header>\n"
    "<iframe sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\" title=\"Shared page\" srcdoc=\"";
static const char SHELL_TAIL[] = "\"></iframe>\n</html>\n";

static void say(char *err, size_t err_len, const char *text) {
    if (err && err_len) snprintf(err, err_len, "%s", text);
}

bool ds4_share_id_of_path(const char *url_path, char id[DS4_SHARE_ID_CHARS + 1]) {
    const size_t prefix = sizeof(DS4_SHARE_URL_PATH);  /* the slash takes the NUL's place */
    if (!url_path || strncmp(url_path, DS4_SHARE_URL_PATH "/", prefix) != 0) return false;
    const char *p = url_path + prefix;
    if (strlen(p) != DS4_SHARE_ID_CHARS) return false;
    for (size_t i = 0; i < DS4_SHARE_ID_CHARS; i++) {
        bool hex = (p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f');
        if (!hex) return false;
    }
    memcpy(id, p, DS4_SHARE_ID_CHARS + 1);
    return true;
}

bool ds4_share_prepare(const char *dir, char *err, size_t err_len) {
    char path[PATH_MAX];
    if (!dir || !dir[0] || strlen(dir) >= sizeof(path)) {
        say(err, err_len, "the share directory has no usable name");
        return false;
    }
    snprintf(path, sizeof(path), "%s", dir);
    for (char *p = path + 1; ; p++) {
        if (*p != '/' && *p != '\0') continue;
        char was = *p;
        *p = '\0';
        if (mkdir(path, 0700) != 0 && errno != EEXIST) {
            say(err, err_len, strerror(errno));
            return false;
        }
        *p = was;
        if (was == '\0') return true;
    }
}

/* An id is the only thing standing between a stranger and a page, so it comes from
 * the system's own random source or not at all. */
bool ds4_share_new_id(char id[DS4_SHARE_ID_CHARS + 1]) {
    unsigned char bytes[DS4_SHARE_ID_CHARS / 2];
    int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    size_t got = 0;
    while (got < sizeof(bytes)) {
        ssize_t n = read(fd, bytes + got, sizeof(bytes) - got);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        got += (size_t)n;
    }
    close(fd);
    if (got != sizeof(bytes)) return false;
    for (size_t i = 0; i < sizeof(bytes); i++) snprintf(id + i * 2, 3, "%02x", bytes[i]);
    return true;
}

static bool page_path(const char *dir, const char *id, char *out, size_t out_len) {
    return (size_t)snprintf(out, out_len, "%s/%s" PAGE_SUFFIX, dir, id) < out_len;
}

static int pages_in(const char *dir) {
    DIR *d = opendir(dir);
    if (!d) return -1;
    int count = 0;
    const size_t suffix = strlen(PAGE_SUFFIX);
    for (struct dirent *e; (e = readdir(d)) != NULL;) {
        size_t n = strlen(e->d_name);
        if (n > suffix && !strcmp(e->d_name + n - suffix, PAGE_SUFFIX)) count++;
    }
    closedir(d);
    return count;
}

/* The first line of a stored page, so it cannot hold a line ending, and held to
 * its limit on a character boundary. */
static void clean_title(const char *title, char *out, size_t out_len) {
    const char *from = title ? title : "";
    size_t n = 0;
    for (; from[n] && n + 1 < out_len; n++)
        out[n] = (unsigned char)from[n] < 0x20 || from[n] == 0x7f ? ' ' : from[n];
    while (n > 0 && ((unsigned char)from[n] & 0xC0) == 0x80) n--;
    out[n] = '\0';
}

static bool write_all(int fd, const char *data, size_t size) {
    while (size) {
        ssize_t n = write(fd, data, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        data += n;
        size -= (size_t)n;
    }
    return true;
}

ds4_share_result ds4_share_store(const char *dir, const char *title, const char *page,
                                 char id[DS4_SHARE_ID_CHARS + 1], char *err, size_t err_len) {
    size_t size = strlen(page);
    if (size > DS4_SHARE_MAX_PAGE) {
        say(err, err_len, "the page is too large to share");
        return ds4_share_too_large;
    }
    int held = pages_in(dir);
    if (held < 0) {
        say(err, err_len, "cannot read the share directory");
        return ds4_share_failed;
    }
    if (held >= DS4_SHARE_MAX_PAGES) {
        say(err, err_len, "the share directory is full");
        return ds4_share_full;
    }
    char final_path[PATH_MAX];
    char temp_path[PATH_MAX];
    if (!ds4_share_new_id(id) || !page_path(dir, id, final_path, sizeof(final_path)) ||
        (size_t)snprintf(temp_path, sizeof(temp_path), "%s/.upload-XXXXXX", dir) >= sizeof(temp_path)) {
        say(err, err_len, "cannot name the page");
        return ds4_share_failed;
    }
    /* Written beside its name and moved there, so a link never opens half a page. */
    int fd = mkstemp(temp_path);
    if (fd < 0) {
        say(err, err_len, "cannot write to the share directory");
        return ds4_share_failed;
    }
    char line[DS4_SHARE_TITLE_BYTES + 1];
    clean_title(title, line, sizeof(line));
    bool ok = write_all(fd, line, strlen(line)) && write_all(fd, "\n", 1) && write_all(fd, page, size);
    if (close(fd) != 0) ok = false;
    if (!ok || rename(temp_path, final_path) != 0) {
        unlink(temp_path);
        say(err, err_len, "cannot write to the share directory");
        return ds4_share_failed;
    }
    return ds4_share_stored;
}

/* Quotes end the attribute and the rest can open markup, in the shell or in the
 * parser reading the attribute's value, so all four go. The ampersand is what makes
 * the page reach the frame as it was written. */
static const char *entity_of(char c) {
    switch (c) {
    case '&': return "&amp;";
    case '"': return "&quot;";
    case '<': return "&lt;";
    case '>': return "&gt;";
    default: return NULL;
    }
}

static size_t escaped_size(const char *text, size_t size) {
    size_t total = 0;
    for (size_t i = 0; i < size; i++) {
        const char *entity = entity_of(text[i]);
        total += entity ? strlen(entity) : 1;
    }
    return total;
}

static char *put(char *out, const char *text, size_t size) {
    memcpy(out, text, size);
    return out + size;
}

static char *put_escaped(char *out, const char *text, size_t size) {
    for (size_t i = 0; i < size; i++) {
        const char *entity = entity_of(text[i]);
        if (entity) out = put(out, entity, strlen(entity));
        else *out++ = text[i];
    }
    return out;
}

#define PUT_LITERAL(out, literal) put((out), (literal), sizeof(literal) - 1)

char *ds4_share_load(const char *dir, const char *id, size_t *out_size) {
    char path[PATH_MAX];
    char err[160];
    char *data = NULL;
    size_t size = 0;
    if (!page_path(dir, id, path, sizeof(path)) || !ds4_ui_read_file(path, &data, &size, err, sizeof(err)))
        return NULL;
    const char *newline = memchr(data, '\n', size);
    if (!newline) {
        free(data);
        return NULL;
    }
    size_t title_size = (size_t)(newline - data);
    const char *page = newline + 1;
    size_t page_size = size - title_size - 1;
    size_t title_escaped = escaped_size(data, title_size);
    size_t total = sizeof(SHELL_HEAD) + sizeof(SHELL_STYLE) + sizeof(SHELL_NOTICE) + sizeof(SHELL_TAIL) +
                   title_escaped * 2 + escaped_size(page, page_size);
    char *reply = malloc(total);
    if (!reply) {
        free(data);
        return NULL;
    }
    char *out = PUT_LITERAL(reply, SHELL_HEAD);
    out = put_escaped(out, data, title_size);
    out = PUT_LITERAL(out, SHELL_STYLE);
    out = put_escaped(out, data, title_size);
    out = PUT_LITERAL(out, SHELL_NOTICE);
    out = put_escaped(out, page, page_size);
    out = PUT_LITERAL(out, SHELL_TAIL);
    *out_size = (size_t)(out - reply);
    free(data);
    return reply;
}
