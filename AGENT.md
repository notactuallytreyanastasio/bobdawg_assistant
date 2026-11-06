# Agent Notes

`ds4.c` is a DeepSeek V4 Flash specific inference engine. It is not a generic
GGUF runner. The goal is a small, readable, high-performance C codebase with
Objective-C only where Metal requires it and Metal kernels under `metal/`.

## Goals

- Keep the production path as whole-model Metal graph inference.
- Always make sure that the SSD streaming, CUDA, distributed inference, Metal default inference are not affected by fixes to other parts of the code.
- Keep model loading mmap-backed for the Metal default case; do not eagerly copy the full GGUF. Keep the model loading for SSD streaming of routed experts explicit: allocated buffers, fast reads from disk, always try to hide loading of missing routed experts by loading them while performing the inference of the shared expert and routed experts already in RAM. Always try to hide loading of layers for prefill in SSD streaming mode using the inference time of the current layer as the next one is loaded.
- Keep the CPU backend CPU-only and use it only as reference/debug code.
- Preserve correctness before speed. Do not keep a faster path with unexplained attention, KV cache, or logits drift.
- Make long local agent sessions practical through live KV reuse and disk KV checkpoints.

## Quality Rules

- Keep the implementation small, sharp, easy to understand. Try to write elegant code in a state of grace. Don't settle for the first thing that comes to mind, try to find the most minimal and better working design. Don't introduce slop: very fragile code that just patches specific cases, dead code, useless code and code ways more complicated of how it should be.
- Comment important inference code where the model mechanics, cache lifetime, memory policy, or API orchestration are not obvious from the local code.
- Prefer comments beside the implementation over separate design documents.
- Keep comments instructive and compact: explain why a shape, ordering, cache boundary, or memory choice exists.
- Keep public APIs narrow. CLI/server code should not know tensor internals.
- The decision graph is server state, never local state. `ds4_deciduous.c` speaks
  only the deciduous server's MCP/HTTP API: never shell out to the `deciduous`
  CLI, never open SQLite, keep no local graph file, cache or mirror. Docs and help
  text describe that same single path, so nobody builds a second one by accident.
- Do not add permanent semantic variants behind flags. Diagnostic switches are fine when they validate the one release path.
- Do not introduce C++.

## Safety

- Avoid large CPU inference runs on macOS; the CPU path has previously exposed kernel VM failures with very large mappings.
- Do not run multiple huge model processes concurrently. The instance lock is intentional.

## Layout

- `ds4.c`: model loading, tokenizer, CPU reference code, Metal graph scheduling,
  sessions, disk-cache payload serialization.
- `ds4_cli.c`: command line, linenoise REPL, interactive transcript handling.
- `ds4_server.c`: OpenAI/Anthropic compatible HTTP API, worker queue, streaming,
  tool-call mapping, disk KV cache policy.
- `ds4_agent.c`: the local agent harness: system prompt assembly, per-model tool
  formats and tool dispatch, sessions, compaction, and the deciduous integration.
- `ds4_deciduous.c`, `ds4_deciduous.h`: the deciduous seam, in full. MCP-over-HTTP
  client, the eight graph operations the model is offered, the git link and audit, the prompt teaching and
  the graph briefing, the recovery note, the compaction digest and the closing
  note. The shared server is the only writer; ds4 stores no graph itself, marks a
  goal completed only through the explicit `/done`, and posts a closing note only
  when the session actually recorded something.
- `ds4_hooks.c`, `ds4_hooks.h`: the agent's hooks engine, which runs the commands in
  `.ds4/hooks` at session and tool events. It knows nothing of git or the graph.
- `ds4_graph.c`: `ds4-graph`, the graph's side of git, for `githooks/` to call. It
  links no model. Run `./ds4-graph install` once per clone.
- `ds4_help.c`: the usage text and option descriptions the CLI prints. The parser
  itself is in `ds4_agent.c`; help text and parser must be edited together.
- `ds4_metal.m`: Objective-C Metal runtime and kernel wrappers.
- `metal/*.metal`: compute kernels.
- `tests/`: unit and live integration tests.
- `misc/`: ignored notes, experiments, and old planning material.

This list is not complete, check the files for more info.

## Testing

Use `make` for build validation. Use `make test` for unit/regression tests when a
model and Metal are available. Use live server tests only when intentionally
testing the API surface.

`make ds4_agent_test && ./ds4_agent_test` checks the agent harness without loading
a model, which is the only safe way to test it while a session is running from the
linked `./ds4-agent` binary. Its deciduous graph tests are not mocked: they write
through the shared deciduous server into a workspace of their own (`ds4-selftest`)
and skip themselves, saying why, when that server is not reachable.

`make test-graph-git` runs the git hooks end to end in a throwaway repository: real
git, real `ds4-graph`, the real deciduous server in `ds4-selftest`.

At every major change where one of the following could be affected, make sure to:

1. Test the normal Metal path and that speed is still at the level it was.
2. Test the SSD streaming path.
3. Test the distributed inference if it could be affected, but ask the user before doing so.
4. Check if CUDA could be broken after the change, and ask the user to give you access to the CUDA machine to actually test if everything is still fine.
