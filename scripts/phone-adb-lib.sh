# Shared helpers for Mac-side wireless ADB / scrcpy scripts.
# shellcheck source=phone-host.sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-host.sh"

PHONE_ADB_PORT="5555"
PHONE_TS_FALLBACK="100.79.235.3"
PHONE_PORT_ERR=""
PHONE_PORT_CMD=""
TAILSCALE_BIN=""

find_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi
  if [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    printf '%s\n' /Applications/Tailscale.app/Contents/MacOS/Tailscale
    return 0
  fi
  if [ -x /usr/local/bin/tailscale ]; then
    printf '%s\n' /usr/local/bin/tailscale
    return 0
  fi
  return 1
}

TAILSCALE_BIN="$(find_tailscale || true)"

resolve_phone_ip() {
  ip=""
  if [ -n "$TAILSCALE_BIN" ]; then
    ip="$("$TAILSCALE_BIN" ip -4 "$PHONE_HOST" 2>/dev/null | awk 'NR==1 { print $1 }')"
  fi
  if [ -n "$ip" ] && printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf '%s\n' "$ip"
    return 0
  fi
  printf '%s\n' "$PHONE_TS_FALLBACK"
}

phone_port_open() {
  host="$1"
  port="$2"
  PHONE_PORT_CMD="nc -4 -z -G 5 $host $port"
  PHONE_PORT_ERR="$(nc -4 -z -G 5 "$host" "$port" 2>&1)" && return 0
  PHONE_PORT_CMD="nc -z -G 5 $host $port"
  PHONE_PORT_ERR="$(nc -z -G 5 "$host" "$port" 2>&1)" && return 0
  return 1
}

network_adb_open() {
  phone_port_open "$1" "$PHONE_ADB_PORT"
}

tailscale_peer_ok() {
  PHONE_PORT_CMD=""
  PHONE_PORT_ERR=""
  if [ -z "$TAILSCALE_BIN" ]; then
    PHONE_PORT_CMD="tailscale CLI"
    PHONE_PORT_ERR="tailscale CLI not found on PATH or in Tailscale.app"
    return 1
  fi
  if "$TAILSCALE_BIN" status 2>/dev/null | awk -v h="$PHONE_HOST" '$2 == h { found=1 } END { exit found ? 0 : 1 }'; then
    PHONE_PORT_CMD="$TAILSCALE_BIN ping --c 1 --timeout 4s $PHONE_HOST"
    if PHONE_PORT_ERR="$("$TAILSCALE_BIN" ping --c 1 --timeout 4s "$PHONE_HOST" 2>&1)"; then
      return 0
    fi
    return 1
  fi
  PHONE_PORT_CMD="$TAILSCALE_BIN status"
  PHONE_PORT_ERR="$PHONE_HOST is not in tailscale status (wrong tailnet or phone offline)"
  return 1
}

lan_ip_from_usb() {
  serial="$(list_usb_serials | awk 'NF { print $1; exit }')"
  if [ -z "$serial" ]; then
    return 1
  fi
  adb -s "$serial" shell ip -f inet addr show wlan0 2>/dev/null \
    | awk '/inet / { split($2, a, "/"); print a[1]; exit }'
}

lan_ip_from_tailscale() {
  if [ -z "$TAILSCALE_BIN" ]; then
    return 1
  fi
  "$TAILSCALE_BIN" status 2>/dev/null | awk -v h="$PHONE_HOST" '
    $2 == h && match($0, /direct [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/direct /, "", s)
      print s
      exit
    }
  '
}

resolve_lan_ip() {
  ip="$(lan_ip_from_usb || true)"
  if [ -n "$ip" ]; then
    printf '%s\n' "$ip"
    return 0
  fi
  ip="$(lan_ip_from_tailscale || true)"
  if [ -n "$ip" ]; then
    printf '%s\n' "$ip"
    return 0
  fi
  return 1
}

print_check_error() {
  printf '%s\n' "$1" >&2
  if [ -n "$PHONE_PORT_CMD" ]; then
    printf 'Check failed: %s\n' "$PHONE_PORT_CMD" >&2
  fi
  if [ -n "$PHONE_PORT_ERR" ]; then
    printf 'Error: %s\n' "$PHONE_PORT_ERR" >&2
  fi
}

unreachable_phone_message() {
  printf '%s\n' "Can't reach the phone. Check the Mac's Tailscale is on the PERSONAL account (vishnu.rajan294@gmail.com), not Epicode's."
}

network_adb_off_message() {
  printf '%s\n' "Phone is up but network ADB is off (it probably rebooted). Plug in USB once and run npm run phone:wifi."
}

no_usb_message() {
  printf '%s\n' "Plug the phone in via USB and try again."
}

list_usb_serials() {
  adb devices -l | awk 'NR > 1 && $2 == "device" && /usb:/ { print $1 }'
}

adb_serial_state() {
  serial="$1"
  adb devices | awk -v s="$serial" 'NR > 1 && $1 == s { print $2; found=1 } END { if (!found) print "missing" }'
}

adb_connect_ok() {
  # adb connect often exits 0 even when it failed ("No route to host").
  out="$(adb connect "$1" 2>&1 || true)"
  printf '%s\n' "$out"
  case "$out" in
    *"failed to connect"*) return 1 ;;
    *"already connected to "*|*"connected to "*) return 0 ;;
    *) return 1 ;;
  esac
}

lan_ip_from_serial() {
  serial="$1"
  if [ -z "$serial" ]; then
    return 1
  fi
  adb -s "$serial" shell ip -f inet addr show wlan0 2>/dev/null \
    | awk '/inet / { split($2, a, "/"); print a[1]; exit }'
}
