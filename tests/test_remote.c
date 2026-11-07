/* ds4_remote against a socket that says exactly what each case needs, so the failures
 * a healthy server will not produce on demand can be checked. The canned streams keep
 * the shape a live ds4-server sends. */
#include "../ds4_remote.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int failures;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); failures++; } } while (0)

#define MODELS "{\"object\":\"list\",\"data\":[{\"id\":\"m1\",\"context_length\":1000},{\"id\":\"m2\",\"context_length\":2000}]}"
#define SSE "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
#define CHUNK(delta, finish) "data: {\"choices\":[{\"index\":0,\"delta\":" delta ",\"finish_reason\":" finish "}]}\n\n"

typedef struct {
    int listen_fd;
    const char *chat_reply;
    char request[8192];
    bool hold_open;  /* say the reply, then wait for the client to hang up */
} fake;

static void reply_text(int fd, const char *body) {
    char head[128];
    int n = snprintf(head, sizeof(head), "HTTP/1.1 200 OK\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                     strlen(body));
    write(fd, head, (size_t)n);
    write(fd, body, strlen(body));
}

static void *fake_main(void *arg) {
    fake *f = arg;
    for (;;) {
        int fd = accept(f->listen_fd, NULL, NULL);
        if (fd < 0) return NULL;
        char req[8192];
        ssize_t n = read(fd, req, sizeof(req) - 1);
        if (n <= 0) {
            close(fd);
            continue;
        }
        req[n] = '\0';
        if (!strncmp(req, "GET /v1/models", 14)) {
            reply_text(fd, MODELS);
        } else {
            snprintf(f->request, sizeof(f->request), "%s", req);
            write(fd, f->chat_reply, strlen(f->chat_reply));
            if (f->hold_open) {
                char c;
                while (read(fd, &c, 1) > 0) {}
            }
        }
        close(fd);
    }
}

static int fake_start(fake *f, pthread_t *t) {
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    socklen_t len = sizeof(a);
    f->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    bind(f->listen_fd, (struct sockaddr *)&a, sizeof(a));
    listen(f->listen_fd, 8);
    getsockname(f->listen_fd, (struct sockaddr *)&a, &len);
    pthread_create(t, NULL, fake_main, f);
    return ntohs(a.sin_port);
}

typedef struct {
    char text[256];
    char reasoning[256];
    int cancel_after;
    int seen;
} sink;

static void on_text(void *ud, bool reasoning, const char *s, size_t n) {
    sink *k = ud;
    strncat(reasoning ? k->reasoning : k->text, s, n);
    k->seen++;
}

static bool cancelled(void *ud) {
    sink *k = ud;
    return k->cancel_after && k->seen >= k->cancel_after;
}

static ds4_remote_status chat(ds4_remote *r, sink *k, ds4_remote_reply *reply, char *err, size_t n) {
    ds4_remote_request req = {.max_tokens = 16, .temperature = -1.0f, .on_text = on_text,
                              .cancelled = cancelled, .ud = k};
    return ds4_remote_chat(r, "[{\"role\":\"user\",\"content\":\"hi\"}]", NULL, &req, reply, err, n);
}

static void arg_cb(void *ud, const char *key, const char *value, bool is_string) {
    char *out = ud;
    char one[128];
    snprintf(one, sizeof(one), "%s=%s%s;", key, value, is_string ? "" : "!");
    strcat(out, one);
}

static void test_json(void) {
    char *q = ds4_remote_json_quote("a\"b\\c\nd\x01");
    CHECK(!strcmp(q, "\"a\\\"b\\\\c\\nd\\u0001\""));
    free(q);

    char out[512] = "";
    CHECK(ds4_remote_json_each(
        "{\"path\":\"a\\n\\u00e9\\ud83d\\ude00\",\"max\":12,\"whole\":true,"
        "\"o\":[\"x\",\"y\"],\"keep\":\"&lt;/parameter>\"}", arg_cb, out));
    CHECK(!strcmp(out, "path=a\n\xc3\xa9\xf0\x9f\x98\x80;max=12!;whole=true!;o=x;o=y;"
                       "keep=&lt;/parameter>;"));

    out[0] = '\0';
    CHECK(!ds4_remote_json_each("[1,2]", arg_cb, out));
    CHECK(!ds4_remote_json_each("{\"a\":", arg_cb, out));
    CHECK(!ds4_remote_json_each("{\"a\":1} trailing", arg_cb, out));
    CHECK(ds4_remote_json_each("{}", arg_cb, out));
}

static void test_open(int port) {
    char url[64], err[256] = "";
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/v1", port);
    ds4_remote *r = ds4_remote_open(url, NULL, err, sizeof(err));
    CHECK(r && !strcmp(ds4_remote_model(r), "m1") && ds4_remote_context(r) == 1000);
    ds4_remote_close(r);

    r = ds4_remote_open(url, "m2", err, sizeof(err));
    CHECK(r && ds4_remote_context(r) == 2000);
    ds4_remote_close(r);

    CHECK(!ds4_remote_open(url, "nope", err, sizeof(err)) && strstr(err, "nope"));
    CHECK(!ds4_remote_open("https://x", NULL, err, sizeof(err)) && strstr(err, "https"));
    CHECK(!ds4_remote_open("http://x:1/other", NULL, err, sizeof(err)) && strstr(err, "expected"));
}

int main(void) {
    test_json();

    fake f = {0};
    pthread_t t;
    int port = fake_start(&f, &t);
    test_open(port);

    char url[64], err[256];
    snprintf(url, sizeof(url), "http://127.0.0.1:%d", port);
    ds4_remote *r = ds4_remote_open(url, NULL, err, sizeof(err));
    CHECK(r != NULL);
    if (!r) return 1;

    /* A whole reply, with a call spread over two chunks. */
    f.chat_reply = SSE
        CHUNK("{\"role\":\"assistant\"}", "null")
        CHUNK("{\"reasoning_content\":\"think\"}", "null")
        CHUNK("{\"content\":\"hel\"}", "null")
        CHUNK("{\"content\":\"lo\"}", "null")
        CHUNK("{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"pa\"}}]}", "null")
        CHUNK("{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"x\\\"}\"}}]}", "null")
        CHUNK("{}", "\"tool_calls\"")
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,"
        "\"prompt_tokens_details\":{\"cached_tokens\":5}}}\n\n"
        "data: [DONE]\n\n";
    sink k = {0};
    ds4_remote_reply reply;
    CHECK(chat(r, &k, &reply, err, sizeof(err)) == DS4_REMOTE_OK);
    CHECK(!strcmp(k.text, "hello") && !strcmp(k.reasoning, "think"));
    CHECK(reply.call_count == 1 && !strcmp(reply.calls[0].id, "c1"));
    CHECK(!strcmp(reply.calls[0].name, "read"));
    CHECK(!strcmp(reply.calls[0].arguments, "{\"path\":\"x\"}"));
    CHECK(!strcmp(reply.finish, "tool_calls"));
    CHECK(reply.prompt_tokens == 7 && reply.completion_tokens == 3 && reply.cached_tokens == 5);
    CHECK(strstr(f.request, "\"stream\":true") && strstr(f.request, "\"model\":\"m1\""));
    CHECK(!strstr(f.request, "\"temperature\""));
    ds4_remote_reply_free(&reply);

    /* Cut off before [DONE]: half an answer must not pass for a whole one. */
    f.chat_reply = SSE CHUNK("{\"content\":\"half\"}", "null");
    memset(&k, 0, sizeof(k));
    CHECK(chat(r, &k, &reply, err, sizeof(err)) == DS4_REMOTE_FAILED);
    CHECK(strstr(err, "before it finished") != NULL);
    ds4_remote_reply_free(&reply);

    /* The server says why it refused. */
    f.chat_reply = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
                   "{\"error\":{\"message\":\"prompt too long\",\"code\":\"context_length_exceeded\"}}";
    CHECK(chat(r, &k, &reply, err, sizeof(err)) == DS4_REMOTE_FAILED);
    CHECK(strstr(err, "400") && strstr(err, "prompt too long"));
    ds4_remote_reply_free(&reply);

    /* An error after the stream has started. */
    f.chat_reply = SSE "data: {\"error\":{\"message\":\"worker died\"}}\n\n";
    CHECK(chat(r, &k, &reply, err, sizeof(err)) == DS4_REMOTE_FAILED);
    CHECK(strstr(err, "worker died") != NULL);
    ds4_remote_reply_free(&reply);

    /* Chunked is refused rather than misread. */
    f.chat_reply = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
    CHECK(chat(r, &k, &reply, err, sizeof(err)) == DS4_REMOTE_FAILED);
    CHECK(strstr(err, "chunked") != NULL);
    ds4_remote_reply_free(&reply);

    /* Cancel lands while the server is still holding the stream open. */
    f.hold_open = true;
    f.chat_reply = SSE CHUNK("{\"content\":\"one\"}", "null");
    memset(&k, 0, sizeof(k));
    k.cancel_after = 1;
    CHECK(chat(r, &k, &reply, err, sizeof(err)) == DS4_REMOTE_CANCELLED);
    ds4_remote_reply_free(&reply);

    ds4_remote_close(r);
    close(f.listen_fd);
    printf(failures ? "test_remote: %d failed\n" : "test_remote: ok\n", failures);
    return failures != 0;
}
