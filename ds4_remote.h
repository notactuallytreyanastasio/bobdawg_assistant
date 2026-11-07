#ifndef DS4_REMOTE_H
#define DS4_REMOTE_H

#include <stdbool.h>
#include <stddef.h>

/* The agent's way to a model it does not hold: OpenAI chat completions over plain
 * HTTP, streamed. This file knows the wire and nothing of tools or sessions; the
 * loop that uses it is worker_run_remote_turn in ds4_agent.c.
 *
 * Plain HTTP only. The intended path is a tailnet, which already encrypts, and
 * ds4-server has no TLS to talk to. An https URL is refused, not downgraded. */

typedef struct ds4_remote ds4_remote;

typedef struct {
    char *id;
    char *name;
    char *arguments;  /* JSON text, as the server sent it */
} ds4_remote_call;

typedef struct {
    char *content;
    char *reasoning;
    ds4_remote_call *calls;
    int call_count;
    char finish[32];
    int prompt_tokens;
    int completion_tokens;
    int cached_tokens;
} ds4_remote_reply;

typedef struct {
    int max_tokens;
    float temperature;  /* negative leaves the server's default */
    /* Text as it arrives; reasoning says which channel it came on. */
    void (*on_text)(void *ud, bool reasoning, const char *text, size_t len);
    bool (*cancelled)(void *ud);
    void *ud;
} ds4_remote_request;

typedef enum {
    DS4_REMOTE_OK,
    DS4_REMOTE_CANCELLED,
    DS4_REMOTE_FAILED,
} ds4_remote_status;

/* Asks the server what it serves. model NULL takes the first id it lists; a named
 * model must be listed, because ds4-server answers any id without complaint and a
 * typo would otherwise go unnoticed. NULL with err filled when it cannot. */
ds4_remote *ds4_remote_open(const char *url, const char *model, char *err, size_t err_len);
void ds4_remote_close(ds4_remote *r);
const char *ds4_remote_model(const ds4_remote *r);
int ds4_remote_context(const ds4_remote *r);

/* messages and tools are JSON arrays; tools may be NULL. The reply is filled on
 * DS4_REMOTE_OK and must be released with ds4_remote_reply_free either way. */
ds4_remote_status ds4_remote_chat(ds4_remote *r, const char *messages, const char *tools,
                                  const ds4_remote_request *req, ds4_remote_reply *reply,
                                  char *err, size_t err_len);
void ds4_remote_reply_free(ds4_remote_reply *reply);

/* text as a quoted JSON string; owned by the caller. */
char *ds4_remote_json_quote(const char *text);

/* Calls fn once per member of a JSON object, and once per element of a member that
 * is an array, which is how a repeated tool argument arrives. value is decoded when
 * is_string, raw JSON text otherwise. False when json is not an object. */
bool ds4_remote_json_each(const char *json,
                          void (*fn)(void *ud, const char *key, const char *value, bool is_string),
                          void *ud);

#endif
