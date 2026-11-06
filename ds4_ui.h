#ifndef DS4_UI_H
#define DS4_UI_H

#include <stdbool.h>
#include <stddef.h>

/* ds4-server can answer a built chat page as well as the inference API, so a
 * browser and the API it asks share one origin on one port. The page lives at
 * DS4_UI_URL_PREFIX: /chat and /chat/ are its index, /chat/<file> is a file in
 * the built directory, such as an asset the index script imports.
 *
 * Nothing here touches a socket. The resolver turns a URL path into a file path
 * below the built directory and refuses anything that could climb out of it,
 * which is the whole reason the built directory may sit behind an endpoint that
 * has no authentication of its own. */

#define DS4_UI_URL_PREFIX "/chat"
#define DS4_UI_INDEX_FILE "index.html"

typedef enum {
    ds4_ui_none = 0,  /* not a page URL; leave it to the API and its 404 */
    ds4_ui_index,     /* /chat or /chat/: the index file in the built directory */
    ds4_ui_asset      /* /chat/<file>: one file below the built directory */
} ds4_ui_kind;

/* What the URL asks for. Only GET is answered, so any other method arrives here
 * with a path that is not a page URL and keeps the reply it would have had. */
ds4_ui_kind ds4_ui_classify(const char *url_path);

/* The file for a page URL below dir, resolved without a system call: "..", "%"
 * escapes and path separators are refused rather than cleaned, because the point
 * is that no spelling of the request reaches a file outside dir. Returns false
 * when the URL is not a page URL or names something outside the directory, and
 * says why in err when there is room for one. */
bool ds4_ui_asset_path(const char *url_path, const char *dir,
                       char *out, size_t out_len, char *err, size_t err_len);

/* Content type from the file name. A built page holds html, javascript and css;
 * a wrong type is a browser that will not run the script it was sent. */
const char *ds4_ui_content_type(const char *file_path);

/* Read one whole file for one reply. Text assets are served as bytes, so size
 * travels with the data and a NUL in a font or an image does not shorten the
 * reply. The caller frees out_data. */
bool ds4_ui_read_file(const char *file_path, char **out_data, size_t *out_size,
                      char *err, size_t err_len);

#endif /* DS4_UI_H */
