#!/bin/sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-host.sh"
ssh -p "$PHONE_PORT" "$PHONE" 'tmux kill-session -t aadi 2>/dev/null || true'
