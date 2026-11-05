# session-tools

`dsession.py` turns a ds4-agent session into something you can watch.

It reads the session files the harness already writes under `~/.ds4/kvcache`,
pulls the decision graph for this workspace over MCP (reusing `dcp`'s client,
imported from `~/.local/bin/dcp`), and composes a recording: the decisions as
the spine, the code and the command output from the transcript as the evidence,
played back through a compressed version of the session's own clock.

    python3 dsession.py sessions                  list session files, newest first
    python3 dsession.py extract [file] -o out.jsonl   transcript as JSON-Lines events
    python3 dsession.py graph                     node counts for this workspace
    python3 dsession.py demo [file] -o demo.cast  compose the recording
    python3 dsession.py play demo.cast            watch it
    python3 dsession.py play demo.cast --speed 4  watch it faster
    python3 dsession.py render demo.cast          print it as text, no terminal

To put it on PATH, link it (the file stays in this repository):

    ln -s "$PWD/tools/dsession/dsession.py" ~/.local/bin/dsession

Run the tests from this directory:

    python3 -m unittest test_dsession

Output is asciicast v2, the format the deciduous project already uses for its
own demo. `asciinema` is not installed here and is not required: `play` is a
small player in the same file, and `render` works in a pipe or a diff.

## What the recording is made of

- **The graph supplies the spine and the clock.** Goal, decisions with their
  rejected options, actions, outcomes and observations, in `created_at` order,
  spaced by square root of the real gap with a floor and a ceiling, so a hundred
  and twenty minute session plays in a few minutes and the bursts still look
  like bursts.
- **The transcript supplies the evidence.** File writes, commands with their
  interesting output lines, and the longer stretches of thinking. Each sample
  says where it came from on the footer.

## Known limits, stated rather than hidden

- **The session file has no timestamps.** Only the graph does. Transcript
  samples are interleaved in transcript order, so their footer never claims a
  minute. Joining them to the clock needs a recorder, not a reader.
- **Only the surviving transcript is stored.** Compaction replaces the earlier
  exchange and nothing archives the raw version, so a recording made from these
  files starts from the summary. The scenes before the first logged decision are
  the graph's account, not the transcript's.
- **It reads, it does not record.** `ds4_agent.c` could write these events as
  they happen, with real timestamps, but that loads on relaunch and records
  nothing of the session that built the reader. The event format here is the one
  a live recorder should write.
- **It is one Python file with no dependencies**, stdlib only, like `dcp`.
