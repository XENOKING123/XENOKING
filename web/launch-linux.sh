#!/usr/bin/env bash
# ── XENO TOOL Web — Linux/macOS launcher ────────────────────────────────────
# Runs the XENO TOOL web server on this machine (great for an always-on box,
# a mini-PC, or a Raspberry-class host). Open the printed URL from any browser
# on your network — phone, laptop, tablet — no install needed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PS5UPLOAD_WEB_MODE=1
export PS5UPLOAD_ENGINE_PORT="${PS5UPLOAD_ENGINE_PORT:-6969}"
export PS5UPLOAD_WEB_DIST="$DIR/dist"

# Best-effort LAN IP for the hint line.
ip_hint="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "${ip_hint:-}" ] && ip_hint="YOUR-IP"

cat <<EOF

  XENO TOOL Web
  =============
  Serving on port ${PS5UPLOAD_ENGINE_PORT}.
  Open  http://${ip_hint}:${PS5UPLOAD_ENGINE_PORT}  from any browser on your network.

  Press Ctrl+C to stop.

EOF

chmod +x "$DIR/xeno-web-server" 2>/dev/null || true
exec "$DIR/xeno-web-server"
