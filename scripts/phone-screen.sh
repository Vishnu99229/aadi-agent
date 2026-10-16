#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=phone-adb-lib.sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-adb-lib.sh"

DRY_RUN=0
SCRCPY_EXTRA=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  elif [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
    echo "Usage: phone-screen.sh [--dry-run] [scrcpy args...]"
    echo "Mirror the Aadi phone over Tailscale. Extra args are passed to scrcpy."
    exit 0
  else
    SCRCPY_EXTRA+=("$arg")
  fi
done

BITRATE="${SCRCPY_BITRATE:-2M}"
MAX_SIZE="${SCRCPY_MAX_SIZE:-1024}"
IP="$(resolve_phone_ip)"
LAN_IP="$(resolve_lan_ip || true)"
PATH_LABEL="Tailscale"
TARGET="${IP}:${PHONE_ADB_PORT}"

# --tcpip=<ip>:5555 is a scrcpy selector: connect to a device already
# listening on TCP/IP, even if a USB device is also attached.
# --force-adb-forward avoids adb reverse, which can hang on wireless ADB.
# Docs: https://github.com/Genymobile/scrcpy/blob/master/doc/connection.md
scrcpy_cmd() {
  extra=""
  if [ ${#SCRCPY_EXTRA[@]} -gt 0 ]; then
    extra=" ${SCRCPY_EXTRA[*]}"
  fi
  printf '%s\n' "scrcpy --tcpip=${TARGET} --force-adb-forward --no-audio --video-bit-rate=${BITRATE} --max-size=${MAX_SIZE}${extra}"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "$*"
    return 0
  fi
  "$@"
}

pick_adb_target() {
  if network_adb_open "$IP"; then
    PATH_LABEL="Tailscale"
    TARGET="${IP}:${PHONE_ADB_PORT}"
    return 0
  fi
  ts_err="$PHONE_PORT_ERR"
  ts_cmd="$PHONE_PORT_CMD"
  if [ -n "${LAN_IP:-}" ] && [ "$LAN_IP" != "$IP" ] && network_adb_open "$LAN_IP"; then
    PATH_LABEL="LAN"
    TARGET="${LAN_IP}:${PHONE_ADB_PORT}"
    echo "Using LAN ${TARGET} (Tailscale ${IP}:${PHONE_ADB_PORT} did not accept ADB)."
    return 0
  fi
  PHONE_PORT_CMD="$ts_cmd"
  PHONE_PORT_ERR="$ts_err"
  if [ -n "${LAN_IP:-}" ] && [ "$LAN_IP" != "$IP" ]; then
    PHONE_PORT_ERR="${ts_err}; LAN ${LAN_IP}:${PHONE_ADB_PORT} also closed"
  fi
  return 1
}

if [ "$DRY_RUN" -eq 0 ]; then
  if ! pick_adb_target; then
    adb_cmd="$PHONE_PORT_CMD"
    adb_err="$PHONE_PORT_ERR"
    if ! tailscale_peer_ok; then
      print_check_error "$(unreachable_phone_message)"
      exit 1
    fi
    PHONE_PORT_CMD="$adb_cmd"
    PHONE_PORT_ERR="$adb_err"
    print_check_error "$(network_adb_off_message)"
    exit 1
  fi
fi

STATE="$(adb_serial_state "$TARGET")"
if [ "$STATE" = "offline" ]; then
  run adb disconnect "$TARGET"
  STATE="missing"
fi
if [ "$STATE" != "device" ]; then
  run adb connect "$TARGET"
fi

echo "Tip: right-click in the window to wake the screen."
if [ "$PATH_LABEL" = "LAN" ]; then
  echo "Mirroring via LAN ${TARGET}."
else
  echo "Mirroring via Tailscale ${TARGET}."
fi
if [ "$DRY_RUN" -eq 1 ]; then
  scrcpy_cmd
  exit 0
fi

if [ ${#SCRCPY_EXTRA[@]} -gt 0 ]; then
  scrcpy --tcpip="$TARGET" --force-adb-forward --no-audio --video-bit-rate="$BITRATE" --max-size="$MAX_SIZE" "${SCRCPY_EXTRA[@]}"
else
  scrcpy --tcpip="$TARGET" --force-adb-forward --no-audio --video-bit-rate="$BITRATE" --max-size="$MAX_SIZE"
fi
