#!/bin/zsh
# Open Memes; request only its own launchd job if the service is stopped.
set -e
URL='http://127.0.0.1:3133/'
HEALTH='http://127.0.0.1:3133/healthz'
LABEL="gui/$(id -u)/local.memes.web"
if ! curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; then
  launchctl kickstart -k "$LABEL"
  for i in {1..20}; do
    if curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
curl -fsS --max-time 3 "$HEALTH" >/dev/null
open "$URL"
