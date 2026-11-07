#include "ds4_remote.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define REMOTE_CONNECT_MS 5000
#define REMOTE_POLL_MS 200
/* A long prompt prefills in silence, so this has to outlast the slowest prefill. */
#define REMOTE_IDLE_SEC 1800
#define REMOTE_BODY_MAX (64u * 1024u * 1024u)

struct ds4_remote {
    char host[256];
    char port[16];
    char *model;
    int context;
};

typedef struct {
    char *p;
    size_t len;
    size_t cap;
} rbuf;

static void *rxalloc(void *old, size_t n) {
    void *p = realloc(old, n);
    if (!p) {
        fprintf(stderr, "ds4-agent: out of memory\n");
        abort();
    }
    return p;
}

static void rbuf_add(rbuf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        b->cap = (b->len + n + 1) * 2;
        b->p = rxalloc(b->p, b->cap);
    }
    if (n) memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = '\0';
}

static void rbuf_puts(rbuf *b, const char *s) {
    rbuf_add(b, s, strlen(s));
}

static void rbuf_printf(rbuf *b, const char *fmt, ...) {
    char tmp[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (n > 0) rbuf_add(b, tmp, (size_t)n < sizeof(tmp) ? (size_t)n : sizeof(tmp) - 1);
}

/* ---- JSON: only reading, and only what a chat completion carries. ---- */

static const char *json_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/* NULL on malformed input, otherwise just past the value at p. */
static const char *json_skip(const char *p) {
    p = json_ws(p);
    if (*p == '"') {
        for (p++; *p && *p != '"'; p++)
            if (*p == '\\' && !*++p) return NULL;
        return *p ? p + 1 : NULL;
    }
    if (*p == '{' || *p == '[') {
        char close = *p == '{' ? '}' : ']';
        p = json_ws(p + 1);
        if (*p == close) return p + 1;
        while (*p) {
            if (close == '}') {
                p = json_skip(p);
                if (!p) return NULL;
                p = json_ws(p);
                if (*p != ':') return NULL;
                p++;
            }
            p = json_skip(p);
            if (!p) return NULL;
            p = json_ws(p);
            if (*p == close) return p + 1;
            if (*p != ',') return NULL;
            p = json_ws(p + 1);
        }
        return NULL;
    }
    const char *start = p;
    while (*p && !strchr(",]} \t\r\n", *p)) p++;
    return p == start ? NULL : p;
}

static void utf8_put(rbuf *b, unsigned c) {
    char u[4];
    size_t n;
    if (c < 0x80) {
        u[0] = (char)c;
        n = 1;
    } else if (c < 0x800) {
        u[0] = (char)(0xc0 | (c >> 6));
        u[1] = (char)(0x80 | (c & 0x3f));
        n = 2;
    } else if (c < 0x10000) {
        u[0] = (char)(0xe0 | (c >> 12));
        u[1] = (char)(0x80 | ((c >> 6) & 0x3f));
        u[2] = (char)(0x80 | (c & 0x3f));
        n = 3;
    } else {
        u[0] = (char)(0xf0 | (c >> 18));
        u[1] = (char)(0x80 | ((c >> 12) & 0x3f));
        u[2] = (char)(0x80 | ((c >> 6) & 0x3f));
        u[3] = (char)(0x80 | (c & 0x3f));
        n = 4;
    }
    rbuf_add(b, u, n);
}

static bool hex4(const char *p, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        if (!isxdigit((unsigned char)p[i])) return false;
        char c = (char)tolower((unsigned char)p[i]);
        v = v * 16 + (unsigned)(c <= '9' ? c - '0' : c - 'a' + 10);
    }
    *out = v;
    return true;
}

/* The decoded string at p, or NULL when p is not one. */
static char *json_string(const char *p, const char **end) {
    p = json_ws(p);
    if (*p != '"') return NULL;
    rbuf b = {0};
    rbuf_add(&b, "", 0);
    for (p++; *p && *p != '"'; p++) {
        if (*p != '\\') {
            rbuf_add(&b, p, 1);
            continue;
        }
        p++;
        unsigned c;
        switch (*p) {
        case 'n': rbuf_add(&b, "\n", 1); break;
        case 't': rbuf_add(&b, "\t", 1); break;
        case 'r': rbuf_add(&b, "\r", 1); break;
        case 'b': rbuf_add(&b, "\b", 1); break;
        case 'f': rbuf_add(&b, "\f", 1); break;
        case 'u':
            if (!hex4(p + 1, &c)) goto bad;
            p += 4;
            if (c >= 0xd800 && c < 0xdc00 && p[1] == '\\' && p[2] == 'u') {
                unsigned lo;
                if (!hex4(p + 3, &lo)) goto bad;
                if (lo >= 0xdc00 && lo < 0xe000) {
                    c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
                    p += 6;
                }
            }
            utf8_put(&b, c);
            break;
        case '\0': goto bad;
        default: rbuf_add(&b, p, 1); break;
        }
    }
    if (*p != '"') goto bad;
    if (end) *end = p + 1;
    return b.p;
bad:
    free(b.p);
    return NULL;
}

/* The value of key in the object at json, or NULL. */
static const char *json_member(const char *json, const char *key) {
    const char *p = json_ws(json);
    if (*p != '{') return NULL;
    p = json_ws(p + 1);
    while (*p == '"') {
        const char *after = NULL;
        char *name = json_string(p, &after);
        if (!name) return NULL;
        bool hit = !strcmp(name, key);
        free(name);
        p = json_ws(after);
        if (*p != ':') return NULL;
        p = json_ws(p + 1);
        if (hit) return p;
        p = json_skip(p);
        if (!p) return NULL;
        p = json_ws(p);
        if (*p != ',') return NULL;
        p = json_ws(p + 1);
    }
    return NULL;
}

/* A string member decoded, or NULL when it is absent, null or not a string. */
static char *json_member_string(const char *json, const char *key) {
    const char *v = json_member(json, key);
    return v ? json_string(v, NULL) : NULL;
}

static int json_member_int(const char *json, const char *key, int fallback) {
    const char *v = json_member(json, key);
    return v && (isdigit((unsigned char)*v) || *v == '-') ? atoi(v) : fallback;
}

char *ds4_remote_json_quote(const char *text) {
    rbuf b = {0};
    rbuf_add(&b, "\"", 1);
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        switch (*p) {
        case '"': rbuf_add(&b, "\\\"", 2); break;
        case '\\': rbuf_add(&b, "\\\\", 2); break;
        case '\n': rbuf_add(&b, "\\n", 2); break;
        case '\r': rbuf_add(&b, "\\r", 2); break;
        case '\t': rbuf_add(&b, "\\t", 2); break;
        default:
            if (*p < 0x20) rbuf_printf(&b, "\\u%04x", *p);
            else rbuf_add(&b, (const char *)p, 1);
        }
    }
    rbuf_add(&b, "\"", 1);
    return b.p;
}

static void each_value(const char *key, const char *v, const char *end,
                       void (*fn)(void *, const char *, const char *, bool), void *ud) {
    if (*v == '"') {
        char *s = json_string(v, NULL);
        if (s) fn(ud, key, s, true);
        free(s);
        return;
    }
    size_t n = (size_t)(end - v);
    char *raw = rxalloc(NULL, n + 1);
    memcpy(raw, v, n);
    raw[n] = '\0';
    fn(ud, key, raw, false);
    free(raw);
}

bool ds4_remote_json_each(const char *json,
                          void (*fn)(void *ud, const char *key, const char *value, bool is_string),
                          void *ud) {
    const char *p = json_ws(json);
    const char *whole = json_skip(p);
    if (*p != '{' || !whole || *json_ws(whole)) return false;
    p = json_ws(p + 1);
    while (*p == '"') {
        const char *after = NULL;
        char *key = json_string(p, &after);
        if (!key) return false;
        p = json_ws(json_ws(after) + 1);
        const char *end = json_skip(p);
        if (!end) {
            free(key);
            return false;
        }
        if (*p == '[') {
            const char *e = json_ws(p + 1);
            while (*e && *e != ']') {
                const char *next = json_skip(e);
                if (!next) break;
                each_value(key, e, next, fn, ud);
                e = json_ws(next);
                if (*e == ',') e = json_ws(e + 1);
            }
        } else {
            each_value(key, p, end, fn, ud);
        }
        free(key);
        p = json_ws(end);
        if (*p == ',') p = json_ws(p + 1);
    }
    return true;
}

/* ---- HTTP ---- */

static void set_err(char *err, size_t err_len, const char *fmt, ...) {
    if (!err || !err_len) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, err_len, fmt, ap);
    va_end(ap);
}

static bool split_url(ds4_remote *r, const char *url, char *err, size_t err_len) {
    if (!strncmp(url, "https://", 8)) {
        set_err(err, err_len, "%s: https is not supported, use the plain http address", url);
        return false;
    }
    const char *p = !strncmp(url, "http://", 7) ? url + 7 : url;
    size_t host_len = strcspn(p, ":/");
    if (!host_len || host_len >= sizeof(r->host)) {
        set_err(err, err_len, "%s: no host in that URL", url);
        return false;
    }
    memcpy(r->host, p, host_len);
    r->host[host_len] = '\0';
    p += host_len;
    snprintf(r->port, sizeof(r->port), "8000");
    if (*p == ':') {
        size_t port_len = strcspn(++p, "/");
        if (!port_len || port_len >= sizeof(r->port)) {
            set_err(err, err_len, "%s: bad port", url);
            return false;
        }
        memcpy(r->port, p, port_len);
        r->port[port_len] = '\0';
        p += port_len;
    }
    /* Clients are told the base URL ends in /v1, so take it with or without. */
    if (*p && strcmp(p, "/") && strcmp(p, "/v1") && strcmp(p, "/v1/")) {
        set_err(err, err_len, "%s: expected http://host:port or http://host:port/v1", url);
        return false;
    }
    return true;
}

static int tcp_connect(const ds4_remote *r, char *err, size_t err_len) {
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM}, *ai = NULL;
    int rc = getaddrinfo(r->host, r->port, &hints, &ai);
    if (rc) {
        set_err(err, err_len, "cannot resolve %s: %s", r->host, gai_strerror(rc));
        return -1;
    }
    int fd = -1, last = 0;
    for (struct addrinfo *a = ai; a; a = a->ai_next) {
        fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (fd < 0) {
            last = errno;
            continue;
        }
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        int c = connect(fd, a->ai_addr, a->ai_addrlen);
        if (c != 0 && errno == EINPROGRESS) {
            struct pollfd pfd = {.fd = fd, .events = POLLOUT};
            int soerr = ETIMEDOUT;
            socklen_t sl = sizeof(soerr);
            if (poll(&pfd, 1, REMOTE_CONNECT_MS) > 0)
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &sl);
            errno = soerr;
            c = soerr ? -1 : 0;
        }
        if (c == 0) {
            fcntl(fd, F_SETFL, flags);
#ifdef SO_NOSIGPIPE
            int one = 1;
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
            break;
        }
        last = errno;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(ai);
    if (fd < 0) set_err(err, err_len, "cannot connect to %s:%s: %s", r->host, r->port, strerror(last));
    return fd;
}

static bool send_all(int fd, const char *p, size_t n) {
#ifdef MSG_NOSIGNAL
    const int flags = MSG_NOSIGNAL;
#else
    const int flags = 0;
#endif
    while (n) {
        ssize_t w = send(fd, p, n, flags);
        if (w < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        p += w;
        n -= (size_t)w;
    }
    return true;
}

static bool send_request(const ds4_remote *r, int fd, const char *method, const char *path,
                         const char *body, char *err, size_t err_len) {
    rbuf req = {0};
    rbuf_printf(&req, "%s %s HTTP/1.1\r\nHost: %s:%s\r\nUser-Agent: ds4-agent/1\r\n"
                      "Connection: close\r\n", method, path, r->host, r->port);
    if (body) rbuf_printf(&req, "Content-Type: application/json\r\nContent-Length: %zu\r\n",
                          strlen(body));
    rbuf_puts(&req, "\r\n");
    if (body) rbuf_puts(&req, body);
    bool ok = send_all(fd, req.p, req.len);
    if (!ok) set_err(err, err_len, "cannot send to %s:%s: %s", r->host, r->port, strerror(errno));
    free(req.p);
    return ok;
}

typedef enum { READ_DATA, READ_EOF, READ_CANCELLED, READ_FAILED } read_result;

static read_result read_some(int fd, rbuf *in, const ds4_remote_request *req,
                             char *err, size_t err_len) {
    time_t deadline = time(NULL) + REMOTE_IDLE_SEC;
    for (;;) {
        if (req && req->cancelled && req->cancelled(req->ud)) return READ_CANCELLED;
        struct pollfd pfd = {.fd = fd, .events = POLLIN};
        int rc = poll(&pfd, 1, REMOTE_POLL_MS);
        if (rc < 0 && errno != EINTR) {
            set_err(err, err_len, "poll: %s", strerror(errno));
            return READ_FAILED;
        }
        if (rc > 0) break;
        if (time(NULL) >= deadline) {
            set_err(err, err_len, "the server said nothing for %d seconds", REMOTE_IDLE_SEC);
            return READ_FAILED;
        }
    }
    char tmp[16384];
    ssize_t n = read(fd, tmp, sizeof(tmp));
    if (n < 0) {
        if (errno == EINTR) return READ_DATA;
        set_err(err, err_len, "read: %s", strerror(errno));
        return READ_FAILED;
    }
    if (n == 0) return READ_EOF;
    rbuf_add(in, tmp, (size_t)n);
    return READ_DATA;
}

/* Reads through the blank line and returns the status code, leaving the bytes after
 * it at the front of in. 0 means it failed or was cancelled, with *result saying which. */
static int read_headers(int fd, rbuf *in, const ds4_remote_request *req,
                        read_result *result, char *err, size_t err_len) {
    char *end = NULL;
    while (!(in->p && (end = strstr(in->p, "\r\n\r\n")))) {
        *result = read_some(fd, in, req, err, err_len);
        if (*result == READ_CANCELLED || *result == READ_FAILED) return 0;
        if (*result == READ_EOF) {
            *result = READ_FAILED;
            set_err(err, err_len, "the server closed the connection without a reply");
            return 0;
        }
    }
    int status = 0;
    if (sscanf(in->p, "HTTP/%*d.%*d %d", &status) != 1) status = 0;
    for (char *p = in->p; p < end; p++) *p = (char)tolower((unsigned char)*p);
    *end = '\0';
    bool chunked = strstr(in->p, "transfer-encoding: chunked") != NULL;
    size_t skip = (size_t)(end + 4 - in->p);
    in->len -= skip;
    memmove(in->p, end + 4, in->len + 1);
    if (!status || chunked) {
        *result = READ_FAILED;
        set_err(err, err_len, status ? "the server replied chunked, which ds4-agent does not read"
                                     : "the server did not reply with HTTP");
        return 0;
    }
    return status;
}

/* The rest of a reply whose end is the peer closing. */
static read_result read_body(int fd, rbuf *in, const ds4_remote_request *req,
                             char *err, size_t err_len) {
    for (;;) {
        if (in->len > REMOTE_BODY_MAX) {
            set_err(err, err_len, "reply larger than %u bytes", REMOTE_BODY_MAX);
            return READ_FAILED;
        }
        read_result got = read_some(fd, in, req, err, err_len);
        if (got != READ_DATA) return got;
    }
}

/* An error reply says why in error.message when it can. */
static void set_http_err(const rbuf *body, int status, char *err, size_t err_len) {
    const char *obj = body->p ? json_member(body->p, "error") : NULL;
    char *msg = obj ? json_member_string(obj, "message") : NULL;
    set_err(err, err_len, "the server answered %d: %s", status,
            msg ? msg : body->p && body->len ? body->p : "no detail");
    free(msg);
}

ds4_remote *ds4_remote_open(const char *url, const char *model, char *err, size_t err_len) {
    ds4_remote *r = rxalloc(NULL, sizeof(*r));
    memset(r, 0, sizeof(*r));
    if (!split_url(r, url, err, err_len)) goto fail;
    int fd = tcp_connect(r, err, err_len);
    if (fd < 0) goto fail;
    rbuf body = {0};
    read_result got = READ_DATA;
    int status = 0;
    if (send_request(r, fd, "GET", "/v1/models", NULL, err, err_len))
        status = read_headers(fd, &body, NULL, &got, err, err_len);
    if (status) got = read_body(fd, &body, NULL, err, err_len);
    close(fd);
    if (!status || got == READ_FAILED) {
        free(body.p);
        goto fail;
    }
    if (status != 200) {
        set_http_err(&body, status, err, err_len);
        free(body.p);
        goto fail;
    }

    const char *data = body.p ? json_member(body.p, "data") : NULL;
    const char *p = data && *data == '[' ? json_ws(data + 1) : NULL;
    while (p && *p == '{') {
        char *id = json_member_string(p, "id");
        if (id && (!model || !strcmp(id, model))) {
            r->model = id;
            r->context = json_member_int(p, "context_length", 0);
            break;
        }
        free(id);
        p = json_skip(p);
        p = p ? json_ws(p) : NULL;
        if (p && *p == ',') p = json_ws(p + 1);
    }
    free(body.p);
    if (!r->model) {
        set_err(err, err_len, model ? "%s:%s does not serve a model called %s"
                                    : "%s:%s serves no models", r->host, r->port, model);
        goto fail;
    }
    if (r->context <= 0) {
        set_err(err, err_len, "%s reports no context_length", r->model);
        goto fail;
    }
    return r;
fail:
    ds4_remote_close(r);
    return NULL;
}

void ds4_remote_close(ds4_remote *r) {
    if (!r) return;
    free(r->model);
    free(r);
}

const char *ds4_remote_model(const ds4_remote *r) {
    return r->model;
}

int ds4_remote_context(const ds4_remote *r) {
    return r->context;
}

void ds4_remote_reply_free(ds4_remote_reply *reply) {
    free(reply->content);
    free(reply->reasoning);
    for (int i = 0; i < reply->call_count; i++) {
        free(reply->calls[i].id);
        free(reply->calls[i].name);
        free(reply->calls[i].arguments);
    }
    free(reply->calls);
    memset(reply, 0, sizeof(*reply));
}

static void append_owned(char **dst, char *more) {
    size_t a = *dst ? strlen(*dst) : 0, b = strlen(more);
    *dst = rxalloc(*dst, a + b + 1);
    memcpy(*dst + a, more, b + 1);
    free(more);
}

/* Calls may arrive whole or spread over chunks by index, so both are one path. */
static void take_tool_deltas(ds4_remote_reply *reply, const char *array) {
    const char *p = json_ws(array + 1);
    while (*p == '{') {
        int index = json_member_int(p, "index", reply->call_count);
        if (index >= 0 && index < 4096) {
            if (index >= reply->call_count) {
                reply->calls = rxalloc(reply->calls, (size_t)(index + 1) * sizeof(*reply->calls));
                memset(reply->calls + reply->call_count, 0,
                       (size_t)(index + 1 - reply->call_count) * sizeof(*reply->calls));
                reply->call_count = index + 1;
            }
            ds4_remote_call *call = &reply->calls[index];
            char *id = json_member_string(p, "id");
            if (id) {
                free(call->id);
                call->id = id;
            }
            const char *fn = json_member(p, "function");
            if (fn) {
                char *s = json_member_string(fn, "name");
                if (s) append_owned(&call->name, s);
                s = json_member_string(fn, "arguments");
                if (s) append_owned(&call->arguments, s);
            }
        }
        p = json_skip(p);
        if (!p) return;
        p = json_ws(p);
        if (*p == ',') p = json_ws(p + 1);
    }
}

static void take_text(ds4_remote_reply *reply, const ds4_remote_request *req,
                      const char *delta, const char *key, bool reasoning) {
    char *s = json_member_string(delta, key);
    if (!s) return;
    if (s[0] && req->on_text) req->on_text(req->ud, reasoning, s, strlen(s));
    append_owned(reasoning ? &reply->reasoning : &reply->content, s);
}

/* One `data:` payload. False when it was an error event, with err filled. */
static bool take_event(ds4_remote_reply *reply, const ds4_remote_request *req, const char *json,
                       char *err, size_t err_len) {
    const char *error = json_member(json, "error");
    if (error && *error == '{') {
        char *msg = json_member_string(error, "message");
        set_err(err, err_len, "the server reported: %s", msg ? msg : json);
        free(msg);
        return false;
    }
    const char *usage = json_member(json, "usage");
    if (usage && *usage == '{') {
        reply->prompt_tokens = json_member_int(usage, "prompt_tokens", 0);
        reply->completion_tokens = json_member_int(usage, "completion_tokens", 0);
        const char *details = json_member(usage, "prompt_tokens_details");
        if (details) reply->cached_tokens = json_member_int(details, "cached_tokens", 0);
    }
    const char *choices = json_member(json, "choices");
    if (!choices || *choices != '[') return true;
    const char *choice = json_ws(choices + 1);
    if (*choice != '{') return true;
    const char *delta = json_member(choice, "delta");
    if (delta) {
        take_text(reply, req, delta, "reasoning_content", true);
        take_text(reply, req, delta, "content", false);
        const char *calls = json_member(delta, "tool_calls");
        if (calls && *calls == '[') take_tool_deltas(reply, calls);
    }
    char *finish = json_member_string(choice, "finish_reason");
    if (finish) {
        snprintf(reply->finish, sizeof(reply->finish), "%s", finish);
        free(finish);
    }
    return true;
}

ds4_remote_status ds4_remote_chat(ds4_remote *r, const char *messages, const char *tools,
                                  const ds4_remote_request *req, ds4_remote_reply *reply,
                                  char *err, size_t err_len) {
    memset(reply, 0, sizeof(*reply));
    rbuf body = {0};
    char *model = ds4_remote_json_quote(r->model);
    rbuf_printf(&body, "{\"model\":%s,\"stream\":true,\"stream_options\":{\"include_usage\":true},"
                       "\"max_tokens\":%d", model, req->max_tokens);
    free(model);
    if (req->temperature >= 0.0f) rbuf_printf(&body, ",\"temperature\":%g", req->temperature);
    rbuf_puts(&body, ",\"messages\":");
    rbuf_puts(&body, messages);
    if (tools) {
        rbuf_puts(&body, ",\"tools\":");
        rbuf_puts(&body, tools);
    }
    rbuf_puts(&body, "}");

    int fd = tcp_connect(r, err, err_len);
    if (fd < 0) {
        free(body.p);
        return DS4_REMOTE_FAILED;
    }
    bool sent = send_request(r, fd, "POST", "/v1/chat/completions", body.p, err, err_len);
    free(body.p);
    if (!sent) {
        close(fd);
        return DS4_REMOTE_FAILED;
    }

    rbuf in = {0};
    read_result got = READ_DATA;
    ds4_remote_status out = DS4_REMOTE_FAILED;
    int status = read_headers(fd, &in, req, &got, err, err_len);
    if (!status) {
        out = got == READ_CANCELLED ? DS4_REMOTE_CANCELLED : DS4_REMOTE_FAILED;
        goto done;
    }
    if (status != 200) {
        if (read_body(fd, &in, req, err, err_len) == READ_CANCELLED) out = DS4_REMOTE_CANCELLED;
        else set_http_err(&in, status, err, err_len);
        goto done;
    }

    /* The stream ends at [DONE]. A close before it is a reply cut short, and treating
     * that as a finished turn would pass half an answer off as the whole one. */
    size_t used = 0;
    for (;;) {
        char *nl;
        while (in.p && (nl = strchr(in.p + used, '\n'))) {
            *nl = '\0';
            char *line = in.p + used;
            used = (size_t)(nl + 1 - in.p);
            if (strncmp(line, "data:", 5)) continue;
            line += 5;
            while (*line == ' ') line++;
            size_t n = strlen(line);
            if (n && line[n - 1] == '\r') line[n - 1] = '\0';
            if (!strcmp(line, "[DONE]")) {
                out = DS4_REMOTE_OK;
                goto done;
            }
            if (!take_event(reply, req, line, err, err_len)) goto done;
        }
        in.len -= used;
        if (in.p) memmove(in.p, in.p + used, in.len + 1);
        used = 0;
        got = read_some(fd, &in, req, err, err_len);
        if (got == READ_CANCELLED) {
            out = DS4_REMOTE_CANCELLED;
            goto done;
        }
        if (got == READ_FAILED) goto done;
        if (got == READ_EOF) {
            set_err(err, err_len, "the server closed the stream before it finished");
            goto done;
        }
    }
done:
    /* Closing is also how a cancelled request reaches the server. */
    close(fd);
    free(in.p);
    return out;
}
