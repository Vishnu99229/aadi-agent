#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=phone-adb-lib.sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-adb-lib.sh"

DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  elif [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
    echo "Usage: phone-wifi-adb.sh [--dry-run]"
    echo "Plug in USB once, then run this to enable network ADB over Tailscale."
    exit 0
  else
    echo "Unknown argument: $arg" >&2
    exit 1
  fi
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "$*"
    return 0
  fi
  "$@"
}

IP="$(resolve_phone_ip)"
TARGET="${IP}:${PHONE_ADB_PORT}"
LAN_IP="$(resolve_lan_ip || true)"

if [ "$DRY_RUN" -eq 1 ]; then
  SERIAL="$(list_usb_serials | awk 'NR==1 { print $1 }' || true)"
  if [ -n "${SERIAL:-}" ]; then
    run adb -s "$SERIAL" tcpip "$PHONE_ADB_PORT"
  else
    echo "adb -s <usb-serial> tcpip $PHONE_ADB_PORT"
  fi
  run adb connect "$TARGET"
  if [ -n "${LAN_IP:-}" ] && [ "$LAN_IP" != "$IP" ]; then
    echo "adb connect ${LAN_IP}:${PHONE_ADB_PORT}"
  fi
  echo "Network ADB is on. You can unplug the cable now. Run npm run phone:screen to mirror."
  exit 0
fi

USB_LIST="$(list_usb_serials)"
COUNT="$(printf '%s\n' "$USB_LIST" | awk 'NF { c++ } END { print c+0 }')"

if [ "$COUNT" -eq 0 ]; then
  PHONE_PORT_CMD="adb devices -l (usb:)"
  PHONE_PORT_ERR="no USB device in state device"
  print_check_error "$(no_usb_message)"
  exit 1
fi

if [ "$COUNT" -gt 1 ]; then
  echo "More than one USB device is attached:" >&2
  printf '%s\n' "$USB_LIST" | awk 'NF { print "  " $0 }' >&2
  echo "Unplug the extras and try again." >&2
  echo "Check failed: adb devices -l (usb:)" >&2
  exit 1
fi

SERIAL="$(printf '%s\n' "$USB_LIST" | awk 'NF { print $1; exit }')"
if [ -z "${LAN_IP:-}" ]; then
  LAN_IP="$(adb -s "$SERIAL" shell ip -f inet addr show wlan0 2>/dev/null \
    | awk '/inet / { split($2, a, "/"); print a[1]; exit }' || true)"
fi

run adb -s "$SERIAL" tcpip "$PHONE_ADB_PORT"

opened_ip=""
waited=0
while [ "$waited" -lt 15 ]; do
  if network_adb_open "$IP"; then
    opened_ip="$IP"
    break
  fi
  if [ -n "${LAN_IP:-}" ] && [ "$LAN_IP" != "$IP" ] && network_adb_open "$LAN_IP"; then
    opened_ip="$LAN_IP"
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if [ -z "$opened_ip" ]; then
  PHONE_PORT_CMD="nc -4 -z -G 5 $IP $PHONE_ADB_PORT"
  PHONE_PORT_ERR="port $PHONE_ADB_PORT did not open on $IP within 15s"
  if [ -n "${LAN_IP:-}" ]; then
    PHONE_PORT_ERR="${PHONE_PORT_ERR}; also tried ${LAN_IP}:${PHONE_ADB_PORT}"
  fi
  print_check_error "USB tcpip ran, but network ADB is not reachable yet. Try npm run phone:wifi again."
  exit 1
fi

TARGET="${opened_ip}:${PHONE_ADB_PORT}"
run adb connect "$TARGET"
if [ "$opened_ip" = "$IP" ]; then
  echo "Network ADB is on via Tailscale ${TARGET}. You can unplug the cable now. Run npm run phone:screen to mirror."
else
  echo "Network ADB is on via LAN ${TARGET} (Tailscale ${IP}:${PHONE_ADB_PORT} did not open). You can unplug the cable now. Run npm run phone:screen to mirror."
fi
