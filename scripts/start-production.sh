#!/bin/sh
set -eu

yt-dlp-update.sh

node /opt/bgutil-provider/server/build/main.js >/tmp/bgutil-provider.log 2>&1 &
provider_pid=$!

cleanup() {
  kill "$provider_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node /app/App.js
