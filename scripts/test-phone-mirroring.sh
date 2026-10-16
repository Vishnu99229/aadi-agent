#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WIFI="$ROOT/scripts/phone-wifi-adb.sh"
SCREEN="$ROOT/scripts/phone-screen.sh"
STUB="$(mktemp -d "${TMPDIR:-/tmp}/aadi-mirror-XXXXXX")"
trap 'rm -rf "$STUB"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  haystack="$1"
  needle="$2"
  case "$haystack" in
    *"$needle"*) ;;
    *) fail "expected to find: $needle"$'\n'"got:"$'\n'"$haystack" ;;
  esac
}

write_exec() {
  path="$1"
  cat > "$path"
  chmod +x "$path"
}

write_exec "$STUB/tailscale" <<'EOF'
#!/bin/sh
if [ "$1" = "ip" ] && [ "$2" = "-4" ]; then
  echo "100.79.235.3"
  exit 0
fi
exit 0
EOF

write_exec "$STUB/scrcpy" <<'EOF'
#!/bin/sh
printf 'scrcpy-stub'
for a in "$@"; do printf ' %s' "$a"; done
printf '\n'
EOF

write_exec "$STUB/nc" <<'EOF'
#!/bin/sh
port=""
i=1
while [ "$i" -le $# ]; do
  eval "arg=\${$i}"
  port="$arg"
  i=$((i + 1))
done
case ",${PHONE_STUB_OPEN_PORTS:-}," in
  *",$port,"*) exit 0 ;;
  *) exit 1 ;;
esac
EOF

write_exec "$STUB/adb" <<'EOF'
#!/bin/sh
usb="${PHONE_STUB_USB:-none}"
net="${PHONE_STUB_NET:-missing}"
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  if [ "$usb" = "one" ]; then
    echo "USBSERIAL1        device usb:1 product:I2301T model:I2301 device:I2301"
  elif [ "$usb" = "two" ]; then
    echo "USBSERIAL1        device usb:1 product:P1"
    echo "USBSERIAL2        device usb:2 product:P2"
  fi
  if [ "$net" = "device" ]; then
    echo "100.79.235.3:5555 device product:I2301T"
  elif [ "$net" = "offline" ]; then
    echo "100.79.235.3:5555 offline"
  fi
  exit 0
fi
echo "adb-stub $*" >&2
exit 0
EOF

export PATH="$STUB:$PATH"

set +e
out="$(PHONE_STUB_OPEN_PORTS="" "$SCREEN" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "unreachable should exit 1"
assert_contains "$out" "Can't reach the phone. Check the Mac's Tailscale is on the PERSONAL account (vishnu.rajan294@gmail.com), not Epicode's."

set +e
out="$(PHONE_STUB_OPEN_PORTS="8022" "$SCREEN" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "closed 5555 should exit 1"
assert_contains "$out" "Phone is up but network ADB is off (it probably rebooted). Plug in USB once and run npm run phone:wifi."

set +e
out="$(PHONE_STUB_OPEN_PORTS="8022" PHONE_STUB_USB="none" "$WIFI" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "no USB should exit 1"
assert_contains "$out" "Plug the phone in via USB and try again."

echo "Phone mirroring mock checks passed."
