/* Serving a built chat page: the resolver and the reader. These tests are the
 * boundary rules - nothing a browser can type reaches a file outside the built
 * directory - so they check the refusals harder than the accepted paths. A
 * fixture directory stands in for npm run build, and the file with a NUL in it
 * stands in for the font or image that must keep its full length.
 */

#include "../ds4_ui.c"

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int failures;
static int checks;
static char fixture[PATH_MAX];
static char outside[PATH_MAX];

#define CHECK(cond, ...)                                                        \
    do {                                                                       \
        checks++;                                                              \
        if (!(cond)) {                                                        \
            failures++;                                                       \
            fprintf(stderr, "ui test: ");                                     \
            fprintf(stderr, __VA_ARGS__);                                     \
            fprintf(stderr, " (%s:%d)\n", __FILE__, __LINE__);                \
        }                                                                     \
    } while (0)

#define WRITE_FILE(path, text) write_file((path), (text), strlen(text))

static void write_file(const char *path, const char *data, size_t len) {
    FILE *fp = fopen(path, "wb");
    if (!fp) {
        fprintf(stderr, "ui test: cannot write %s\n", path);
        exit(1);
    }
    if (len && fwrite(data, 1, len, fp) != len) {
        fprintf(stderr, "ui test: cannot fill %s\n", path);
        exit(1);
    }
    fclose(fp);
}

static void make_dir(const char *relative) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/%s", fixture, relative);
    if (mkdir(path, 0755) != 0 && errno != EEXIST) {
        fprintf(stderr, "ui test: cannot make %s\n", path);
        exit(1);
    }
}

/* A built font, in full: the NUL bytes are the point, and a string literal
 * would stop the write at the first one. */
static const unsigned char font_bytes[] = {
    'W', 'O', 'F', 'F', 0x00, 0x00, 0x02, 'd', 'a', 't', 'a', 0x00
};
#define FONT_BYTES ((const char *)font_bytes)
#define FONT_SIZE (sizeof(font_bytes) / sizeof(font_bytes[0]))

static void fixture_setup(void) {
    char pattern[] = "/tmp/ds4-ui-test-XXXXXX";
    char *made = mkdtemp(pattern);
    if (!made) {
        fprintf(stderr, "ui test: cannot make a fixture directory\n");
        exit(1);
    }
    snprintf(fixture, sizeof(fixture), "%s", made);
    /* The secret sits outside the built directory, where a link could lead. */
    snprintf(outside, sizeof(outside), "/tmp/ds4-ui-outside-%d.txt", (int)getpid());

    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/%s", fixture, DS4_UI_INDEX_FILE);
    WRITE_FILE(path, "<!doctype html>\n<title>ds4 chat</title>\n");
    make_dir("assets");
    snprintf(path, sizeof(path), "%s/assets/index-ab12cd.js", fixture);
    WRITE_FILE(path, "console.log(1);\n");
    snprintf(path, sizeof(path), "%s/assets/page-ab12cd.css", fixture);
    WRITE_FILE(path, "body{color:#111111}\n");
    snprintf(path, sizeof(path), "%s/assets/font-ab12cd.woff2", fixture);
    write_file(path, FONT_BYTES, FONT_SIZE);
    snprintf(path, sizeof(path), "%s/.env", fixture);
    WRITE_FILE(path, "SECRET=not-for-the-page\n");
    snprintf(path, sizeof(path), "%s/link-to-outside", fixture);
    if (symlink(outside, path) != 0) {
        fprintf(stderr, "ui test: cannot make a link in the fixture\n");
        exit(1);
    }
    WRITE_FILE(outside, "outside the built directory\n");
}

static void fixture_teardown(void) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/%s", fixture, DS4_UI_INDEX_FILE);
    unlink(path);
    snprintf(path, sizeof(path), "%s/assets/index-ab12cd.js", fixture);
    unlink(path);
    snprintf(path, sizeof(path), "%s/assets/page-ab12cd.css", fixture);
    unlink(path);
    snprintf(path, sizeof(path), "%s/assets/font-ab12cd.woff2", fixture);
    unlink(path);
    snprintf(path, sizeof(path), "%s/.env", fixture);
    unlink(path);
    snprintf(path, sizeof(path), "%s/link-to-outside", fixture);
    unlink(path);
    snprintf(path, sizeof(path), "%s/assets", fixture);
    rmdir(path);
    unlink(outside);
    rmdir(fixture);
}

static bool resolved(const char *url_path, char *out, size_t out_len) {
    char err[128];
    err[0] = '\0';
    return ds4_ui_asset_path(url_path, fixture, out, out_len, err, sizeof(err));
}

static void test_classify(void) {
    CHECK(ds4_ui_classify("/chat") == ds4_ui_index, "the bare path should ask for the index");
    CHECK(ds4_ui_classify("/chat/") == ds4_ui_index, "the path with its trailing slash too");
    CHECK(ds4_ui_classify("/chat/assets/index-ab12cd.js") == ds4_ui_asset,
          "an asset under the prefix");
    CHECK(ds4_ui_classify("/v1/chat/completions") == ds4_ui_none,
          "a POST endpoint stays out of the page");
    CHECK(ds4_ui_classify("/chatter") == ds4_ui_none, "a longer word is not the prefix");
    CHECK(ds4_ui_classify("/chatbox/app.js") == ds4_ui_none, "nor a longer word with a path");
    CHECK(ds4_ui_classify("/CHAT") == ds4_ui_none, "the path is case sensitive");
    CHECK(ds4_ui_classify("/") == ds4_ui_none, "the root is answered by the server, not here");
    CHECK(ds4_ui_classify(NULL) == ds4_ui_none, "a missing path is not a page");
}

static void test_accepted_paths(void) {
    char out[PATH_MAX];
    CHECK(resolved("/chat/index.html", out, sizeof(out)) && strstr(out, fixture) == out &&
          strstr(out, "/" DS4_UI_INDEX_FILE) != NULL,
          "the index file resolves below the built directory");
    CHECK(resolved("/chat/assets/index-ab12cd.js", out, sizeof(out)) &&
          strstr(out, "/assets/index-ab12cd.js") != NULL,
          "an asset resolves to the file the build wrote");

    CHECK(strcmp(ds4_ui_content_type("/x/y/index.html"), "text/html") == 0, "html");
    CHECK(strcmp(ds4_ui_content_type("/x/y/assets/index-ab12cd.js"), "application/javascript") == 0,
          "javascript");
    CHECK(strcmp(ds4_ui_content_type("/x/page.css"), "text/css") == 0, "css");
    CHECK(strcmp(ds4_ui_content_type("/x/mark.svg"), "image/svg+xml") == 0, "svg");
    CHECK(strcmp(ds4_ui_content_type("/x/font.woff2"), "font/woff2") == 0, "woff2");
    CHECK(strcmp(ds4_ui_content_type("/x/INDEX.HTML"), "text/html") == 0,
          "the type comes from the extension whatever its case");
    CHECK(strcmp(ds4_ui_content_type("/x/bundle"), "application/octet-stream") == 0,
          "a name with no extension is bytes");
    CHECK(strcmp(ds4_ui_content_type("/x/bundle.unknown"), "application/octet-stream") == 0,
          "so is an extension nobody told the server about");
}

static void test_refusals(void) {
    char out[PATH_MAX];
    char err[128];
    struct {
        const char *url_path;
        const char *why;
    } cases[] = {
        {"/chat/../secret", "a climb out of the built directory"},
        {"/chat/assets/../../etc/passwd", "a climb with a directory in front of it"},
        {"/chat/%2e%2e/secret", "a climb written as a percent escape"},
        {"/chat/assets/%2E%2E/secret", "a climb spelled in capitals"},
        {"/chat/assets/%2Fsecret", "a separator written as an escape"},
        {"/chat/a b.js", "a space"},
        {"/chat/a;b.js", "a semicolon"},
        {"/chat/a?b.js", "a question mark"},
        {"/chat/.env", "a dotfile beside the page"},
        {"/chat/assets/", "a trailing slash naming no file"},
        {"/chat//assets/x.js", "an empty segment"},
        {"/chat", "the index asked for as a file"},
        {"/v1/models", "an API path"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        err[0] = '\0';
        bool ok = ds4_ui_asset_path(cases[i].url_path, fixture, out, sizeof(out), err, sizeof(err));
        CHECK(!ok, "%s should be refused", cases[i].why);
        CHECK(err[0] != '\0', "%s says why it was refused", cases[i].why);
    }

    /* A name that would overflow the buffer is refused, not truncated into an
     * open() of some other file. */
    char long_url[520];
    snprintf(long_url, sizeof(long_url), "/chat/%s.js",
             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    char short_out[32];
    err[0] = '\0';
    CHECK(!ds4_ui_asset_path(long_url, fixture, short_out, sizeof(short_out), err, sizeof(err)),
          "a path too long for the buffer");
    CHECK(err[0] != '\0', "a too-long path says why");

    /* Without a built directory there is nothing to answer for the page. */
    char small[PATH_MAX];
    err[0] = '\0';
    CHECK(!ds4_ui_asset_path("/chat/index.html", "", small, sizeof(small), err, sizeof(err)),
          "no built directory configured");
    CHECK(err[0] != '\0', "and the refusal says so");
}

static void test_reading(void) {
    char out[PATH_MAX];
    char err[128];
    char *data = NULL;
    size_t size = 0;

    CHECK(resolved("/chat/assets/index-ab12cd.js", out, sizeof(out)) &&
          ds4_ui_read_file(out, &data, &size, err, sizeof(err)) &&
          size == strlen("console.log(1);\n") && data &&
          memcmp(data, "console.log(1);\n", size) == 0,
          "a built script comes back as its own bytes");
    free(data);
    data = NULL;

    /* The font has NUL bytes inside it and must keep its length: a reply that
     * measured with strlen would cut the file short. */
    CHECK(resolved("/chat/assets/font-ab12cd.woff2", out, sizeof(out)) &&
          ds4_ui_read_file(out, &data, &size, err, sizeof(err)) &&
          size == 12 && data && data[4] == '\0',
          "a file with NUL bytes inside keeps its size");
    free(data);
    data = NULL;

    err[0] = '\0';
    CHECK(resolved("/chat/missing.js", out, sizeof(out)) &&
          !ds4_ui_read_file(out, &data, &size, err, sizeof(err)) && err[0] != '\0',
          "a missing file is refused with a reason");

    err[0] = '\0';
    CHECK(!ds4_ui_read_file(fixture, &data, &size, err, sizeof(err)) && err[0] != '\0',
          "the built directory itself is not a file to serve");

    err[0] = '\0';
    CHECK(resolved("/chat/link-to-outside", out, sizeof(out)) &&
          !ds4_ui_read_file(out, &data, &size, err, sizeof(err)) && err[0] != '\0',
          "a link in the built directory is not followed");
}

int main(void) {
    fixture_setup();
    test_classify();
    test_accepted_paths();
    test_refusals();
    test_reading();
    fixture_teardown();
    if (failures) {
        fprintf(stderr, "ui test: %d of %d checks failed\n", failures, checks);
        return 1;
    }
    printf("ui test: ok (%d checks)\n", checks);
    return 0;
}
