# tools

Operator tools written for this repository. They are not part of the C build and
need nothing but the interpreter on the machine that runs them.

| tool | what it does |
| --- | --- |
| `dsession` | records and replays a ds4-agent session: reads the session files the harness writes under `~/.ds4/kvcache`, pulls this workspace's decision graph over MCP, and composes an asciicast v2 recording whose spine is the decisions and whose evidence is the transcript |

    python3 tools/dsession/dsession.py sessions
    python3 tools/dsession/dsession.py demo -o /tmp/session.cast
    python3 tools/dsession/dsession.py play /tmp/session.cast

Each tool keeps its own readme, including the limits that its sources force and
the install line if you want it on PATH.
