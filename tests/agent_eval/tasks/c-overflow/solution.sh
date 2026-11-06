python3 - <<'P'
s=open('join.c').read()
s=s.replace('char *out = malloc(32);','size_t total = 1;\n    for (int i = 0; i < n; i++) total += strlen(parts[i]) + 1;\n    char *out = malloc(total);')
s=s.replace('malloc(strlen(line));','malloc(strlen(line) + 1);')
s=s.replace('    free(line);\n    printf("%s (%zu)\\n", copy, strlen(line));\n','    printf("%s (%zu)\\n", copy, strlen(line));\n    free(line);\n    free(copy);\n')
open('join.c','w').write(s)
P
