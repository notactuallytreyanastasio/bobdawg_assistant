# Tailnet Serving

[README](../README.md) | [Server](SERVER.md) | [Clients](CLIENTS.md)

Share one Mac Studio's inference with the devices on your Tailscale tailnet,
including LM Studio users who point their chat UI at this server.

ds4-server listens on `127.0.0.1` by default. `serve-tailnet.sh` resolves this
Mac's Tailscale address (an address from `100.64.0.0/10` on a `utun`) and binds
that, so tailnet peers connect while home WiFi and every other interface stay
closed. Prefer it over `--host 0.0.0.0`, which listens everywhere and would
expose an unauthenticated endpoint to the LAN. ds4-server has no authentication
and no TLS: tailnet membership and Tailscale ACLs are the access control.

## Start the server

```sh
./serve-tailnet.sh
```

It prints the base URL tailnet clients should use, including the MagicDNS name
when Tailscale DNS answers. Flags are passed through to ds4-server, and defaults
are added only when you omit them: `--ctx 100000`, `--kv-disk-dir ~/.ds4/server-kv`,
`--kv-disk-space-mb 8192`. `DS4_TAILNET_HOST` forces the bind address if the
discovery picks the wrong interface.

Exactly one ds4 process runs at a time (an exclusive lock on `/tmp/ds4.lock`,
since the model maps tens of GiB). Stop `ds4-agent-poc`, `ds4-agent` or any other
ds4 binary before starting the server, or it refuses to start.

## Check the endpoint

The `100.64.0.1` and `your-mac.your-tailnet.ts.net` strings below
are this host's values; `serve-tailnet.sh` prints the right ones for a machine.

From the server Mac, the tailnet address proves the bind is right; it does not
prove a peer can reach you:

```sh
curl http://100.64.0.1:8000/v1/models
```

From a tailnet peer:

```sh
curl http://your-mac.your-tailnet.ts.net:8000/v1/models
```

Use the IP address instead of the MagicDNS name if that peer has DNS over
Tailscale disabled. If nothing answers, run `tailscale ping your-mac`
from the peer: a working ping with a dead port means a Tailscale ACL rule
(forward or reject) is blocking port 8000.

## LM Studio clients

LM Studio's chat UI has no field for a third-party base URL, and LM Link only
bridges LM Studio and llmster instances over its own dedicated Tailscale
network - its FAQ says it cannot reuse an existing tailnet. On an existing
tailnet, use LM Studio's OpenAI-compatible endpoint plugin instead.

Install the plugin from LM Studio Hub as `lmstudio/openai-compat-endpoint`
("OpenAI Adapter for LM Studio"). To use free-form model IDs, install the
maintained fork `local/universal-openai-endpoint`:

```sh
git clone https://github.com/J0hnSm1thyk/lmstudio-universal-endpoint.git
cd lmstudio-universal-endpoint
npm install
npm run build
lms dev --install
```

`lms` ships with LM Studio; keep the app open during the install.

Then, in LM Studio:

| Setting | Value |
| --- | --- |
| Generation source | the installed endpoint plugin |
| Base URL | `http://your-mac.your-tailnet.ts.net:8000/v1` |
| API key | any non-empty string; ds4-server ignores credentials |
| Request timeout | generous, for long first prefills |
| Model ID | exactly as `GET /v1/models` reports it |

The loaded engine decides the model ID. A Flash Next GGUF reports
`qwen3.8-flash-next`, plus `qwen3.8-flash-next-chat` for answers without
reasoning content and `qwen3.8-flash-next-reasoner` to force reasoning. Copy the
ID from the model list rather than guessing; compatibility aliases report the
same loaded engine.

Set the client's token and context limits no higher than the server's, as
described in [clients](CLIENTS.md): a client limit does not enlarge the server
allocation, and a request that overflows the context fails instead of resizing
it.

## Keep access deliberate

- Restrict port 8000 to the people you intend, with Tailscale ACL rules on the
  tailnet you share. Anyone who can reach the port spends the machine's GPU and
  sees everything they send.
- Do not add `--host 0.0.0.0` to make a client work. Rebind the tailnet address,
  or fix the ACL rule.
- `--cors` adds browser cross-origin headers. It is not access control and does
  not change the listening address.
- If you want per-user identity or TLS, publish the loopback listener with
  `tailscale serve`. That needs the Tailscale CLI installed with admin rights,
  and the server would go back to `--host 127.0.0.1`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `refusing to start` | another ds4 process holds `/tmp/ds4.lock`; stop it |
| No `100.64.0.0/10` address found | Tailscale is not connected on the Mac; or set `DS4_TAILNET_HOST` |
| Peer gets connection refused | peer is not in the tailnet, or an ACL rule blocks port 8000 |
| Peer gets a timeout | relay-only connection with a broken path; `tailscale ping` shows whether the direct link works |
| MagicDNS name does not resolve | the peer has Tailscale DNS disabled; use the `100.x` address |
| Chat requests fail after a long wait | prefill exceeded the plugin request timeout; raise it |
| Requests succeed with curl but the model ID is rejected | the ID must match the loaded engine exactly |
