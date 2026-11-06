#ifndef DS4_SHARE_H
#define DS4_SHARE_H

#include <stdbool.h>
#include <stddef.h>

/* A page from the chat, kept on disk so a link can open it. The page was written
 * by a model and uploaded to a server with no authentication, and it would be
 * served from the origin of the API, so nothing in it is trusted.
 *
 * What a reader gets is the shell: a line saying what this is, and the page in a
 * sandboxed srcdoc frame. The shell holds no script, and everything the page may
 * do is set by DS4_SHARE_POLICY, which goes out as a header on every reply and
 * which a srcdoc frame inherits. A policy inside the upload could be left out by
 * whoever sent it, and this one cannot.
 *
 * The frame is what stops the page navigating away with its data: a top-level page
 * may go to any address, and a frame is held to frame-src.
 *
 * What the policy cannot reach is WebRTC and DNS. A page the chat sends carries the
 * lockdown, which removes WebRTC, and an upload made by hand need not, so that one
 * can send what it holds and learn that it was opened. It still gets nothing of the
 * reader's: its origin is opaque, so that is what any link to any website can do.
 *
 * Nothing here touches a socket. */

#define DS4_SHARE_URL_PATH "/chat/shared"
#define DS4_SHARE_ID_CHARS 32
#define DS4_SHARE_TITLE_BYTES 120
#define DS4_SHARE_MAX_PAGE (4u * 1024u * 1024u)
#define DS4_SHARE_MAX_PAGES 256

/* The chat page's FRAME_POLICY, with sandbox and frame-src added. Its test holds
 * the two together. */
#define DS4_SHARE_POLICY \
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; " \
    "style-src 'unsafe-inline'; img-src data:; frame-src 'none'; form-action 'none'; " \
    "base-uri 'none'; require-trusted-types-for 'script'; trusted-types default"

typedef enum {
    ds4_share_stored = 0,
    ds4_share_too_large,
    ds4_share_full,
    ds4_share_failed
} ds4_share_result;

/* The id a /chat/shared/<id> path names. Only what ds4_share_store makes passes,
 * so no path can reach anything but a page in the directory. */
bool ds4_share_id_of_path(const char *url_path, char id[DS4_SHARE_ID_CHARS + 1]);

/* Make the directory and its parents, for this user alone. */
bool ds4_share_prepare(const char *dir, char *err, size_t err_len);

/* Keep a page under a new random id. */
ds4_share_result ds4_share_store(const char *dir, const char *title, const char *page,
                                 char id[DS4_SHARE_ID_CHARS + 1], char *err, size_t err_len);

/* The reply for a stored page, to be freed by the caller. NULL when there is no
 * such page. */
char *ds4_share_load(const char *dir, const char *id, size_t *out_size);

#endif
