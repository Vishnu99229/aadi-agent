#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock

LOG="$HOME/.termux/boot/tailscale-am.log"
AM="/data/data/com.termux/files/usr/bin/am"

connect_tailscale() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) CONNECT_VPN" >> "$LOG"
  "$AM" broadcast --user 0 \
    -n com.tailscale.ipn/.IPNReceiver \
    -a com.tailscale.ipn.CONNECT_VPN >> "$LOG" 2>&1
}

# Wait for Wi-Fi / Tailscale to be ready after boot, then connect the VPN.
sleep 20
connect_tailscale
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) start MainActivity fallback" >> "$LOG"
"$AM" start --user 0 -n com.tailscale.ipn/.MainActivity >> "$LOG" 2>&1

# Re-send CONNECT_VPN every 10 minutes (harmless if already connected).
nohup sh -c "
  AM=\"$AM\"
  LOG=\"$LOG\"
  while true; do
    sleep 600
    echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) CONNECT_VPN loop\" >> \"\$LOG\"
    \"\$AM\" broadcast --user 0 \\
      -n com.tailscale.ipn/.IPNReceiver \\
      -a com.tailscale.ipn.CONNECT_VPN >> \"\$LOG\" 2>&1
  done
" >/dev/null 2>&1 &

sshd
tmux new-session -d -s aadi "cd ~/aadi-agent && while true; do npm start; sleep 5; done"
