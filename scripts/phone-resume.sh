#!/bin/sh
if ssh -p 8022 u0_a289@192.168.1.7 'tmux has-session -t aadi 2>/dev/null'; then
  echo "tmux session aadi already running."
  exit 0
fi
ssh -p 8022 u0_a289@192.168.1.7 "tmux new-session -d -s aadi 'cd ~/aadi-agent && while true; do npm start; sleep 5; done'"
