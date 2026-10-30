#!/bin/sh
set -e
DEST="${1:?write-version.sh: dest dir required}"
RAW="${2:-}"

raw="$(printf '%s' "$RAW" | tr 'A-F' 'a-f' | tr -d '\r\n')"
case "$raw" in
  *[!0-9a-f]*)
    raw="$(printf '%s' "$raw" | awk -F- '{print $NF}')"
    ;;
esac
short="$(printf '%s' "$raw" | cut -c1-7)"
case "$short" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) short="unknown" ;;
esac

TIME="$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST')"
printf 'hash=%s\ndeployed=%s\n' "$short" "$TIME" > "$DEST/VERSION"
