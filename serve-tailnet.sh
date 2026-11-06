#!/bin/bash
# Serve ds4-server to the Tailscale tailnet this Mac is joined to.
#
# ds4-server binds 127.0.0.1 by default, so tailnet peers cannot reach it. This
# wrapper binds the tailnet address instead of 0.0.0.0, which keeps home WiFi
# and any other interface out of the listening socket. The API has no
# authentication, so the tailnet membership and Tailscale ACLs are the access
# control; see docs/TAILNET.md.
#
# Usage:
#   ./serve-tailnet.sh                  # tailnet bind, default flags below
#   ./serve-tailnet.sh --ctx 32768      # any ds4-server flag is passed through
#   ./serve-tailnet.sh --host 0.0.0.0   # explicit host wins (LAN is then open)
#   DS4_TAILNET_HOST=100.123.0.9 ./serve-tailnet.sh
#
# Defaults added only when you do not pass them: --ctx 100000,
# --kv-disk-dir ~/.ds4/server-kv --kv-disk-space-mb 8192, --share-dir
# ~/.ds4/shared for pages shared from the chat, and --ui-dir for the chat page,
# which is built here when its output is missing or older than the page sources.
# Pass --ui-dir yourself to serve a build from somewhere else.
#
# Only one ds4 process runs at a time (flock on /tmp/ds4.lock); stop
# ds4-agent-poc or any other ds4 binary before starting the server.

set -eu

repo="$(cd "$(dirname "$0")" && pwd)"
cd "$repo"

if [ ! -x ./ds4-server ]; then
  echo "serve-tailnet: ./ds4-server is not built; run 'make ds4-server'" >&2
  exit 1
fi

# Tailscale hands out addresses from 100.64.0.0/10 on utun interfaces.
read -r tailnet_iface tailnet_ip <<EOF || true
$(ifconfig 2>/dev/null | awk '
  /^[a-z][a-z0-9]+:/ { iface = $1; sub(/:$/, "", iface) }
  /^[ \t]+inet [0-9]/ {
    if (iface !~ /^utun/) next
    ip = $2
    split(ip, o, ".")
    if (o[1] == "100" && o[2] + 0 >= 64 && o[2] + 0 <= 127) print iface, ip
    exit
  }' | head -n 1)
EOF

if [ -n "${DS4_TAILNET_HOST:-}" ]; then
  tailnet_ip="$DS4_TAILNET_HOST"
  tailnet_iface="override"
fi

if [ -z "${tailnet_ip:-}" ]; then
  cat >&2 <<MSG
serve-tailnet: no Tailscale address (100.64.0.0/10 on a utun) on this Mac.
Check that Tailscale is connected, or set DS4_TAILNET_HOST to the address to bind.
MSG
  exit 1
fi

has_host=0
has_ctx=0
has_kv=0
has_ui=0
has_share=0
port=8000
prev=""
for a in "$@"; do
  case "$a" in
    --host) has_host=1 ;;
    --ctx) has_ctx=1 ;;
    --kv-disk-dir) has_kv=1 ;;
    --ui-dir) has_ui=1 ;;
    --share-dir) has_share=1 ;;
  esac
  if [ "$prev" = "--port" ]; then port="$a"; fi
  prev="$a"
done

# The chat page is a build artifact like ./ds4-server is, and it is easy to
# forget its build step: build it when dist is missing or older than the page
# sources, and serve what the build produced. A failed build is said once and
# the API still comes up - the page is not why this server is running.
page="chat-web/dist"
page_status="not configured"
if [ "$has_ui" = 1 ]; then
  page_status="yours"
elif [ -d chat-web ]; then
  if command -v npm >/dev/null 2>&1; then
    stale=""
    if [ ! -f "$page/index.html" ]; then
      stale="missing"
    elif [ -n "$(find chat-web/src chat-web/index.html chat-web/vite.config.ts -newer "$page/index.html" -print -quit 2>/dev/null)" ]; then
      stale="older than the page sources"
    fi
    if [ -n "$stale" ]; then
      echo "serve-tailnet: chat page $stale; running npm --prefix chat-web run build" >&2
      if [ ! -d chat-web/node_modules ] && \
         ! npm --prefix chat-web install --no-audit --no-fund >/dev/null 2>&1; then
        echo "serve-tailnet: chat page not built: npm install failed; the API serves anyway" >&2
      elif ! npm --prefix chat-web run build >/dev/null 2>&1; then
        echo "serve-tailnet: chat page not built: npm run build failed; the API serves anyway" >&2
      fi
    fi
  else
    echo "serve-tailnet: npm is not installed; the chat page cannot be built here" >&2
  fi
  if [ -f "$page/index.html" ]; then
    page_status="served"
  else
    page_status="missing"
  fi
fi

target="$tailnet_ip"
if [ "$has_host" = 1 ]; then
  target="your chosen --host"
fi

client_host="$tailnet_ip"
if [ "$has_host" = 0 ] && command -v dig >/dev/null 2>&1; then
  magic="$(dig +short -x "$tailnet_ip" @100.100.100.100 2>/dev/null | head -n 1)"
  magic="${magic%.}"
  case "$magic" in
    *.ts.net) client_host="$magic" ;;
  esac
fi

final=()
if [ "$has_host" = 0 ]; then final+=(--host "$tailnet_ip"); fi
if [ "$has_ctx" = 0 ]; then final+=(--ctx 100000); fi
if [ "$has_kv" = 0 ]; then final+=(--kv-disk-dir "$HOME/.ds4/server-kv" --kv-disk-space-mb 8192); fi
if [ "$has_share" = 0 ]; then final+=(--share-dir "$HOME/.ds4/shared"); fi
if [ "$page_status" = served ]; then
  final+=(--ui-dir "$repo/$page")
fi

echo "serve-tailnet: binding $target (tailnet interface: ${tailnet_iface:-unknown})"
echo "serve-tailnet: LM Studio base URL for a tailnet peer: http://${client_host}:${port}/v1"
echo "serve-tailnet: model list: http://${client_host}:${port}/v1/models"
if [ "$page_status" = served ] || [ "$page_status" = yours ]; then
  echo "serve-tailnet: chat page: http://${client_host}:${port}/chat/"
elif [ "$page_status" = missing ]; then
  echo "serve-tailnet: chat page: not built; the API serves, and npm --prefix chat-web run build makes the page"
fi
echo "serve-tailnet: no auth here - restrict who reaches this port with Tailscale ACLs"

exec ./ds4-server ${final[@]+"${final[@]}"} "$@"
