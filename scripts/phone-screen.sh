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
TARGET="${IP}:${PHONE_ADB_PORT}"

# --tcpip=<ip>:5555 is a scrcpy selector: connect to a device already
# listening on TCP/IP, even if a USB device is also attached.
# Docs: https://github.com/Genymobile/scrcpy/blob/master/doc/connection.md
scrcpy_cmd() {
  if [ ${#SCRCPY_EXTRA[@]} -gt 0 ]; then
    printf '%s\n' "scrcpy --tcpip=${TARGET} --no-audio --video-bit-rate=${BITRATE} --max-size=${MAX_SIZE} ${SCRCPY_EXTRA[*]}"
  else
    printf '%s\n' "scrcpy --tcpip=${TARGET} --no-audio --video-bit-rate=${BITRATE} --max-size=${MAX_SIZE}"
  fi
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "$*"
    return 0
  fi
  "$@"
}

if [ "$DRY_RUN" -eq 0 ]; then
  if ! phone_reachable "$IP"; then
    unreachable_phone_message >&2
    exit 1
  fi
  if ! network_adb_open "$IP"; then
    network_adb_off_message >&2
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
if [ "$DRY_RUN" -eq 1 ]; then
  scrcpy_cmd
  exit 0
fi

if [ ${#SCRCPY_EXTRA[@]} -gt 0 ]; then
  scrcpy --tcpip="$TARGET" --no-audio --video-bit-rate="$BITRATE" --max-size="$MAX_SIZE" "${SCRCPY_EXTRA[@]}"
else
  scrcpy --tcpip="$TARGET" --no-audio --video-bit-rate="$BITRATE" --max-size="$MAX_SIZE"
fi
