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
# --kv-disk-dir ~/.ds4/server-kv --kv-disk-space-mb 8192.
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
port=8000
prev=""
for a in "$@"; do
  case "$a" in
    --host) has_host=1 ;;
    --ctx) has_ctx=1 ;;
    --kv-disk-dir) has_kv=1 ;;
  esac
  if [ "$prev" = "--port" ]; then port="$a"; fi
  prev="$a"
done

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

echo "serve-tailnet: binding $target (tailnet interface: ${tailnet_iface:-unknown})"
echo "serve-tailnet: LM Studio base URL for a tailnet peer: http://${client_host}:${port}/v1"
echo "serve-tailnet: model list: http://${client_host}:${port}/v1/models"
echo "serve-tailnet: no auth here - restrict who reaches this port with Tailscale ACLs"

exec ./ds4-server ${final[@]+"${final[@]}"} "$@"
