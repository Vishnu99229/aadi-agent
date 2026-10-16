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

if [ "$DRY_RUN" -eq 1 ]; then
  SERIAL="$(list_usb_serials | awk 'NR==1 { print $1 }' || true)"
  if [ -n "${SERIAL:-}" ]; then
    run adb -s "$SERIAL" tcpip "$PHONE_ADB_PORT"
  else
    echo "adb -s <usb-serial> tcpip $PHONE_ADB_PORT"
  fi
  run adb connect "$TARGET"
  echo "Network ADB is on. You can unplug the cable now. Run npm run phone:screen to mirror."
  exit 0
fi

if ! phone_reachable "$IP"; then
  unreachable_phone_message >&2
  exit 1
fi

USB_LIST="$(list_usb_serials)"
COUNT="$(printf '%s\n' "$USB_LIST" | awk 'NF { c++ } END { print c+0 }')"

if [ "$COUNT" -eq 0 ]; then
  no_usb_message >&2
  exit 1
fi

if [ "$COUNT" -gt 1 ]; then
  echo "More than one USB device is attached:" >&2
  printf '%s\n' "$USB_LIST" | awk 'NF { print "  " $0 }' >&2
  echo "Unplug the extras and try again." >&2
  exit 1
fi

SERIAL="$(printf '%s\n' "$USB_LIST" | awk 'NF { print $1; exit }')"
run adb -s "$SERIAL" tcpip "$PHONE_ADB_PORT"

opened=0
waited=0
while [ "$waited" -lt 15 ]; do
  if network_adb_open "$IP"; then
    opened=1
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if [ "$opened" -ne 1 ]; then
  echo "Port $PHONE_ADB_PORT on $IP did not open in time." >&2
  echo "USB tcpip ran, but Tailscale ADB is not reachable yet. Try npm run phone:wifi again." >&2
  exit 1
fi

run adb connect "$TARGET"
echo "Network ADB is on. You can unplug the cable now. Run npm run phone:screen to mirror."
