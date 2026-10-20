#!/bin/sh
set -e
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/phone-host.sh"

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/phone-boot.sh"
REMOTE_REL=".termux/boot/start-aadi.sh"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC"
  exit 1
fi

ssh -p "$PHONE_PORT" "$PHONE" 'mkdir -p ~/.termux/boot'

CURRENT="$(mktemp)"
trap 'rm -f "$CURRENT"' EXIT
if scp -q -P "$PHONE_PORT" "$PHONE:$REMOTE_REL" "$CURRENT" 2>/dev/null; then
  echo "Diff (phone ~/.termux/boot/start-aadi.sh vs repo scripts/phone-boot.sh):"
  if diff -u "$CURRENT" "$SRC"; then
    echo "(no differences)"
  fi
else
  echo "No existing ~/.termux/boot/start-aadi.sh on the phone."
  echo "Diff (empty vs repo scripts/phone-boot.sh):"
  diff -u /dev/null "$SRC" || true
fi

stamp="$(TZ=Asia/Kolkata date +%Y%m%d-%H%M%S)"
ssh -p "$PHONE_PORT" "$PHONE" "stamp='$stamp'; if [ -f ~/.termux/boot/start-aadi.sh ]; then cp -a ~/.termux/boot/start-aadi.sh ~/.termux/boot/start-aadi.sh.bak.\$stamp; echo Backed up to ~/.termux/boot/start-aadi.sh.bak.\$stamp; fi"
scp -q -P "$PHONE_PORT" "$SRC" "$PHONE:$REMOTE_REL"
ssh -p "$PHONE_PORT" "$PHONE" 'chmod +x ~/.termux/boot/start-aadi.sh'
echo "Installed scripts/phone-boot.sh -> ~/.termux/boot/start-aadi.sh"
