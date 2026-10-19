#!/bin/sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-host.sh"
if ssh -p "$PHONE_PORT" "$PHONE" 'tmux has-session -t aadi 2>/dev/null'; then
  echo "tmux session aadi already running."
  exit 0
fi
ssh -p "$PHONE_PORT" "$PHONE" "tmux new-session -d -s aadi 'cd ~/aadi-agent && (termux-wake-lock || true); while true; do npm start; sleep 5; done'"
