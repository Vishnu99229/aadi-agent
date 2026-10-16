# Shared helpers for Mac-side wireless ADB / scrcpy scripts.
# shellcheck source=phone-host.sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-host.sh"

PHONE_ADB_PORT="5555"
PHONE_TS_FALLBACK="100.79.235.3"

resolve_phone_ip() {
  ip=""
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(tailscale ip -4 "$PHONE_HOST" 2>/dev/null | awk 'NR==1 { print $1 }')"
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
  nc -z -G 2 "$host" "$port" >/dev/null 2>&1
}

phone_reachable() {
  phone_port_open "$1" "$PHONE_PORT"
}

network_adb_open() {
  phone_port_open "$1" "$PHONE_ADB_PORT"
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
