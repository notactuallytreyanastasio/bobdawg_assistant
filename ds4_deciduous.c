#define _DARWIN_C_SOURCE
#include "ds4_deciduous.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <strings.h>
#include <netdb.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

/* The whole seam.  Every read and write goes to the shared deciduous server:
 * MCP over HTTP against the Postgres behind it.  There is no local graph, no
 * cache, and no CLI involved - a write that fails is an error, never a silent
 * fallback to a file the next session cannot see. */

#define DEC_TIMEOUT_MS 20000
#define DEC_ARG_MAX 48
#define DEC_BODY_MAX (512 * 1024)
#define DEC_URL_MAX 512
#define DEC_TOKEN_MAX 256
#define DEC_ID_MAX 64
#define DEC_CTYPE_MAX 64
#define DEC_SESSION_MAX 128
#define DEC_INSTR_MAX (12 * 1024)

struct ds4_dec {
    char url[DEC_URL_MAX];
    char token[DEC_TOKEN_MAX];
    char workspace[160];
    char branch[128];
    char label[64];
    char session[DEC_SESSION_MAX];
    char instructions[DEC_INSTR_MAX];
    char goal_id[DEC_ID_MAX];
    char goal_title[DS4_DEC_GOAL_TITLE_MAX];
    char goal_change_id[DEC_ID_MAX];
    char goal_change_title[DS4_DEC_GOAL_TITLE_MAX]; /* what that change id was minted for */
    /* A goal this session let go of: offered in the recovery note for claiming,
     * and otherwise nothing. goal_id empty means no goal is held. */
    char offered_goal_id[DEC_ID_MAX];
    char offered_goal_title[DS4_DEC_GOAL_TITLE_MAX];
    /* What this session recorded, so the closing note on the board can say so
     * without re-reading the graph, and the decision titles it can name. */
    int wrote_decisions, wrote_turns, wrote_notes;
    char decision_titles[8][128];
    int decision_title_count;
    char last_turn[240];
    unsigned rpc_id;
    bool active;
    bool goal_bound;  /* this session holds the goal it names */
    bool nudged_choice; /* the first fork-in-the-road reminder has been given */
    bool nudged_step;   /* the step reminder, once until something is recorded */
    int edits_since_record; /* edits since the last decision or step */
};

/* Edits with nothing recorded before the fork-in-the-road reminder comes back. */
#define DEC_NUDGE_EDITS 8

/* Tool calls run on the agent's loop, so a server closing mid-write must end in
 * an error here and not in SIGPIPE ending the whole session. */
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

static char g_open_error[512];

static void dec_set_err(char *err, size_t cap, const char *fmt, ...) {
    if (!err || !cap) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, cap, fmt, ap);
    va_end(ap);
}

/* ---- buffers ---------------------------------------------------------- */

typedef struct {
    char *p;
    size_t len, cap;
} dec_buf;

static bool dec_buf_addn(dec_buf *b, const char *s, size_t n) {
    if (!n) return true;
    if (b->len + n + 1 > b->cap) {
        size_t want = (b->len + n + 1) * 2;
        if (want < 1024) want = 1024;
        char *grown = realloc(b->p, want);
        if (!grown) return false;
        b->p = grown;
        b->cap = want;
    }
    if (!b->p) {
        b->p = malloc(1024);
        if (!b->p) return false;
        b->cap = 1024;
        b->len = 0;
    }
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = '\0';
    return true;
}

static void dec_buf_add(dec_buf *b, const char *s) {
    if (s) dec_buf_addn(b, s, strlen(s));
}

__attribute__((format(printf, 2, 3)))
static void dec_buf_addf(dec_buf *b, const char *fmt, ...) {
    char tmp[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if ((size_t)n < sizeof(tmp)) {
        dec_buf_addn(b, tmp, (size_t)n);
        return;
    }
    /* Longer than the stack buffer. A board or graph read puts a whole reply in
     * one call, and cutting it at the buffer edge silently dropped most of what
     * the server had said - the newest message was never on screen. */
    size_t want = (size_t)n + 1;
    char *big = malloc(want);
    if (!big) {
        dec_buf_addn(b, tmp, sizeof(tmp) - 1);
        return;
    }
    va_start(ap, fmt);
    int m = vsnprintf(big, want, fmt, ap);
    va_end(ap);
    if (m > 0) {
        size_t len = (size_t)m;
        if (len > want - 1) len = want - 1;
        dec_buf_addn(b, big, len);
    }
    free(big);
}

/* A JSON string literal, quoted and escaped.  UTF-8 passes through; the
 * server returns it as it arrived. */
static void dec_buf_add_json_str(dec_buf *b, const char *s) {
    dec_buf_addn(b, "\"", 1);
    if (!s) { dec_buf_addn(b, "\"", 1); return; }
    const unsigned char *u = (const unsigned char *)s;
    for (; *u; u++) {
        unsigned char c = *u;
        if (c == '"' || c == '\\') { dec_buf_addn(b, "\\", 1); dec_buf_addn(b, (char *)&c, 1); }
        else if (c == '\n') dec_buf_addn(b, "\\n", 2);
        else if (c == '\r') dec_buf_addn(b, "\\r", 2);
        else if (c == '\t') dec_buf_addn(b, "\\t", 2);
        else if (c < 0x20) dec_buf_addf(b, "\\u%04x", c);
        else dec_buf_addn(b, (char *)&c, 1);
    }
    dec_buf_addn(b, "\"", 1);
}

/* ---- a small JSON reader ------------------------------------------------ */

static const char *dec_json_ws(const char *p) {
    while (p && *p && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) p++;
    return p;
}

/* Pointer just past the end of the value starting at p. */
static const char *dec_json_skip_value(const char *p) {
    p = dec_json_ws(p);
    if (!p) return NULL;
    if (*p == '"') {
        p++;
        while (*p) {
            if (*p == '\\' && p[1]) { p += 2; continue; }
            if (*p == '"') return p + 1;
            p++;
        }
        return NULL;
    }
    if (*p == '{' || *p == '[') {
        int depth = 0;
        bool in_str = false;
        for (; *p; p++) {
            if (in_str) {
                if (*(const unsigned char *)p == '\\' && p[1]) { p++; continue; }
                if (*p == '"') in_str = false;
                continue;
            }
            if (*p == '"') { in_str = true; continue; }
            if (*p == '{' || *p == '[') depth++;
            else if (*p == '}' || *p == ']') {
                depth--;
                if (depth == 0) return p + 1;
            }
        }
        return NULL;
    }
    while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\n') p++;
    return p;
}

/* Value of a direct key of the object at json; NULL when absent.  Nested
 * objects are skipped, so "id" inside an array element is never mistaken for
 * the id of the node. */
static const char *dec_json_member(const char *json, const char *key) {
    if (!json || !key) return NULL;
    const char *p = dec_json_ws(json);
    if (!p || *p != '{') return NULL;
    p++;
    while (*p) {
        p = dec_json_ws(p);
        if (*p == '}') return NULL;
        if (*p != '"') return NULL;
        const char *kstart = p + 1;
        const char *kend = NULL;
        const char *q = kstart;
        while (*q) {
            if (*q == '\\' && q[1]) { q += 2; continue; }
            if (*q == '"') { kend = q; break; }
            q++;
        }
        if (!kend) return NULL;
        p = dec_json_ws(kend + 1);
        if (!p || *p != ':') return NULL;
        p = dec_json_ws(p + 1);
        size_t klen = (size_t)(kend - kstart);
        size_t qlen = strlen(key);
        if (klen == qlen && !strncmp(kstart, key, qlen)) return p;
        const char *end = dec_json_skip_value(p);
        if (!end) return NULL;
        p = dec_json_ws(end);
        if (*p == ',') p = dec_json_ws(p + 1);
        else if (*p == '}') return NULL;
        else return NULL;
    }
    return NULL;
}

/* The text inside a JSON string literal, unescaped and malloc'd. */
static char *dec_json_string_at(const char *value) {
    if (!value) return NULL;
    value = dec_json_ws(value);
    if (*value != '"') return NULL;
    value++;
    size_t cap = strlen(value) + 2;
    char *out = malloc(cap);
    if (!out) return NULL;
    size_t len = 0;
    while (*value) {
        unsigned char c = *(const unsigned char *)value;
        if (c == '"' || (c == '\\' && !value[1])) break;
        if (c == '\\') {
            value++;
            char e = *value++;
            if (e == 'n') out[len++] = '\n';
            else if (e == 't') out[len++] = '\t';
            else if (e == 'r') out[len++] = '\r';
            else if (e == 'b') out[len++] = '\b';
            else if (e == 'f') out[len++] = '\f';
            else if (e == '"' || e == '\\' || e == '/') out[len++] = e;
            else if (e == 'u') {
                unsigned int cp = 0, cp2 = 0;
                for (int i = 0; i < 4 && isxdigit((unsigned char)value[i]); i++) {
                    char ch = value[i];
                    cp = cp * 16u + (unsigned int)(isdigit((unsigned char)ch) ? ch - '0'
                            : (tolower(ch) - 'a' + 10));
                }
                if (cp >= 0xd800 && cp <= 0xdbff && value[4] == '\\' && value[5] == 'u') {
                    const char *v2 = value + 6;
                    for (int i = 0; i < 4 && isxdigit((unsigned char)v2[i]); i++) {
                        char ch = v2[i];
                        cp2 = cp2 * 16u + (unsigned int)(isdigit((unsigned char)ch) ? ch - '0'
                                : (tolower(ch) - 'a' + 10));
                    }
                    if (cp2 >= 0xdc00 && cp2 <= 0xdfff) {
                        cp = 0x10000u + (((cp & 0x3ffu) << 10) | (cp2 & 0x3ffu));
                        value += 10;
                    } else value += 6;
                } else value += 4;
                if (cp < 0x80) out[len++] = (char)cp;
                else if (cp < 0x800) {
                    out[len++] = (char)(0xc0 | (cp >> 6));
                    out[len++] = (char)(0x80 | (cp & 0x3f));
                } else if (cp < 0x10000) {
                    out[len++] = (char)(0xe0 | (cp >> 12));
                    out[len++] = (char)(0x80 | ((cp >> 6) & 0x3f));
                    out[len++] = (char)(0x80 | (cp & 0x3f));
                } else {
                    out[len++] = (char)(0xf0 | (cp >> 18));
                    out[len++] = (char)(0x80 | ((cp >> 12) & 0x3f));
                    out[len++] = (char)(0x80 | ((cp >> 6) & 0x3f));
                    out[len++] = (char)(0x80 | (cp & 0x3f));
                }
            } else out[len++] = e;
            continue;
        }
        out[len++] = (char)c;
        value++;
    }
    out[len] = '\0';
    return out;
}

static char *dec_json_str(const char *json, const char *key) {
    return dec_json_string_at(dec_json_member(json, key));
}

static bool dec_json_bool(const char *json, const char *key, bool *out) {
    const char *v = dec_json_member(json, key);
    if (!v) return false;
    if (!strncmp(v, "true", 4)) { *out = true; return true; }
    if (!strncmp(v, "false", 5)) { *out = false; return true; }
    return false;
}

static bool dec_json_number(const char *json, const char *key, long *out) {
    const char *v = dec_json_member(json, key);
    if (!v) return false;
    char *end = NULL;
    long n = strtol(v, &end, 10);
    if (end == v) return false;
    *out = n;
    return true;
}

/* Value of a direct key as raw text (an array or object), malloc'd. */
static char *dec_json_raw(const char *json, const char *key) {
    const char *v = dec_json_member(json, key);
    if (!v) return NULL;
    const char *end = dec_json_skip_value(v);
    if (!end) return NULL;
    size_t n = (size_t)(end - v);
    char *out = malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, v, n);
    out[n] = '\0';
    return out;
}

/* The elem'th element of a JSON array, as a pointer into the text. */
static const char *dec_json_elem(const char *array, int elem) {
    if (!array) return NULL;
    const char *p = dec_json_ws(array);
    if (!p || *p != '[') return NULL;
    p = dec_json_ws(p + 1);
    for (int i = 0;; i++) {
        if (!p || *p == ']') return NULL;
        if (i == elem) return p;
        p = dec_json_ws(dec_json_skip_value(p));
        if (*p == ',') p = dec_json_ws(p + 1);
        else return NULL;
    }
}

/* ---- uuid ------------------------------------------------------------- */

static void dec_uuid(char *out) {
    unsigned char b[16];
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        ssize_t got = read(fd, b, sizeof(b));
        close(fd);
        if (got != (ssize_t)sizeof(b)) memset(b, 0xa7, sizeof(b));
    } else memset(b, 0xa7, sizeof(b));
    b[6] = (unsigned char)((b[6] & 0x0f) | 0x40);
    b[8] = (unsigned char)((b[8] & 0x3f) | 0x80);
    snprintf(out, DEC_ID_MAX,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9],
             b[10], b[11], b[12], b[13], b[14], b[15]);
}

/* ---- the endpoint ------------------------------------------------------ */

/* http://host:port/path only.  TLS is not implemented in ds4, so https is
 * refused with a clear reason rather than failing silently later. */
static bool dec_split_url(const char *url, char *host, size_t host_cap, int *port,
                          char *path, size_t path_cap, char *err, size_t err_len) {
    if (!url || !url[0]) { dec_set_err(err, err_len, "no deciduous server url is set"); return false; }
    const char *p = url;
    if (!strncasecmp(p, "http://", 7)) { p += 7; *port = 80; }
    else if (!strncasecmp(p, "https://", 8)) {
        dec_set_err(err, err_len,
                    "deciduous over https needs TLS and ds4 has no TLS client; point "
                    "at a plain http:// endpoint (a local server, or an http->https proxy)");
        return false;
    } else {
        dec_set_err(err, err_len, "deciduous server url must start with http://: %s", url);
        return false;
    }
    const char *slash = strchr(p, '/');
    const char *colon = strchr(p, ':');
    const char *host_end = slash;
    if (colon && (!host_end || colon < host_end)) host_end = colon;
    if (!host_end) host_end = p + strlen(p);
    size_t hlen = (size_t)(host_end - p);
    if (!hlen || hlen >= host_cap) { dec_set_err(err, err_len, "bad deciduous server host in %s", url); return false; }
    snprintf(host, host_cap, "%.*s", (int)hlen, p);
    if (colon && host_end == colon) {
        const char *num = colon + 1;
        if (!isdigit((unsigned char)*num)) { dec_set_err(err, err_len, "bad port in %s", url); return false; }
        *port = atoi(num);
    }
    const char *path_start = slash ? strchr(p, '/') : NULL;
    const char *trimmed = path_start ? path_start + 1 : NULL;
    /* A bare host means the MCP endpoint, which is the only route ds4 needs. */
    if (!path_start || !trimmed[0]) snprintf(path, path_cap, "/mcp");
    else {
        snprintf(path, path_cap, "%s", path_start);
        char *nl = strchr(path, '\n');
        if (nl) *nl = '\0';
    }
    return true;
}

/* ---- HTTP/1.1 over a plain socket ------------------------------------- */

static int dec_tcp_connect(const char *host, int port, char *err, size_t err_len) {
    char service[32];
    snprintf(service, sizeof(service), "%d", port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    struct addrinfo *res = NULL;
    if (getaddrinfo(host, service, &hints, &res) != 0) {
        dec_set_err(err, err_len, "cannot resolve %s", host);
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        struct timeval tv = {(DEC_TIMEOUT_MS / 1000), (DEC_TIMEOUT_MS % 1000) * 1000};
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#ifdef SO_NOSIGPIPE
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
#endif
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) dec_set_err(err, err_len, "cannot connect to %s:%d: %s", host, port, strerror(errno));
    return fd;
}

static bool dec_write_all(int fd, const char *buf, size_t len) {
    while (len) {
        ssize_t n = send(fd, buf, len, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        buf += n;
        len -= (size_t)n;
    }
    return true;
}

/* Replace buf with the payload of a chunked transfer. */
static bool dec_dechunk(dec_buf *raw, dec_buf *out) {
    const char *p = raw->p;
    const char *end = raw->p + raw->len;
    while (p && p < end) {
        while (p < end && (*p == '\r' || *p == '\n')) p++;
        const char *line_end = p;
        while (line_end < end && *line_end != '\r' && *line_end != '\n') line_end++;
        char size[32] = {0};
        size_t n = (size_t)(line_end - p);
        if (!n) break;
        snprintf(size, sizeof(size), "%.*s", (int)(n > 31 ? 31 : n), p);
        char *sz_end = NULL;
        unsigned long chunk = strtoul(size, &sz_end, 16);
        p = line_end;
        while (p < end && (*p == '\r' || *p == '\n')) p++;
        if (!chunk) break;
        if (p + chunk > end) chunk = (unsigned long)(end - p);
        dec_buf_addn(out, p, chunk);
        p += chunk;
    }
    return out->p != NULL;
}

/* Pull the JSON-RPC message out of an event-stream body: the last complete
 * JSON object that looks like a protocol message. */
static char *dec_sse_payload(const char *text) {
    if (!text) return NULL;
    char *found = NULL;
    for (const char *p = text; *p; p++) {
        if (*p != '{') continue;
        const char *end = dec_json_skip_value(p);
        if (!end) continue;
        size_t n = (size_t)(end - p);
        char *slice = malloc(n + 1);
        if (!slice) break;
        memcpy(slice, p, n);
        slice[n] = '\0';
        if (strstr(slice, "\"jsonrpc\"") || strstr(slice, "\"result\"") || strstr(slice, "\"error\"")) {
            free(found);
            found = slice;
        } else free(slice);
        p = end - 1;
    }
    return found;
}

/* A header value, looked up case-insensitively in the folded copy of the
 * response headers and read out of the raw response at the same offset. */
static bool dec_hdr_get(const char *folded, size_t folded_len, const char *name,
                        const char *raw, char *out, size_t out_cap) {
    if (!folded || !name || !raw || !out || !out_cap) return false;
    size_t nlen = strlen(name);
    for (size_t i = 0; i + nlen <= folded_len; i++) {
        if (strncmp(folded + i, name, nlen) != 0) continue;
        if (i != 0 && folded[i - 1] != '\n' && folded[i - 1] != '\r') continue;
        size_t off = i + nlen;
        if (off >= folded_len || folded[off] != ':') continue;
        off++;
        while (off < folded_len && (folded[off] == ' ' || folded[off] == '\t')) off++;
        size_t end = off;
        while (end < folded_len && raw[end] != '\r' && raw[end] != '\n') end++;
        while (end > off && (raw[end - 1] == ' ' || raw[end - 1] == '\t')) end--;
        size_t len = end - off;
        if (len >= out_cap) len = out_cap - 1;
        snprintf(out, out_cap, "%.*s", (int)len, raw + off);
        return true;
    }
    return false;
}

static bool dec_http_post(const char *url, const char *token, const char *session,
                          const char *pin, const char *body, char **out_body,
                          int *out_status, char *session_out, char *err, size_t err_len) {
    char host[256], path[DEC_URL_MAX];
    int port = 80;
    if (!dec_split_url(url, host, sizeof(host), &port, path, sizeof(path), err, err_len)) return false;
    int fd = dec_tcp_connect(host, port, err, err_len);
    if (fd < 0) return false;

    dec_buf req = {0};
    dec_buf_addf(&req, "POST %s HTTP/1.1\r\nHost: %s:%d\r\nUser-Agent: ds4-agent/1\r\n"
                 "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"
                 "Content-Length: %zu\r\nConnection: close\r\n", path, host, port, strlen(body));
    if (token && token[0]) dec_buf_addf(&req, "Authorization: Bearer %s\r\n", token);
    if (session && session[0]) dec_buf_addf(&req, "Mcp-Session-Id: %s\r\n", session);
    if (pin && pin[0] && !strchr(pin, '*')) dec_buf_addf(&req, "X-Deciduous-Workspace: %s\r\n", pin);
    dec_buf_add(&req, "\r\n");
    dec_buf_add(&req, body);
    bool sent = req.p && dec_write_all(fd, req.p, req.len);
    free(req.p);
    if (!sent) {
        close(fd);
        dec_set_err(err, err_len, "cannot send to %s:%d: %s", host, port, strerror(errno));
        return false;
    }

    /* Send with Connection: close, so the reply ends at the peer closing. */
    dec_buf raw = {0};
    size_t header_end = 0;
    bool peer_closed = false;
    while (raw.len < DEC_BODY_MAX) {
        char buf[8192];
        struct pollfd pfd = {.fd = fd, .events = POLLIN};
        if (poll(&pfd, 1, DEC_TIMEOUT_MS) <= 0) break;
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n < 0) { if (errno == EINTR) continue; break; }
        if (n == 0) { peer_closed = true; break; }
        if (!dec_buf_addn(&raw, buf, (size_t)n)) break;
        if (!header_end) {
            char *hdr_end = NULL;
            if (raw.len >= 4) hdr_end = strstr(raw.p, "\r\n\r\n");
            if (hdr_end) header_end = (size_t)(hdr_end - raw.p) + 4;
        }
    }
    close(fd);

    if (!raw.p || !raw.len || !header_end || header_end > raw.len) {
        dec_set_err(err, err_len, "%s gave no usable reply - is the deciduous server running?", host);
        free(raw.p);
        return false;
    }

    char folded[4096];
    memset(folded, 0, sizeof(folded));
    size_t fold_len = header_end - 1;
    if (fold_len > sizeof(folded) - 1) fold_len = sizeof(folded) - 1;
    for (size_t i = 0; i < fold_len; i++) folded[i] = (char)tolower((unsigned char)raw.p[i]);

    int status = 0;
    char *sp = strchr(raw.p, ' ');
    if (strncmp(raw.p, "HTTP/", 5) != 0 || !sp) {
        dec_set_err(err, err_len, "%s did not answer with HTTP", host);
        free(raw.p);
        return false;
    }
    status = atoi(sp + 1);
    if (out_status) *out_status = status;

    char hdr[DEC_SESSION_MAX];
    if (session_out && dec_hdr_get(folded, fold_len, "mcp-session-id", raw.p, hdr, sizeof(hdr)))
        snprintf(session_out, DEC_SESSION_MAX, "%s", hdr);

    char declared[32] = {0};
    bool chunked = false, event_stream = false;
    if (dec_hdr_get(folded, fold_len, "transfer-encoding", raw.p, hdr, sizeof(hdr)))
        chunked = strstr(hdr, "chunked") != NULL;
    if (dec_hdr_get(folded, fold_len, "content-type", raw.p, hdr, sizeof(hdr)))
        event_stream = strstr(hdr, "text/event-stream") != NULL;
    long want = -1;
    if (dec_hdr_get(folded, fold_len, "content-length", raw.p, declared, sizeof(declared)))
        want = strtol(declared, NULL, 10);

    size_t have = raw.len - header_end;
    /* The reply ends at the peer closing or at the length it declared. Anything
     * short of that is a timeout or the size cap, and reading it as an answer
     * would tell the model a write landed that nobody can vouch for. */
    if (want >= 0 ? (size_t)want > have : !peer_closed) {
        dec_set_err(err, err_len, "the reply from %s was cut short", host);
        free(raw.p);
        return false;
    }
    if (want >= 0 && (size_t)want < have) have = (size_t)want;

    char *text = NULL;
    if (chunked) {
        dec_buf body_buf = {0};
        char *slice = malloc(have + 1);
        if (!slice) { free(raw.p); return false; }
        memcpy(slice, raw.p + header_end, have);
        slice[have] = '\0';
        dec_buf chunk_src = {.p = slice, .len = have, .cap = have + 1};
        dec_dechunk(&chunk_src, &body_buf);
        free(raw.p);
        raw.p = NULL;
        text = body_buf.p;
    } else {
        char *copy = malloc(have + 1);
        if (!copy) { free(raw.p); return false; }
        memcpy(copy, raw.p + header_end, have);
        copy[have] = '\0';
        free(raw.p);
        raw.p = NULL;
        text = copy;
    }
    if (!text) text = calloc(1, 1);

    if (status < 200 || status >= 300) {
        /* A 4xx reply carries the reason the request needs: JSON-RPC nests it
         * inside error, the REST endpoints keep it at the top level, and a
         * refused token is only {"error":"unauthorized"}. */
        const char *nested = dec_json_member(text, "error");
        char *msg = nested ? dec_json_str(nested, "message") : NULL;
        if (!msg || !msg[0]) {
            free(msg);
            msg = dec_json_str(text, "message");
        }
        if (!msg || !msg[0]) {
            free(msg);
            msg = dec_json_str(text, "error");
        }
        dec_set_err(err, err_len, "%s replied %d%s%s", host, status,
                    msg && msg[0] ? ": " : "", msg ? msg : "");
        free(msg);
        free(text);
        return false;
    }

    if (event_stream) {
        char *msg = dec_sse_payload(text);
        if (msg) {
            free(text);
            text = msg;
        }
    }
    if (!text || !text[0]) {
        dec_set_err(err, err_len, "%s returned an empty body", host);
        free(text);
        return false;
    }
    if (out_body) *out_body = text; else free(text);
    return true;
}

/* ---- where the server is ----------------------------------------------- */

static bool dec_read_file_small(const char *path, char *out, size_t cap, size_t *len_out) {
    FILE *fp = fopen(path, "r");
    if (!fp) return false;
    size_t n = fread(out, 1, cap - 1, fp);
    fclose(fp);
    out[n] = '\0';
    if (len_out) *len_out = n;
    return n > 0;
}

/* KEY = value from a shell-style .env file. */
static bool dec_env_value(const char *path, const char *key, char *out, size_t cap) {
    char text[8192];
    if (!path || !key || !dec_read_file_small(path, text, sizeof(text), NULL)) return false;
    for (char *line = text; *line;) {
        size_t cut = strcspn(line, "\n");
        bool last = !line[cut];
        line[cut] = '\0';
        char *p = line;
        while (*p == ' ' || *p == '\t' || *p == '\r') p++;
        if (*p != '#' && !strncmp(p, key, strlen(key))) {
            char *q = p + strlen(key);
            while (*q == ' ' || *q == '\t') q++;
            if (*q == '=') {
                q++;
                while (*q == ' ' || *q == '\t') q++;
                if ((*q == '"' || *q == '\'') && strlen(q) >= 2) {
                    char quote = *q++;
                    char *close = strrchr(q, quote);
                    if (close) *close = '\0';
                }
                char *end = q + strlen(q);
                while (end > q && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) *--end = '\0';
                snprintf(out, cap, "%s", q);
                return out[0] != '\0';
            }
        }
        if (last) break;
        line += cut + 1;
    }
    return false;
}

/* key = "value" inside [section] of a config.toml. */
static bool dec_toml_value(const char *path, const char *section, const char *key,
                           char *out, size_t cap) {
    char text[8192];
    if (!path || !section || !key) return false;
    if (!dec_read_file_small(path, text, sizeof(text), NULL)) return false;
    bool in_section = false;
    for (char *line = text; *line;) {
        size_t cut = strcspn(line, "\n");
        bool last = !line[cut];
        line[cut] = '\0';
        char *p = line;
        while (*p == ' ' || *p == '\t' || *p == '\r') p++;
        if (*p == '[') {
            char *close = strchr(p, ']');
            if (close) {
                *close = '\0';
                in_section = !strcmp(p + 1, section);
            }
        } else if (in_section && *p && *p != '#') {
            size_t klen = strlen(key);
            if (!strncmp(p, key, klen)) {
                char *q = p + klen;
                while (*q == ' ' || *q == '\t') q++;
                if (*q == '=') {
                    q++;
                    while (*q == ' ' || *q == '\t') q++;
                    if ((*q == '"' || *q == '\'') && strlen(q) >= 2) {
                        char quote = *q++;
                        char *close = strrchr(q, quote);
                        if (close) *close = '\0';
                    }
                    char *cut = strchr(q, '#');
                    if (cut && (cut == q || cut[-1] == ' ' || cut[-1] == '\t')) *cut = '\0';
                    char *end = q + strlen(q);
                    while (end > q && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) *--end = '\0';
                    snprintf(out, cap, "%s", q);
                    return out[0] != '\0';
                }
            }
        }
        if (last) break;
        line += cut + 1;
    }
    return false;
}

static const char *dec_basename(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash ? slash + 1 : path;
}

static void dec_trim_slash(char *path) {
    size_t n = strlen(path);
    while (n > 1 && path[n - 1] == '/') path[--n] = '\0';
}

bool ds4_dec_find_root(const char *start, char *out, size_t cap) {
    char base[PATH_MAX];
    if (start && start[0]) snprintf(base, sizeof(base), "%s", start);
    else if (!getcwd(base, sizeof(base))) snprintf(base, sizeof(base), ".");
    dec_trim_slash(base);

    char probe[PATH_MAX];
    char *cut = base + strlen(base);
    for (;;) {
        snprintf(probe, sizeof(probe), "%s/.deciduous/config.toml", base);
        bool cfg = access(probe, R_OK) == 0;
        snprintf(probe, sizeof(probe), "%s/.git", base);
        bool git = access(probe, F_OK) == 0;
        if (cfg || git) break;
        cut = strrchr(base, '/');
        if (!cut || cut == base) {
            if (cut == base) break;
        }
        if (!cut) break;
        *cut = '\0';
    }
    snprintf(out, cap, "%s", base);
    dec_trim_slash(out);
    return out[0] != '\0';
}

/* This checkout's git directory. In a worktree .git is a file naming it. */
static void dec_git_dir(const char *root, char *out, size_t cap) {
    char dotgit[PATH_MAX], text[PATH_MAX];
    snprintf(dotgit, sizeof(dotgit), "%s/.git", root);
    snprintf(out, cap, "%s", dotgit);
    if (!dec_read_file_small(dotgit, text, sizeof(text), NULL)) return;
    if (strncmp(text, "gitdir: ", 8) != 0) return;
    char *p = text + 8;
    p[strcspn(p, "\r\n")] = '\0';
    if (p[0] == '/') snprintf(out, cap, "%s", p);
    else snprintf(out, cap, "%s/%s", root, p);
}

/* The repository's own directory name, for a checkout that is a worktree of it:
 * the graph belongs to the repository, whatever the worktree is called. */
static bool dec_worktree_repo(const char *root, char *out, size_t cap) {
    char dir[PATH_MAX];
    dec_git_dir(root, dir, sizeof(dir));
    char *mark = strstr(dir, "/.git/worktrees/");
    if (!mark) return false;
    *mark = '\0';
    snprintf(out, cap, "%s", dec_basename(dir));
    return out[0] != '\0';
}

/* The branch this checkout is on, from its HEAD, without running git. */
static bool dec_git_branch(const char *root, char *out, size_t cap) {
    char dir[PATH_MAX], path[PATH_MAX + 8];
    dec_git_dir(root, dir, sizeof(dir));
    snprintf(path, sizeof(path), "%s/HEAD", dir);
    char text[256];
    if (!dec_read_file_small(path, text, sizeof(text), NULL)) return false;
    if (strncmp(text, "ref: refs/heads/", 16) != 0) return false;
    char *p = text + 16;
    size_t cut = strcspn(p, "\r\n");
    p[cut] = '\0';
    if (!p[0]) return false;
    snprintf(out, cap, "%s", p);
    return true;
}

/* A file under $HOME, when it is there and readable. The out parameter is
 * filled either way, so a caller can name the path it looked at. */
static bool dec_path_home(char *out, size_t cap, const char *relative) {
    const char *home = getenv("HOME");
    if (!out || !cap) return false;
    out[0] = '\0';
    if (!home || !home[0] || !relative || !relative[0]) return false;
    int n = snprintf(out, cap, "%s/%s", home, relative);
    return n > 0 && (size_t)n < cap && access(out, R_OK) == 0;
}

static bool dec_resolve(ds4_dec *d, const char *root, char *err, size_t err_len) {
    char home[PATH_MAX], url[DEC_URL_MAX], token[DEC_TOKEN_MAX] = {0};
    char scratch[DEC_URL_MAX];
    bool have_url = false;

    /* A locally hosted server is the common dev case: its own .env says where
     * it listens and what the token is. */
    if (dec_path_home(home, sizeof(home), ".config/deciduous/server/.env")) {
        char host[128] = {0}, port[16] = {0};
        if (!dec_env_value(home, "DECIDUOUS_BIND_ADDRESS", host, sizeof(host)))
            snprintf(host, sizeof(host), "127.0.0.1");
        if (!strcmp(host, "0.0.0.0") || !strcmp(host, "::"))
            snprintf(host, sizeof(host), "127.0.0.1");
        if (!dec_env_value(home, "DECIDUOUS_PORT", port, sizeof(port)))
            snprintf(port, sizeof(port), "4000");
        snprintf(url, sizeof(url), "http://%s:%s/mcp", host, port);
        snprintf(d->url, sizeof(d->url), "%s", url);
        have_url = true;
        dec_env_value(home, "DECIDUOUS_MCP_TOKEN", token, sizeof(token));
        if (token[0]) snprintf(d->token, sizeof(d->token), "%s", token);
    }

    char cfg[PATH_MAX];
    snprintf(cfg, sizeof(cfg), "%s/.deciduous/config.toml", root);
    if (dec_toml_value(cfg, "remote", "url", scratch, sizeof(scratch))) {
        snprintf(d->url, sizeof(d->url), "%s", scratch);
        have_url = true;
    }
    if (dec_toml_value(cfg, "remote", "workspace", scratch, sizeof(scratch)))
        snprintf(d->workspace, sizeof(d->workspace), "%s", scratch);

    const char *env_url = getenv("DECIDUOUS_MCP_URL");
    if (env_url && env_url[0]) {
        snprintf(d->url, sizeof(d->url), "%s", env_url);
        have_url = true;
    }
    const char *env_token = getenv("DECIDUOUS_MCP_TOKEN");
    if (env_token && env_token[0]) snprintf(d->token, sizeof(d->token), "%s", env_token);
    const char *env_ws = getenv("DECIDUOUS_WORKSPACE");
    if (env_ws && env_ws[0]) snprintf(d->workspace, sizeof(d->workspace), "%s", env_ws);
    const char *env_branch = getenv("DECIDUOUS_BRANCH");
    if (env_branch && env_branch[0]) snprintf(d->branch, sizeof(d->branch), "%s", env_branch);

    if (!d->token[0] && dec_path_home(home, sizeof(home), ".config/deciduous/credentials")) {
        char creds[DEC_TOKEN_MAX];
        if (dec_read_file_small(home, creds, sizeof(creds), NULL)) {
            size_t cut = strcspn(creds, "\r\n");
            creds[cut] = '\0';
            if (creds[0]) snprintf(d->token, sizeof(d->token), "%s", creds);
        }
    }

    if (!have_url || !d->url[0]) {
        dec_set_err(err, err_len,
                    "no deciduous server. Point ds4 at the shared graph with [remote] url "
                    "in %s/.deciduous/config.toml, or DECIDUOUS_MCP_URL. ds4 keeps no local "
                    "graph, so without the server there is nothing to write to.", root);
        return false;
    }
    if (!d->token[0]) {
        dec_set_err(err, err_len,
                    "no deciduous token for %s. Set DECIDUOUS_MCP_TOKEN, or write the "
                    "token as the first line of ~/.config/deciduous/credentials.", d->url);
        return false;
    }
    if (!d->workspace[0] && !dec_worktree_repo(root, d->workspace, sizeof(d->workspace))) {
        snprintf(d->workspace, sizeof(d->workspace), "%s", dec_basename(root));
    }
    if (!d->branch[0]) {
        if (!dec_git_branch(root, d->branch, sizeof(d->branch)))
            snprintf(d->branch, sizeof(d->branch), "main");
    }
    return true;
}

/* ---- building tool arguments ------------------------------------------- */

typedef struct {
    dec_buf b;
    bool first;
} dec_args;

static void dec_args_init(dec_args *a) {
    a->b = (dec_buf){0};
    a->first = true;
}

static void dec_args_sep(dec_args *a, const char *key) {
    if (!a->first) dec_buf_add(&a->b, ",");
    a->first = false;
    dec_buf_add(&a->b, "\"");
    dec_buf_add(&a->b, key);
    dec_buf_add(&a->b, "\":");
}

static void dec_args_str(dec_args *a, const char *key, const char *val) {
    if (!val || !val[0]) return;
    dec_args_sep(a, key);
    dec_buf_add_json_str(&a->b, val);
}

static void dec_args_int(dec_args *a, const char *key, long val) {
    dec_args_sep(a, key);
    dec_buf_addf(&a->b, "%ld", val);
}

static void dec_args_bool(dec_args *a, const char *key, bool val) {
    dec_args_sep(a, key);
    dec_buf_add(&a->b, val ? "true" : "false");
}

static void dec_args_list(dec_args *a, const char *key, const char **vals, int n) {
    if (!n || !vals) return;
    dec_args_sep(a, key);
    dec_buf_add(&a->b, "[");
    for (int i = 0; i < n; i++) {
        if (i) dec_buf_add(&a->b, ",");
        dec_buf_add_json_str(&a->b, vals[i] ? vals[i] : "");
    }
    dec_buf_add(&a->b, "]");
}

/* The pairs are collected bare, so that the caller can add the workspace and
 * the branch without knowing which fields a given op filled in.  The object
 * is closed here, into a fresh buffer sized for the braces. */
static char *dec_args_json(dec_args *a) {
    if (!a->b.p) return strdup("{}");
    char *out = malloc(a->b.len + 3);
    if (!out) { free(a->b.p); a->b.p = NULL; return NULL; }
    out[0] = '{';
    memcpy(out + 1, a->b.p, a->b.len);
    out[a->b.len + 1] = '}';
    out[a->b.len + 2] = '\0';
    free(a->b.p);
    a->b.p = NULL;
    return out;
}
/* ---- JSON-RPC over HTTP ------------------------------------------------ */

/* One JSON-RPC exchange.  The session id from the handshake rides along on
 * every later request; the server hands a fresh one back whenever it wants a
 * new session. */
static bool dec_handshake(ds4_dec *d, char *err, size_t err_len);

static bool dec_rpc_once(ds4_dec *d, const char *method, const char *params, bool notify,
                         char **result_out, int *status_out, char *err, size_t err_len) {
    dec_buf body = {0};
    dec_buf_add(&body, "{\"jsonrpc\":\"2.0\",");
    if (!notify) dec_buf_addf(&body, "\"id\":%u,", ++d->rpc_id);
    dec_buf_add(&body, "\"method\":");
    dec_buf_add_json_str(&body, method);
    dec_buf_add(&body, ",\"params\":");
    dec_buf_add(&body, params && params[0] ? params : "{}");
    dec_buf_add(&body, "}");

    char *resp = NULL;
    int status = 0;
    char session[DEC_SESSION_MAX] = {0};
    bool ok = dec_http_post(d->url, d->token, d->session, d->workspace, body.p,
                            &resp, &status, session, err, err_len);
    free(body.p);
    if (status_out) *status_out = status;
    if (session[0] && !d->session[0])
        snprintf(d->session, sizeof(d->session), "%s", session);
    if (!ok) {
        free(resp);
        return false;
    }

    const char *error = dec_json_member(resp, "error");
    if (error) {
        char *msg = dec_json_str(error, "message");
        dec_set_err(err, err_len, "%s", msg && msg[0] ? msg : "the server refused the request");
        free(msg);
        free(resp);
        return false;
    }
    if (notify) {
        free(resp);
        return true;
    }
    /* A request is answered with a result or an error. A reply with neither, or
     * one that does not parse, is not a quiet success. */
    char *result = dec_json_member(resp, "result") ? dec_json_raw(resp, "result") : NULL;
    free(resp);
    if (!result) {
        dec_set_err(err, err_len, "the server's reply could not be read");
        return false;
    }
    if (result_out) *result_out = result;
    else free(result);
    return true;
}

/* A restarted server has forgotten the session and says so with a 404. The call
 * never ran, so shaking hands and sending it again cannot write anything twice,
 * and a session that outlives a restart keeps its record. */
static bool dec_rpc(ds4_dec *d, const char *method, const char *params, bool notify,
                    char **result_out, char *err, size_t err_len) {
    int status = 0;
    if (dec_rpc_once(d, method, params, notify, result_out, &status, err, err_len)) return true;
    if (status != 404 || !d->session[0] || !strcmp(method, "initialize")) return false;
    char again[512] = {0};
    if (!dec_handshake(d, again, sizeof(again))) {
        dec_set_err(err, err_len, "the server forgot this session and would not start "
                                  "another: %s", again);
        return false;
    }
    return dec_rpc_once(d, method, params, notify, result_out, NULL, err, err_len);
}

/* Call one MCP tool.  The server answers with content[0].text holding the
 * payload as JSON text, and marks a refused write with isError. */
static char *dec_tool(ds4_dec *d, const char *name, const char *args_json,
                      char *err, size_t err_len) {
    dec_buf params = {0};
    dec_buf_add(&params, "{\"name\":");
    dec_buf_add_json_str(&params, name);
    dec_buf_add(&params, ",\"arguments\":");
    dec_buf_add(&params, args_json && args_json[0] ? args_json : "{}");
    dec_buf_add(&params, "}");

    char *result = NULL;
    bool ok = dec_rpc(d, "tools/call", params.p, false, &result, err, err_len);
    free(params.p);
    if (!ok) {
        free(result);
        return NULL;
    }

    bool refused = false;
    char *payload = NULL;
    char *content = result ? dec_json_raw(result, "content") : NULL;
    if (content) {
        const char *first = dec_json_elem(content, 0);
        if (first) payload = dec_json_str(first, "text");
        free(content);
    }
    if (result) dec_json_bool(result, "isError", &refused);
    free(result);
    if (!payload && !refused) {
        dec_set_err(err, err_len, "the server's answer held no text to read");
        return NULL;
    }

    if (refused) {
        dec_set_err(err, err_len, "%s", payload && payload[0] ? payload : "the tool refused the call");
        free(payload);
        return NULL;
    }
    return payload ? payload : strdup("");
}

/* Writes carry the workspace and the branch: the server needs both to place
 * the node, and the instructions ask for them on every write. */
static char *dec_tool_ctx(ds4_dec *d, const char *name, dec_args *a, bool with_branch,
                          char *err, size_t err_len) {
    if (d->workspace[0]) dec_args_str(a, "workspace", d->workspace);
    if (with_branch && d->branch[0]) dec_args_str(a, "branch", d->branch);
    char *args = dec_args_json(a);
    char *out = dec_tool(d, name, args, err, err_len);
    free(args);
    return out;
}

/* ---- rendering the answers into observations --------------------------- */

/* Where a cut at n lands on a character boundary: titles here carry em dashes,
 * and half of one is invalid UTF-8 in a request the server has to parse. */
static size_t dec_utf8_floor(const char *text, size_t n) {
    while (n > 0 && ((unsigned char)text[n] & 0xC0) == 0x80) n--;
    return n;
}

static void dec_clip(char *out, size_t cap, const char *text) {
    if (!out || !cap) return;
    out[0] = '\0';
    if (!text) return;
    size_t i = 0;
    for (; text[i] && i < cap - 1; i++)
        out[i] = text[i] == '\n' ? ' ' : text[i];
    i = dec_utf8_floor(text, i);
    out[i] = '\0';
}

/* One and many: the closing note names its counts out loud, so it has to say
 * "1 decision" and not "1 decisions". */
static const char *dec_plural(int count, const char *one, const char *many) {
    return count == 1 ? one : many;
}

static char *dec_render_nodes(const char *array, int cap_lines) {
    dec_buf b = {0};
    int n = 0;
    for (int i = 0; n < cap_lines; i++) {
        const char *elem = dec_json_elem(array, i);
        if (!elem) break;
        char *type = dec_json_str(elem, "node_type");
        if (!type) type = dec_json_str(elem, "type");
        char *status = dec_json_str(elem, "status");
        char *title = dec_json_str(elem, "title");
        char *id = dec_json_str(elem, "id");
        char short_title[200];
        dec_clip(short_title, sizeof(short_title), title ? title : "(untitled)");
        if (status && status[0])
            dec_buf_addf(&b, "- %s %s: %s\n", type ? type : "node", status, short_title);
        else
            dec_buf_addf(&b, "- %s: %s\n", type ? type : "node", short_title);
        if (id && id[0] && strlen(id) > 8) {
            /* A short id keeps the observation readable; the full one is in
             * show_node output when the model needs to act on a node. */
            dec_buf_addf(&b, "  id %s\n", id);
        }
        free(type);
        free(status);
        free(title);
        free(id);
        n++;
    }
    if (!b.p) return strdup("");
    return b.p;
}

/* The messages from `first` on: the board reads oldest first, so the end of an
 * array is where the news is. */
static char *dec_render_messages(const char *array, int first) {
    dec_buf b = {0};
    for (int i = first;; i++) {
        const char *elem = dec_json_elem(array, i);
        if (!elem) break;
        long id = 0, reply = 0;
        char *author = dec_json_str(elem, "author");
        char *subject = dec_json_str(elem, "subject");
        char *body = dec_json_str(elem, "body");
        char clip_body[240], clip_subject[160];
        dec_clip(clip_subject, sizeof(clip_subject), subject ? subject : "(no subject)");
        dec_clip(clip_body, sizeof(clip_body), body ? body : "");
        dec_json_number(elem, "id", &id);
        if (dec_json_number(elem, "reply_to", &reply) && reply > 0)
            dec_buf_addf(&b, "- #%ld %s: %s (reply to #%ld)\n", id,
                         author ? author : "?", clip_subject, reply);
        else
            dec_buf_addf(&b, "- #%ld %s: %s\n", id, author ? author : "?", clip_subject);
        if (body && body[0])
            dec_buf_addf(&b, "  %s\n", clip_body);
        free(author);
        free(subject);
        free(body);
    }
    if (!b.p) return strdup("");
    return b.p;
}

static char *dec_fail(const char *err) {
    dec_buf b = {0};
    dec_buf_addf(&b, "deciduous write failed: %s\nThe graph did not record this.",
                 err && err[0] ? err : "unknown error");
    return b.p ? b.p : strdup("deciduous write failed");
}

/* ---- the operations ds4 offers ----------------------------------------- */

static const char *dec_arg(const ds4_dec_call *c, const char *name) {
    for (int i = 0; i < c->argc; i++)
        if (c->args[i].name && !strcmp(c->args[i].name, name))
            return c->args[i].value;
    return NULL;
}

static int dec_args_named(const ds4_dec_call *c, const char *name, const char **out, int cap) {
    int n = 0;
    for (int i = 0; i < c->argc && n < cap; i++)
        if (c->args[i].name && !strcmp(c->args[i].name, name) && c->args[i].value)
            out[n++] = c->args[i].value;
    return n;
}

static void dec_clip_title(char *out, size_t cap, const char *text) {
    if (!out || !cap) return;
    char flat[DS4_DEC_GOAL_TITLE_MAX * 2];
    dec_clip(flat, sizeof(flat), text);
    size_t cut = strlen(flat);
    if (cut > cap - 4) {
        cut = cap - 4;
        while (cut > 0 && flat[cut - 1] != ' ') cut--;
        if (!cut) cut = dec_utf8_floor(flat, cap - 4);
        flat[cut] = '\0';
        snprintf(out, cap, "%s...", flat);
        return;
    }
    snprintf(out, cap, "%s", flat);
}

/* A durable fact, attached to the goal it was discovered for. The server has a
 * log_observation tool with richer arguments, but it cannot place the
 * observation under the goal, and an unattached observation is an orphan the
 * graph has to go looking for. add_node with parent_id and edge_type creates
 * the node and the edge in one call, so ds4 uses that and writes the reason
 * into the description instead. */
static char *dec_op_note(ds4_dec *d, const ds4_dec_call *c) {
    const char *title = dec_arg(c, "title");
    if (!title || !title[0]) return strdup("note needs title.");
    const char *description = dec_arg(c, "description");
    const char *why = dec_arg(c, "why");

    char err[512] = {0};
    char *text = NULL;
    if (why && why[0]) {
        size_t need = (description ? strlen(description) : 0) + strlen(why) + 16;
        text = calloc(1, need);
        if (text)
            snprintf(text, need, "%s%swhy: %s", description ? description : "",
                     description && description[0] ? "\n" : "", why);
    } else text = strdup(description ? description : "");

    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "node_type", "observation");
    dec_args_str(&a, "title", title);
    dec_args_str(&a, "description", text && text[0] ? text : title);
    dec_args_str(&a, "status", "active");
    if (d->goal_id[0]) {
        dec_args_str(&a, "parent_id", d->goal_id);
        dec_args_str(&a, "edge_type", "enables");
    }
    char *payload = dec_tool_ctx(d, "add_node", &a, true, err, sizeof(err));
    free(text);
    if (!payload) return dec_fail(err);

    char *id = dec_json_str(payload, "id");
    free(payload);
    d->wrote_notes++;
    dec_buf b = {0};
    dec_buf_addf(&b, "Observation recorded%s%s\nid %s",
                 d->goal_id[0] ? " and attached to the goal" : "", "", id ? id : "?");
    free(id);
    return b.p ? b.p : strdup("Observation recorded");
}

/* Open goals on this branch, so a new session can pick a line of work up. */
static char *dec_open_goals(ds4_dec *d) {
    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "type", "goal");
    dec_args_int(&a, "limit", 5);
    char *payload = dec_tool_ctx(d, "query_nodes", &a, true, err, sizeof(err));
    if (!payload) return NULL;
    char *nodes = dec_json_raw(payload, "nodes");
    char *lines = nodes ? dec_render_nodes(nodes, 5) : strdup("");
    free(nodes);
    free(payload);
    if (!lines || !lines[0]) {
        free(lines);
        return NULL;
    }
    dec_buf b = {0};
    dec_buf_add(&b, "Goals on this branch, with the state the graph holds for them:\n");
    dec_buf_add(&b, lines);
    free(lines);
    return b.p ? b.p : strdup("");
}

static char *dec_op_goal(ds4_dec *d, const char *text) {
    if (!text || !text[0]) {
        dec_buf b = {0};
        if (d->goal_id[0])
            dec_buf_addf(&b, "This session holds the goal \"%s\"\nid %s\n",
                         d->goal_title, d->goal_id);
        else
            dec_buf_add(&b, "This session holds no goal: pass --goal at startup, or run "
                           "/goal with the request. The goal is written to the server.\n");
        char *open = dec_open_goals(d);
        if (open) {
            dec_buf_add(&b, open);
            free(open);
        }
        char *out = b.p ? b.p : strdup("");
        return out;
    }

    if (d->goal_id[0]) {
        char *out = malloc(512 + DS4_DEC_GOAL_TITLE_MAX);
        snprintf(out, 512 + DS4_DEC_GOAL_TITLE_MAX,
                 "This session already holds \"%s\" (id %s). A session holds one goal; "
                 "use /new to start a fresh one.", d->goal_title, d->goal_id);
        return out;
    }

    char err[512] = {0};
    char title[DS4_DEC_GOAL_TITLE_MAX];
    dec_clip_title(title, sizeof(title), text);
    /* The id makes a retry of this request safe. A different request is a
     * different node, which the server would refuse under the same id. */
    if (!d->goal_change_id[0] || strcmp(d->goal_change_title, title) != 0) {
        dec_uuid(d->goal_change_id);
        snprintf(d->goal_change_title, sizeof(d->goal_change_title), "%s", title);
    }

    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "node_type", "goal");
    dec_args_str(&a, "title", title);
    dec_args_str(&a, "prompt", text);
    dec_args_str(&a, "status", "active");
    dec_args_str(&a, "change_id", d->goal_change_id);
    char *payload = dec_tool_ctx(d, "add_node", &a, true, err, sizeof(err));
    if (!payload) return dec_fail(err);

    char *id = dec_json_str(payload, "id");
    bool created = true;
    dec_json_bool(payload, "created", &created);
    free(payload);
    if (!id || !id[0]) {
        free(id);
        return dec_fail("the server did not name the goal it made");
    }
    snprintf(d->goal_id, sizeof(d->goal_id), "%s", id);
    snprintf(d->goal_title, sizeof(d->goal_title), "%s", title);
    d->goal_bound = true;
    d->offered_goal_id[0] = '\0';
    dec_buf b = {0};
    dec_buf_addf(&b, "Goal recorded on the server%s\nid %s, held by this session\n",
                 created ? "" : " (a goal with this change id already existed)", id);
    free(id);
    return b.p ? b.p : strdup("");
}

/* The work so far is on the record, so the reminders can start counting again. */
static void dec_work_recorded(ds4_dec *d) {
    d->edits_since_record = 0;
    d->nudged_step = false;
}

/* The titles this session decided, kept for the closing note on the board.
 * Eight is a limit on the note, not on the graph: the record itself is on the
 * server and the note only has to point at it. */
static void dec_remember_decision(ds4_dec *d, const char *title) {
    if (!title || !title[0]) return;
    if (d->decision_title_count >= (int)(sizeof(d->decision_titles) /
                                         sizeof(d->decision_titles[0])))
        return;
    char clip[sizeof(d->decision_titles[0])];
    dec_clip(clip, sizeof(clip), title);
    snprintf(d->decision_titles[d->decision_title_count],
             sizeof(d->decision_titles[0]), "%s", clip);
    d->decision_title_count++;
}

static char *dec_op_decide(ds4_dec *d, const ds4_dec_call *c) {
    const char *title = dec_arg(c, "title");
    const char *chosen = dec_arg(c, "chosen_option");
    if (!title || !title[0]) return strdup("decide needs title.");
    if (!chosen || !chosen[0]) return strdup("decide needs chosen_option.");

    const char *rejected[16];
    int n_rejected = dec_args_named(c, "rejected_option", rejected, 16);

    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "title", title);
    dec_args_str(&a, "chosen_option", chosen);
    dec_args_list(&a, "rejected_options", rejected, n_rejected);
    const char *rationale = dec_arg(c, "rationale");
    dec_args_str(&a, "rationale", rationale);
    if (d->goal_id[0]) dec_args_str(&a, "parent_node_id", d->goal_id);
    char *payload = dec_tool_ctx(d, "log_decision", &a, true, err, sizeof(err));
    if (!payload) return dec_fail(err);

    char *id = dec_json_str(payload, "decision_id");
    char *message = dec_json_str(payload, "message");
    free(payload);
    d->wrote_decisions++;
    dec_work_recorded(d);
    dec_remember_decision(d, title);
    dec_buf b = {0};
    dec_buf_addf(&b, "%s%s%s\n", message ? message : "Decision logged",
                 id && id[0] ? "\nid " : "", id ? id : "");
    if (n_rejected)
        dec_buf_addf(&b, "%d option(s) recorded as rejected.", n_rejected);
    free(id);
    free(message);
    return b.p ? b.p : strdup("Decision logged");
}

static char *dec_op_turn(ds4_dec *d, const ds4_dec_call *c) {
    const char *summary = dec_arg(c, "summary");
    if (!summary || !summary[0]) return strdup("turn needs summary.");

    const char *observations[16];
    int n_obs = dec_args_named(c, "observation", observations, 16);

    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "summary", summary);
    dec_args_list(&a, "observations", observations, n_obs);
    dec_args_str(&a, "decision", dec_arg(c, "decision"));
    dec_args_str(&a, "action", dec_arg(c, "action"));
    dec_args_str(&a, "outcome", dec_arg(c, "outcome"));
    if (d->goal_id[0]) dec_args_str(&a, "parent_node_id", d->goal_id);
    char *payload = dec_tool_ctx(d, "capture_conversation_turn", &a, true, err, sizeof(err));
    if (!payload) return dec_fail(err);

    char *nodes = dec_json_raw(payload, "nodes");
    char *message = dec_json_str(payload, "message");
    free(payload);
    d->wrote_turns++;
    dec_work_recorded(d);
    {
        char clip[sizeof(d->last_turn)];
        dec_clip(clip, sizeof(clip), summary);
        snprintf(d->last_turn, sizeof(d->last_turn), "%s", clip);
    }
    dec_buf b = {0};
    dec_buf_addf(&b, "%s\n", message ? message : "Step recorded");
    if (nodes) {
        char *lines = dec_render_nodes(nodes, 8);
        if (lines[0]) {
            dec_buf_add(&b, lines);
        }
        free(lines);
        free(nodes);
    }
    free(message);
    return b.p ? b.p : strdup("Step recorded");
}

/* ask_graph has no branch argument, so this one builds its own params instead
 * of going through dec_tool_ctx.  With workspace "*" it passes no workspace at
 * all, which is the server's global read view across every project. */
static char *dec_op_graph(ds4_dec *d, const ds4_dec_call *c) {
    const char *question = dec_arg(c, "question");
    if (!question || !question[0]) return strdup("graph needs question.");

    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "question", question);
    dec_args_bool(&a, "include_context", true);
    if (strcmp(d->workspace, "*") != 0) dec_args_str(&a, "workspace", d->workspace);
    char *args = dec_args_json(&a);
    char *payload = dec_tool(d, "ask_graph", args, err, sizeof(err));
    free(args);
    if (!payload) return dec_fail(err[0] ? err : "the graph could not answer");

    char *results = dec_json_raw(payload, "results");
    long count = 0;
    dec_json_number(payload, "result_count", &count);
    free(payload);
    /* Unreadable is not empty: "nothing in the graph" sends the model off to
     * decide again what may already be decided. */
    if (!results) return dec_fail("the graph's answer could not be read");
    char *lines = dec_render_nodes(results, 10);
    free(results);
    dec_buf b = {0};
    if (!lines || !lines[0]) dec_buf_addf(&b, "Nothing in the graph about \"%s\".", question);
    else dec_buf_addf(&b, "%ld node(s) about \"%s\":\n%s", count, question, lines);
    free(lines);
    return b.p ? b.p : strdup("");
}

#define DEC_BOARD_SHOWN 20
#define DEC_BOARD_PAGE 200
/* Ids are shared with every workspace, so this is how far back from the newest
 * message to look for enough of this workspace's own. */
#define DEC_BOARD_LOOKBACK 200

static char *dec_board_page(ds4_dec *d, long since, char *err, size_t err_len) {
    dec_args a;
    dec_args_init(&a);
    dec_args_int(&a, "limit", DEC_BOARD_PAGE);
    if (since > 0) dec_args_int(&a, "since_id", since);
    return dec_tool_ctx(d, "read_messages", &a, true, err, err_len);
}

/* The most recent messages, as a JSON array. read_messages answers oldest first
 * and a limit keeps the start of that, so the newest id has to be found by paging
 * forward before the end of the board can be asked for. Caller frees. */
static char *dec_board_recent(ds4_dec *d, char *err, size_t err_len) {
    long since = 0;
    for (int page = 0; page < 64; page++) {
        char *payload = dec_board_page(d, since, err, err_len);
        if (!payload) return NULL;
        bool truncated = false;
        long latest = 0;
        dec_json_bool(payload, "truncated", &truncated);
        bool numbered = dec_json_number(payload, "latest_id", &latest) && latest > since;
        if (numbered) since = latest;
        if (!truncated) {
            if (page == 0) {
                char *messages = dec_json_raw(payload, "messages");
                free(payload);
                return messages;
            }
            free(payload);
            break;
        }
        free(payload);
    }
    long from = since > DEC_BOARD_LOOKBACK ? since - DEC_BOARD_LOOKBACK : 0;
    char *payload = dec_board_page(d, from, err, err_len);
    if (!payload) return NULL;
    char *messages = dec_json_raw(payload, "messages");
    free(payload);
    return messages;
}

/* The board is the channel between the agents sharing this workspace. Posting
 * and reading are told apart by what was passed, because one tool call carries
 * one op only: a headline and a body mean a message is being sent. */
static char *dec_op_board(ds4_dec *d, const ds4_dec_call *c) {
    const char *subject = dec_arg(c, "subject");
    const char *body = dec_arg(c, "body");
    const char *why = dec_arg(c, "why");
    const char *who = d->label[0] ? d->label : "ds4-agent";
    char err[512] = {0};

    if ((subject && subject[0]) && (body && body[0])) {
        /* The model's tools speak strings and the server's message ids are
         * numbers, so the conversion happens here, and a word gets named back. */
        const char *reply_to = dec_arg(c, "reply_to");
        long reply = 0;
        if (reply_to && reply_to[0]) {
            char *end = NULL;
            reply = strtol(reply_to[0] == '#' ? reply_to + 1 : reply_to, &end, 10);
            if (!end || *end || reply <= 0) return strdup("reply_to needs a message number.");
        }
        char *text = NULL;
        if (why && why[0]) {
            text = malloc(strlen(body) + strlen(why) + 8);
            if (text) sprintf(text, "%s\n\nwhy: %s", body, why);
        } else text = strdup(body);
        dec_args a;
        dec_args_init(&a);
        dec_args_str(&a, "author", who);
        dec_args_str(&a, "subject", subject);
        dec_args_str(&a, "body", text && text[0] ? text : body);
        if (reply > 0) dec_args_int(&a, "reply_to", reply);
        char *payload = dec_tool_ctx(d, "post_message", &a, true, err, sizeof(err));
        free(text);
        if (!payload) return dec_fail(err);
        long id = 0;
        bool got = dec_json_number(payload, "id", &id);
        free(payload);
        dec_buf b = {0};
        if (got) dec_buf_addf(&b, "Posted to the board as %s (message #%ld).", who, id);
        else dec_buf_addf(&b, "Posted to the board as %s.", who);
        char *out = b.p ? b.p : strdup("Posted to the board.");
        return out;
    }

    /* Reading. The server can restrict the answer to messages that are waiting
     * for this agent by name, which is what an agent should look at first; all=1
     * widens it to everything recent. */
    bool all = dec_arg(c, "all") != NULL;
    char *messages = NULL;
    int first = 0;
    if (all) {
        messages = dec_board_recent(d, err, sizeof(err));
        if (!messages) return dec_fail(err[0] ? err : "the board could not be read");
        int count = 0;
        while (dec_json_elem(messages, count)) count++;
        if (count > DEC_BOARD_SHOWN) first = count - DEC_BOARD_SHOWN;
    } else {
        dec_args a;
        dec_args_init(&a);
        dec_args_str(&a, "unanswered_for", who);
        dec_args_int(&a, "limit", DEC_BOARD_SHOWN);
        char *payload = dec_tool_ctx(d, "read_messages", &a, true, err, sizeof(err));
        if (!payload) return dec_fail(err);
        messages = dec_json_raw(payload, "messages");
        free(payload);
    }
    char *lines = messages ? dec_render_messages(messages, first) : strdup("");
    free(messages);
    dec_buf b = {0};
    if (!lines[0]) {
        if (all) dec_buf_add(&b, "The board is empty.");
        else dec_buf_addf(&b, "The board holds nothing waiting for %s. "
                              "Pass all=1 to read everything recent.", who);
    } else if (all) {
        dec_buf_addf(&b, "Board messages, newest last:\n%s", lines);
    } else {
        dec_buf_addf(&b, "Board messages waiting for %s:\n%s", who, lines);
    }
    free(lines);
    return b.p ? b.p : strdup("");
}

/* Is this node a goal? The id is a generated string, so comparing it as text
 * against the goal list the server returns cannot realistically match anything
 * else, and the answer only ever lets a session claim a goal for itself. */
static bool dec_goal_is_one(ds4_dec *d, const char *node_id) {
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "type", "goal");
    dec_args_int(&a, "limit", 20);
    char err[512] = {0};
    char *payload = dec_tool_ctx(d, "query_nodes", &a, true, err, sizeof(err));
    if (!payload) return false;
    char *nodes = dec_json_raw(payload, "nodes");
    bool found = nodes && node_id && strstr(nodes, node_id) != NULL;
    free(nodes);
    free(payload);
    return found;
}

static char *dec_op_status(ds4_dec *d, const ds4_dec_call *c) {
    const char *node_id = dec_arg(c, "node_id");
    const char *status = dec_arg(c, "status");
    if (!node_id || !node_id[0] || !status || !status[0])
        return strdup("status needs node_id and status.");
    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "node_id", node_id);
    dec_args_str(&a, "status", status);
    char *payload = dec_tool_ctx(d, "update_node", &a, true, err, sizeof(err));
    if (!payload) return dec_fail(err);
    char *title = dec_json_str(payload, "title");
    free(payload);
    char clip[200];
    dec_clip(clip, sizeof(clip), title ? title : "");
    free(title);
    dec_buf b = {0};
    dec_buf_addf(&b, "%s is now %s.", clip[0] ? clip : "Node", status);

    /* A goal node that already exists gets claimed, not duplicated: this is what
     * a resumed session, or a second agent, does when it finds the goal the first
     * one wrote. The id is compared against the goals the server lists. Only
     * status=active picks a goal up: closing one is not taking it on. */
    if (!d->goal_bound && !strcmp(status, "active") && dec_goal_is_one(d, node_id)) {
        d->goal_bound = true;
        d->offered_goal_id[0] = '\0';
        snprintf(d->goal_id, sizeof(d->goal_id), "%s", node_id);
        snprintf(d->goal_title, sizeof(d->goal_title), "%s", clip);
        dec_buf_add(&b, " It is now this session's bound goal; the goals other sessions"
                        " hold stay theirs.");
    }
    return b.p ? b.p : strdup("Node updated");
}
/* ---- the seam the agent uses ------------------------------------------- */

char *ds4_dec_execute(ds4_dec *d, const ds4_dec_call *call, char *err, size_t err_len) {
    if (err && err_len) err[0] = '\0';
    if (!d || !d->active) {
        dec_set_err(err, err_len, "%s", "no deciduous server is connected");
        return NULL;
    }
    if (!call || !call->tool || !call->tool[0]) {
        dec_set_err(err, err_len, "%s",
                    "deciduous needs op=decide|turn|note|graph|board|goal|status");
        return NULL;
    }

    const char *tool = call->tool;

    /* A call that left out the one field an op cannot work without is a mistake
     * the model can fix, not a node to write: ds4 names the field and sends
     * nothing, so a half-finished call never lands in the graph. */
#define dec_has(call, name) (dec_arg((call), name) && dec_arg((call), name)[0])
    if (!strcmp(tool, "decide") && (!dec_has(call, "title") || !dec_has(call, "chosen_option"))) {
        dec_set_err(err, err_len, "%s",
                    "decide needs title and chosen_option: what was weighed, and what was "
                    "picked. rejected_option names what it beat.");
        return NULL;
    }
    if (!strcmp(tool, "turn") && !dec_has(call, "summary")) {
        dec_set_err(err, err_len, "%s", "turn needs summary: what this step changed.");
        return NULL;
    }
    if (!strcmp(tool, "note") && !dec_has(call, "title")) {
        dec_set_err(err, err_len, "%s", "note needs title: the fact worth keeping.");
        return NULL;
    }
    if (!strcmp(tool, "goal") && !dec_has(call, "prompt")) {
        dec_set_err(err, err_len, "%s",
                    "goal needs prompt: the request as it was asked, or as it now applies.");
        return NULL;
    }
    if (!strcmp(tool, "graph") && !dec_has(call, "question")) {
        dec_set_err(err, err_len, "%s", dec_has(call, "node_id")
                    ? "graph asks the graph a question; it does not read one node. "
                      "op=status node_id= changes a node's status."
                    : "graph needs question: what you want to know, in your own words.");
        return NULL;
    }
    /* A board message is posted with both halves, or the board is read with
     * neither. A half-message is not a message. */
    if (!strcmp(tool, "board") && dec_has(call, "subject") != dec_has(call, "body")) {
        dec_set_err(err, err_len, "%s",
                    "board: a message needs subject and body; pass neither to read it.");
        return NULL;
    }
#undef dec_has

    /* A write needs something to be about. The graph is only worth keeping if
     * every node traces back to a goal, so ds4 refuses to record a decision, a
     * step or a fact while the session holds none, and says what to do instead.
     * Reading, the board and moving a node by hand stay available. */
    if (!d->goal_id[0] && (!strcmp(tool, "decide") || !strcmp(tool, "turn") ||
                           !strcmp(tool, "note"))) {
        dec_set_err(err, err_len, "%s",
                    "no goal is bound for this session, so this has nothing to be about: "
                    "write the request as a goal first with op=goal and prompt=");
        return NULL;
    }

    char *obs = NULL;
    if (!strcmp(tool, "decide"))
        obs = dec_op_decide(d, call);
    else if (!strcmp(tool, "turn"))
        obs = dec_op_turn(d, call);
    else if (!strcmp(tool, "graph"))
        obs = dec_op_graph(d, call);
    else if (!strcmp(tool, "board"))
        obs = dec_op_board(d, call);
    else if (!strcmp(tool, "note"))
        obs = dec_op_note(d, call);
    else if (!strcmp(tool, "goal"))
        obs = dec_op_goal(d, dec_arg(call, "prompt"));
    else if (!strcmp(tool, "status"))
        obs = dec_op_status(d, call);
    else {
        dec_set_err(err, err_len,
                    "deciduous has no op \"%s\"; use decide, turn, graph, board, note, goal or status",
                    tool);
        return NULL;
    }
    return obs;
}

/* What the agent appends to an ordinary tool result. The server's own
 * instructions tell agents when to write and nowhere else, so this never records
 * anything by itself. It reminds the model where work has gone unrecorded: the
 * first edit, a command that worked after an edit, and every DEC_NUDGE_EDITS
 * edits after that with nothing written. A command with no edit behind it is
 * only looking around, however cleanly it exited. */
char *ds4_dec_note_result(ds4_dec *d, const char *tool, const char *arg,
                          const char *observation, int exit_status) {
    (void)arg;
    (void)observation;
    if (!d || !d->active || !tool || !d->goal_id[0]) return NULL;

    bool writes_code = !strcmp(tool, "edit") || !strcmp(tool, "write");
    bool step_worked = !strcmp(tool, "bash") && exit_status == 0;
    if (!writes_code && !step_worked) return NULL;

    if (writes_code) {
        d->edits_since_record++;
        if (d->nudged_choice && d->edits_since_record % DEC_NUDGE_EDITS != 0) return NULL;
        d->nudged_choice = true;
        return strdup("deciduous: that edit settled something. If it was a fork in the road, "
                      "say what and why with op=decide (chosen_option, rejected_option, rationale). "
                      "Do not record reading, searching or planning.");
    }
    if (d->nudged_step || !d->edits_since_record) return NULL;
    d->nudged_step = true;
    return strdup("deciduous: that worked after a change. Record the step with op=turn: "
                  "summary, action, and an outcome with the number or the error.");
}

char *ds4_dec_compaction_digest(ds4_dec *d) {
    if (!d || !d->active) return NULL;
    dec_buf b = {0};
    dec_buf_addf(&b, "deciduous server, workspace %s branch %s\n", d->workspace, d->branch);
    if (d->goal_id[0])
        dec_buf_addf(&b, "Goal held by this session: %s (id %s)\n", d->goal_title, d->goal_id);

    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "type", "decision");
    dec_args_int(&a, "limit", 8);
    char *payload = dec_tool_ctx(d, "query_nodes", &a, true, err, sizeof(err));
    if (payload) {
        char *nodes = dec_json_raw(payload, "nodes");
        free(payload);
        char *lines = nodes ? dec_render_nodes(nodes, 8) : strdup("");
        free(nodes);
        if (lines[0]) {
            dec_buf_add(&b, "Decisions the graph holds for this branch:\n");
            dec_buf_add(&b, lines);
        }
        free(lines);
    }
    char *out = b.p ? b.p : strdup("");
    return out;
}

const char *ds4_dec_recovery_note(const ds4_dec *d) {
    if (!d || !d->active) return NULL;
    static char note[1024];

    /* A resumed session has no transcript to learn the rules from, but it gets
     * them from the prompt section; this note only says where it stands. */
    if (d->goal_bound)
        snprintf(note, sizeof(note),
                 "deciduous: workspace %s branch %s; this session holds the goal (%s: %s).",
                 d->workspace, d->branch, d->goal_id, d->goal_title);
    else if (d->offered_goal_id[0])
        snprintf(note, sizeof(note),
                 "deciduous: workspace %s branch %s. A goal (%s: %s) is on the server and this "
                 "session has not claimed it. Claim that one rather than writing a duplicate "
                 "beside it: op=status with node_id=%s and status=active. If that work is "
                 "finished and this is a new request, write your own goal instead.",
                 d->workspace, d->branch, d->offered_goal_id, d->offered_goal_title,
                 d->offered_goal_id);
    else
        snprintf(note, sizeof(note),
                 "deciduous: workspace %s branch %s, server %s. No goal is bound for this "
                 "session. A fresh request writes its own with op=goal; op=graph asks what "
                 "earlier sessions decided, and op=board reads what other agents left standing.",
                 d->workspace, d->branch, d->url);
    return note;
}

const char *ds4_dec_open_error(void) {
    return g_open_error[0] ? g_open_error : NULL;
}

const char *ds4_dec_rules(const ds4_dec *d) {
    return (d && d->instructions[0]) ? d->instructions : NULL;
}

const char *ds4_dec_goal_id(const ds4_dec *d) {
    return (d && d->goal_id[0]) ? d->goal_id : NULL;
}

bool ds4_dec_goal_bound(const ds4_dec *d) {
    return d && d->goal_bound && d->goal_id[0] != '\0';
}

bool ds4_dec_active(const ds4_dec *d) {
    return d != NULL && d->active;
}

/* ---- the session ------------------------------------------------------ */

/* The handshake is also the rules transfer: the server answers with the text it
 * expects agents to follow, and the session id that follows. */
static bool dec_handshake(ds4_dec *d, char *err, size_t err_len) {
    char *result = NULL;
    d->session[0] = '\0';
    if (!dec_rpc_once(d, "initialize", "{\"protocolVersion\":\"2025-03-26\","
                                        "\"clientInfo\":{\"name\":\"ds4-agent\","
                                        "\"version\":\"1\"},"
                                        "\"capabilities\":{\"tools\":{}}}",
                      false, &result, NULL, err, err_len))
        return false;
    char *instr = dec_json_str(result, "instructions");
    if (instr) {
        snprintf(d->instructions, sizeof(d->instructions), "%s", instr);
        free(instr);
    }
    free(result);
    char note_err[512] = {0};
    dec_rpc_once(d, "notifications/initialized", NULL, true, NULL, NULL, note_err, sizeof(note_err));
    return true;
}

ds4_dec *ds4_dec_open(const char *root, const char *label) {
    g_open_error[0] = '\0';
    if (!root || !root[0]) {
        snprintf(g_open_error, sizeof(g_open_error), "%s", "no repository root to resolve a server from");
        return NULL;
    }

    ds4_dec *d = calloc(1, sizeof(*d));
    if (!d) return NULL;
    snprintf(d->label, sizeof(d->label), "%s",
             (label && label[0]) ? label : "ds4-agent");

    char resolve_err[512] = {0};
    if (!dec_resolve(d, root, resolve_err, sizeof(resolve_err))) {
        snprintf(g_open_error, sizeof(g_open_error), "%s",
                 resolve_err[0] ? resolve_err : "the deciduous server was not found");
        free(d);
        return NULL;
    }

    char err[512] = {0};
    if (!dec_handshake(d, err, sizeof(err))) {
        snprintf(g_open_error, sizeof(g_open_error),
                 "the deciduous server at %s did not complete the handshake: %s",
                 d->url, err);
        free(d);
        return NULL;
    }

    d->active = true;
    return d;
}

/* The goal is the first thing a session writes, and it is written to the
 * server: another session reading the same workspace sees the same goal. With
 * no prompt the call is a read instead, and the answer is what this session
 * could pick up. */
char *ds4_dec_bind_goal(ds4_dec *d, const char *prompt) {
    if (!d || !d->active) return NULL;
    return dec_op_goal(d, prompt);
}

void ds4_dec_release_goal(ds4_dec *d) {
    if (!d) return;
    /* The goal stays on offer on purpose: a new session in the same workspace
     * should be able to claim the goal that is already there instead of writing a
     * second one beside it. It stops being this session's goal all the same, and
     * its change id is not ours, so that goes too. */
    if (d->goal_id[0]) {
        snprintf(d->offered_goal_id, sizeof(d->offered_goal_id), "%s", d->goal_id);
        snprintf(d->offered_goal_title, sizeof(d->offered_goal_title), "%s", d->goal_title);
    }
    d->goal_id[0] = '\0';
    d->goal_title[0] = '\0';
    d->goal_bound = false;
    d->goal_change_id[0] = '\0';
    /* The next session has its own news, so the tally the closing note reads
     * from starts over with the goal. */
    d->wrote_decisions = d->wrote_turns = d->wrote_notes = 0;
    d->decision_title_count = 0;
    d->last_turn[0] = '\0';
    d->edits_since_record = 0;
    d->nudged_choice = d->nudged_step = false;
}

/* What other work already decided about this goal's subject. The goal's own
 * subtree is empty when it is new, which is exactly when a model is most likely
 * to decide again what an earlier goal settled. Nothing is said when the question
 * finds nothing or cannot be asked: the rest of the briefing stands on its own. */
static void dec_brief_related(ds4_dec *d, dec_buf *b, const char *own_decisions) {
    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "question", d->goal_title);
    dec_args_str(&a, "scope", "decisions");
    dec_args_bool(&a, "include_context", false);
    if (strcmp(d->workspace, "*") != 0) dec_args_str(&a, "workspace", d->workspace);
    char *args = dec_args_json(&a);
    char *payload = dec_tool(d, "ask_graph", args, err, sizeof(err));
    free(args);
    char *results = payload ? dec_json_raw(payload, "results") : NULL;
    free(payload);
    if (!results) return;

    dec_buf found = {0};
    int shown = 0;
    for (int i = 0; shown < 3; i++) {
        const char *elem = dec_json_elem(results, i);
        if (!elem) break;
        char *type = dec_json_str(elem, "node_type");
        char *title = dec_json_str(elem, "title");
        if (type && title && title[0] && !strcmp(type, "decision")) {
            char clip[120];
            dec_clip(clip, sizeof(clip), title);
            if (!own_decisions || !strstr(own_decisions, clip)) {
                dec_buf_addf(&found, "%s%s", shown ? "; " : "", clip);
                shown++;
            }
        }
        free(type);
        free(title);
    }
    free(results);
    if (found.p)
        dec_buf_addf(b, "Decided in earlier work on this subject: %s\n", found.p);
    free(found.p);
}

/* What the graph already holds about the bound goal, plus what the other agents
 * on this workspace left waiting on the board. The harness injects it into the
 * system message beside the recovery note, because a model that never sees the
 * record re-litigates decisions that were made and written down, and finds the
 * dead end again. Caller does not free. */
char *ds4_dec_briefing(ds4_dec *d) {
    if (!d || !d->active) return NULL;
    if (!d->goal_bound || !d->goal_id[0]) return NULL;

    const char *who = d->label[0] ? d->label : "ds4-agent";
    char err[512] = {0};
    dec_buf b = {0};
    dec_buf_addf(&b, "\n\nWhat the graph already holds\n");
    dec_buf_addf(&b, "Goal \"%s\", held by this session.\n", d->goal_title);

    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "node_id", d->goal_id);
    dec_args_int(&a, "max_depth", 4);
    dec_args_int(&a, "max_nodes", 60);
    if (strcmp(d->workspace, "*") != 0) dec_args_str(&a, "workspace", d->workspace);
    char *args = dec_args_json(&a);
    char *payload = dec_tool(d, "get_descendants", args, err, sizeof(err));
    free(args);
    char *nodes = payload ? dec_json_raw(payload, "nodes") : NULL;
    free(payload);
    if (!nodes) {
        dec_buf_addf(&b, "It could not be read this time (%s). Ask op=graph before "
                         "writing a decision: the answer may already be on the record.\n",
                    err[0] ? err : "no reason given");
        return b.p;
    }

    /* Options are the alternatives inside decisions; they belong to the node,
     * not to the briefing, so they are counted and not listed. */
    int decisions = 0, observations = 0, other = 0, options = 0;
    dec_buf t_dec = {0}, t_obs = {0}, t_other = {0};
    for (int i = 0;; i++) {
        const char *elem = dec_json_elem(nodes, i);
        if (!elem) break;
        char *type = dec_json_str(elem, "node_type");
        char *title = dec_json_str(elem, "title");
        char *id = dec_json_str(elem, "id");
        bool self = id && !strcmp(id, d->goal_id);
        if (!self && title && title[0]) {
            char clip[150];
            dec_clip(clip, sizeof(clip), title);
            const char *kind = type && type[0] ? type : "node";
            dec_buf *into = NULL;
            int *count = NULL;
            if (!strcmp(kind, "option")) { options++; }
            else if (!strcmp(kind, "decision")) { into = &t_dec; count = &decisions; }
            else if (!strcmp(kind, "observation")) { into = &t_obs; count = &observations; }
            else { into = &t_other; count = &other; }
            if (into) {
                (*count)++;
                if (*count <= 8) {
                    dec_buf_add(into, (*count == 1) ? "" : "; ");
                    dec_buf_add(into, clip);
                }
            }
        }
        free(type);
        free(title);
        free(id);
    }
    free(nodes);
    bool anything = decisions || observations || other || options;
    if (decisions)
        dec_buf_addf(&b, "Decided already (%d): %s%s\n", decisions,
                     t_dec.p ? t_dec.p : "", decisions > 8 ? "; and more" : "");
    if (observations)
        dec_buf_addf(&b, "Observed (%d): %s%s\n", observations,
                     t_obs.p ? t_obs.p : "", observations > 8 ? "; and more" : "");
    if (other)
        dec_buf_addf(&b, "Recorded under it (%d): %s%s\n", other,
                     t_other.p ? t_other.p : "", other > 8 ? "; and more" : "");
    if (options)
        dec_buf_addf(&b, "%d %s weighed under those decisions.\n", options,
                     dec_plural(options, "option", "options"));
    if (!anything)
        dec_buf_addf(&b, "Nothing is recorded under it yet.\n");
    dec_brief_related(d, &b, t_dec.p);
    free(t_dec.p);
    free(t_obs.p);
    free(t_other.p);

    /* What the other sessions on this workspace left waiting for this label. */
    dec_args mb;
    dec_args_init(&mb);
    dec_args_str(&mb, "unanswered_for", who);
    dec_args_int(&mb, "limit", 5);
    if (strcmp(d->workspace, "*") != 0) dec_args_str(&mb, "workspace", d->workspace);
    args = dec_args_json(&mb);
    payload = dec_tool(d, "read_messages", args, err, sizeof(err));
    free(args);
    char *msgs = payload ? dec_json_raw(payload, "messages") : NULL;
    free(payload);
    if (msgs && msgs[0]) {
        dec_buf waiting = {0};
        for (int i = 0;; i++) {
            const char *elem = dec_json_elem(msgs, i);
            if (!elem) break;
            char *author = dec_json_str(elem, "author");
            char *subject = dec_json_str(elem, "subject");
            long id = 0;
            dec_json_number(elem, "id", &id);
            if (subject && subject[0]) {
                char clip[120];
                dec_clip(clip, sizeof(clip), subject);
                dec_buf_addf(&waiting, "- #%ld from %s: %s\n", id,
                             author && author[0] ? author : "?", clip);
            }
            free(author);
            free(subject);
            if (i >= 4) break;
        }
        free(msgs);
        if (waiting.p && waiting.p[0])
            dec_buf_addf(&b, "Waiting on the board for %s:\n%s", who, waiting.p);
        free(waiting.p);
    } else free(msgs);

    dec_buf_add(&b, "Ask op=graph before writing a decision: this is the record of what\n"
                    "was tried and what each choice beat, and finding a dead end twice is\n"
                    "the expensive mistake available to you.\n");
    return b.p;
}

/* The server reads @word in a message as an address, and the closing note quotes
 * titles written about other things: a decision about @types/node should not
 * page a label called types. The note addresses nobody. */
static void dec_unmention(char *text) {
    char *to = text;
    for (const char *from = text; *from; from++)
        if (*from != '@') *to++ = *from;
    *to = '\0';
}

/* The session's news for the other agents sharing this workspace, posted where
 * they will read it. Only when this session recorded reasoning: a message
 * saying nothing happened is noise the others have to read past. Built from
 * what the session wrote rather than from the transcript, so compaction cannot
 * change what it says. Caller frees. */
char *ds4_dec_close_session(ds4_dec *d) {
    if (!d || !d->active) return NULL;
    if (!d->wrote_decisions && !d->wrote_turns && !d->wrote_notes) return NULL;

    const char *who = d->label[0] ? d->label : "ds4-agent";
    char clip_goal[120];
    dec_clip_title(clip_goal, sizeof(clip_goal), d->goal_title);
    char subject[200];
    if (clip_goal[0])
        snprintf(subject, sizeof(subject), "%s: %d %s, %d %s, %d %s",
                 clip_goal,
                 d->wrote_decisions, dec_plural(d->wrote_decisions, "decision", "decisions"),
                 d->wrote_turns, dec_plural(d->wrote_turns, "step", "steps"),
                 d->wrote_notes, dec_plural(d->wrote_notes, "note", "notes"));
    else
        snprintf(subject, sizeof(subject), "%s by %s: %d %s, %d %s, %d %s",
                 "session", who,
                 d->wrote_decisions, dec_plural(d->wrote_decisions, "decision", "decisions"),
                 d->wrote_turns, dec_plural(d->wrote_turns, "step", "steps"),
                 d->wrote_notes, dec_plural(d->wrote_notes, "note", "notes"));

    dec_buf body = {0};
    dec_buf_addf(&body, "This session recorded %d %s, %d %s and %d %s",
                 d->wrote_decisions, dec_plural(d->wrote_decisions, "decision", "decisions"),
                 d->wrote_turns, dec_plural(d->wrote_turns, "step", "steps"),
                 d->wrote_notes, dec_plural(d->wrote_notes, "observation", "observations"));
    if (clip_goal[0]) dec_buf_addf(&body, " under the goal \"%s\"", clip_goal);
    dec_buf_add(&body, ".");
    if (d->decision_title_count) {
        dec_buf_add(&body, "\n\nDecisions:");
        for (int i = 0; i < d->decision_title_count; i++)
            dec_buf_addf(&body, "\n- %s", d->decision_titles[i]);
    }
    if (d->last_turn[0])
        dec_buf_addf(&body, "\n\nLast step closed off: %s", d->last_turn);
    dec_buf_addf(&body, "\n\nThe graph holds the reasoning: workspace %s, branch %s.",
                 d->workspace, d->branch);

    dec_unmention(subject);
    if (body.p) dec_unmention(body.p);

    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "author", who);
    dec_args_str(&a, "subject", subject);
    dec_args_str(&a, "body", body.p ? body.p : "");
    char *payload = dec_tool_ctx(d, "post_message", &a, true, err, sizeof(err));
    free(body.p);
    if (!payload) {
        dec_buf b = {0};
        dec_buf_addf(&b, "could not post the closing note to the board: %s",
                     err[0] ? err : "no reason given");
        return b.p;
    }
    free(payload);
    /* The news is told: a session that ends and a session that starts over at
     * /new must not post the same note twice. */
    d->wrote_decisions = d->wrote_turns = d->wrote_notes = 0;
    d->decision_title_count = 0;
    d->last_turn[0] = '\0';
    char clip_subject[200];
    dec_clip(clip_subject, sizeof(clip_subject), subject);
    dec_buf out = {0};
    dec_buf_addf(&out, "closing note posted to the board: %s", clip_subject);
    return out.p ? out.p : strdup("closing note posted to the board");
}

/* Closing a goal is something the operator asks for, never something ds4
 * concludes: a session ending is not evidence the work finished, and a goal
 * wrongly marked finished misleads every session that reads the graph after.
 * The server's word for a finished goal is `completed`; the CLI help prints
 * `done`, which this server rejects. */
char *ds4_dec_mark_goal_done(ds4_dec *d) {
    if (!d || !d->active)
        return strdup("no decision graph is open for this session; ds4 keeps no "
                      "local graph, so there is no goal to close.");
    if (!d->goal_bound || !d->goal_id[0])
        return strdup("no goal is bound for this session; /goal <text> binds one first.");

    char err[512] = {0};
    dec_args a;
    dec_args_init(&a);
    dec_args_str(&a, "node_id", d->goal_id);
    dec_args_str(&a, "status", "completed");
    char *payload = dec_tool_ctx(d, "update_node", &a, true, err, sizeof(err));
    if (!payload) {
        dec_buf b = {0};
        dec_buf_addf(&b, "could not mark the goal completed on the server: %s",
                     err[0] ? err : "no reason given");
        return b.p;
    }
    char *status = dec_json_str(payload, "status");
    free(payload);
    char clip_goal[DS4_DEC_GOAL_TITLE_MAX];
    dec_clip(clip_goal, sizeof(clip_goal), d->goal_title);
    const char *now = status && status[0] ? status : "completed";
    dec_buf b = {0};
    if (clip_goal[0])
        dec_buf_addf(&b, "goal completed on the server: \"%s\" (now %s)\n",
                     clip_goal, now);
    else
        dec_buf_addf(&b, "goal completed on the server (id %s, now %s)\n",
                     d->goal_id, now);
    dec_buf_add(&b, "The record stands: /goal <text> or /new starts the next line of work.");
    free(status);
    return b.p;
}

void ds4_dec_close(ds4_dec *d) {
    /* Every field is an array inside this one allocation. */
    free(d);
}

const char *ds4_dec_prompt_section(const ds4_dec *d) {
    static const char text[] =
        "\n\n# Deciduous decision graph\n"
        "This project's decisions live on the deciduous server, not on disk: it holds\n"
        "every project's graph in one PostgreSQL database, and this session writes into\n"
        "the workspace for this repository. You never maintain files, and nothing you\n"
        "write here is stored in the repository. One Postgres behind one endpoint; the\n"
        "workspace keeps projects apart.\n"
        "You do not have the server's tool names. The deciduous tool gives you seven\n"
        "operations over it:\n"
        "- op=decide records a real choice: title, chosen_option, one or more\n"
        "  rejected_option, rationale. The graph stores the chosen option as the\n"
        "  possibility that survived and each rejected option as the road closed off.\n"
        "- op=turn records one step of the work: summary, and as many observation,\n"
        "  decision, action and outcome lines as you supply.\n"
        "- op=note logs a durable fact you discovered: title, and why it matters.\n"
        "- op=graph is how you read. Ask it a question before writing anything: the\n"
        "  graph already holds what was learned about this problem, and repeating a\n"
        "  dead end is the most expensive mistake available to you.\n"
        "- op=board is how you talk to the other sessions sharing this workspace: pass\n"
        "  subject and body (and why) to post one, and pass neither to read the messages\n"
        "  that are waiting on you; add all=1 to see everything recent.\n"
        "- op=goal and op=status are for the goal node itself: pass prompt to goal when\n"
        "  no goal is bound, and node_id with status to move a node by hand.\n"
        "Write while you work, at these moments, not afterwards:\n"
        "- You see more than one way to do it and pick one: op=decide, naming what it beat.\n"
        "- You change code or config, and it works or fails: op=turn with action and\n"
        "  outcome, the outcome carrying the number or the error.\n"
        "- You learn a fact that changes the plan: op=note.\n"
        "- An earlier choice turns out wrong: op=decide, saying in the title which choice\n"
        "  it replaces, rather than logging the same choice a second time.\n"
        "Do not log your own reading, searching or planning: the graph is memory for the\n"
        "agent that comes after you, including you after compaction.\n"
        "Write failures are reported and never hidden; a missing record is a real loss,\n"
        "so say when one happened rather than working around it.\n";

    static char shown[6144];
    if (!d || !d->active) return text;
    char goal[DS4_DEC_GOAL_TITLE_MAX + 96] = {0};
    if (d->goal_id[0])
        snprintf(goal, sizeof(goal), "\nGoal held by this session: \"%s\" (id %s)",
                 d->goal_title, d->goal_id);
    snprintf(shown, sizeof(shown), "%s\nWorkspace \"%s\", branch \"%s\", server %s%s",
             text, d->workspace, d->branch, d->url, goal);
    return shown;
}
