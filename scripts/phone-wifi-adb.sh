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
WAIT_SECS="${PHONE_WIFI_WAIT_SECS:-30}"

if [ "$DRY_RUN" -eq 1 ]; then
  SERIAL="$(list_usb_serials | awk 'NR==1 { print $1 }' || true)"
  if [ -n "${SERIAL:-}" ]; then
    run adb -s "$SERIAL" tcpip "$PHONE_ADB_PORT"
    echo "adb -s $SERIAL shell ip -f inet addr show wlan0"
  else
    echo "adb -s <usb-serial> tcpip $PHONE_ADB_PORT"
    echo "adb -s <usb-serial> shell ip -f inet addr show wlan0"
  fi
  run adb connect "$TARGET"
  echo "Would wait up to ${WAIT_SECS}s for ${TARGET}, then retry adb connect (LAN IP from adb wlan0)."
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
LAN_IP="$(lan_ip_from_serial "$SERIAL" || true)"

run adb -s "$SERIAL" tcpip "$PHONE_ADB_PORT"

fail_ts=""
fail_lan=""
connected_ip=""
waited=0

try_adb_connect() {
  host="$1"
  label="$2"
  addr="${host}:${PHONE_ADB_PORT}"
  if ! network_adb_open "$host"; then
    msg="port ${PHONE_ADB_PORT} not open (${PHONE_PORT_ERR:-no route / connection refused})"
    if [ "$label" = "ts" ]; then
      fail_ts="$msg"
    else
      fail_lan="$msg"
    fi
    return 1
  fi
  connect_out="$(adb_connect_ok "$addr")" || true
  printf '%s\n' "$connect_out"
  case "$connect_out" in
    *"failed to connect"*)
      msg="$connect_out"
      ;;
    *"already connected to "*|*"connected to "*)
      connected_ip="$host"
      return 0
      ;;
    *)
      msg="${connect_out:-adb connect produced no output}"
      ;;
  esac
  if [ "$label" = "ts" ]; then
    fail_ts="$msg"
  else
    fail_lan="$msg"
  fi
  return 1
}

while [ "$waited" -lt "$WAIT_SECS" ]; do
  if try_adb_connect "$IP" "ts"; then
    break
  fi
  if [ -n "${LAN_IP:-}" ] && [ "$LAN_IP" != "$IP" ]; then
    if try_adb_connect "$LAN_IP" "lan"; then
      break
    fi
  fi
  sleep 1
  waited=$((waited + 1))
done

if [ -z "$connected_ip" ]; then
  echo "Could not enable network ADB." >&2
  echo "Tailscale ${IP}:${PHONE_ADB_PORT}: ${fail_ts:-did not connect}" >&2
  if [ -n "${LAN_IP:-}" ]; then
    echo "LAN ${LAN_IP}:${PHONE_ADB_PORT}: ${fail_lan:-did not connect}" >&2
  else
    echo "LAN: could not read wlan0 address from adb" >&2
  fi
  echo "Check failed: adb connect ${IP}:${PHONE_ADB_PORT}" >&2
  exit 1
fi

TARGET="${connected_ip}:${PHONE_ADB_PORT}"
if [ "$connected_ip" = "$IP" ]; then
  echo "Network ADB is on via Tailscale ${TARGET}. You can unplug the cable now. Run npm run phone:screen to mirror."
else
  echo "Network ADB is on via LAN ${TARGET} (Tailscale ${IP}:${PHONE_ADB_PORT} did not connect). You can unplug the cable now. Run npm run phone:screen to mirror."
fi
