#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *join(int n, char **parts) {
    char *out = malloc(32);
    out[0] = '\0';
    for (int i = 0; i < n; i++) {
        strcat(out, parts[i]);
        if (i + 1 < n) strcat(out, ",");
    }
    return out;
}

int main(int argc, char **argv) {
    char *line = join(argc - 1, argv + 1);
    char *copy = malloc(strlen(line));
    strcpy(copy, line);
    free(line);
    printf("%s (%zu)\n", copy, strlen(line));
    return 0;
}
