#ifndef DS4_WORKSPACE_H
#define DS4_WORKSPACE_H

#include <stdbool.h>
#include <stddef.h>

/* A place for a web chat to work: a directory it can write to and a shell it can run,
 * with nothing of this machine in reach. The server has no authentication and the
 * commands come from a model reading whatever people paste, so anyone who can reach
 * the port is assumed to be running code here.
 *
 * A workspace is a named Docker volume, so it lives in the container runtime's VM and
 * no directory of this machine is mounted. Each tool call is one container from the
 * ds4-sandbox image with no network, a read-only root, no capabilities, an ordinary
 * user, and limits on memory, CPU and processes. The file tools run in there too,
 * because a host that opened a workspace's files could be led out of it by a symlink.
 *
 * The host's part is to start a container and pass bytes through. The request goes to
 * it on stdin and is not read here, what comes back is not trusted, and docker is run
 * directly with a fixed argument list, so no text from a request reaches a shell.
 *
 * An id is the only thing separating one person's workspace from another's, which makes
 * it a secret, like a shared page's. What this does not limit is disk: workspaces share
 * the VM's disk, and only its size bounds them. */

#define DS4_WORKSPACE_IMAGE "ds4-sandbox"
#define DS4_WORKSPACE_ID_CHARS 32
#define DS4_WORKSPACE_MAX_RUNS 4
#define DS4_WORKSPACE_SECONDS 300
#define DS4_WORKSPACE_MAX_REQUEST (8u * 1024u * 1024u)
#define DS4_WORKSPACE_MAX_REPLY (1u * 1024u * 1024u)
#define DS4_WORKSPACE_ARGV_MAX 40

bool ds4_workspace_id_is_valid(const char *id);

/* The argument list for one call, NULL-terminated. The strings it builds go in volume,
 * snapshots and name, which must outlive it. */
void ds4_workspace_argv(const char *docker, const char *id, char *volume, size_t volume_len,
                        char *snapshots, size_t snapshots_len, char *name, size_t name_len,
                        const char *argv[DS4_WORKSPACE_ARGV_MAX]);

/* True when docker answers and the image is there. */
bool ds4_workspace_ready(const char *docker, char *err, size_t err_len);

/* Run one call. Always returns JSON, malloc'd: the tool's own answer, or {"ok":false,...}
 * saying what went wrong around it. seconds past DS4_WORKSPACE_SECONDS is cut to it. */
char *ds4_workspace_run(const char *docker, const char *id, const char *request, int seconds,
                        size_t *out_size);

#endif /* DS4_WORKSPACE_H */
