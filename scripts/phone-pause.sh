#!/bin/sh
ssh -p 8022 u0_a289@192.168.1.7 'tmux kill-session -t aadi 2>/dev/null || true'
