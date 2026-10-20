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

assert_not_contains() {
  haystack="$1"
  needle="$2"
  case "$haystack" in
    *"$needle"*) fail "did not expect: $needle"$'\n'"got:"$'\n'"$haystack" ;;
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
if [ "$1" = "status" ]; then
  if [ "${PHONE_STUB_TS:-up}" = "down" ]; then
    echo "100.64.36.99  admins-macbook-pro  other-account@  macOS"
    exit 0
  fi
  echo "100.64.36.99  admins-macbook-pro  vishnu.rajan294@  macOS"
  echo "100.79.235.3  i2301               vishnu.rajan294@  android  active; direct 192.168.1.7:56245"
  exit 0
fi
if [ "$1" = "ping" ]; then
  if [ "${PHONE_STUB_TS:-up}" = "down" ]; then
    echo "no matching peer" >&2
    exit 1
  fi
  echo "pong from i2301 (100.79.235.3) via 192.168.1.7:56245 in 20ms"
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
  *",$port,"*) echo "Connection to host port $port succeeded!" >&2; exit 0 ;;
  *) echo "Connection refused" >&2; exit 1 ;;
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
if [ "$1" = "-s" ] && [ "$3" = "shell" ]; then
  echo "    inet 192.168.1.42/24 brd 192.168.1.255 scope global dynamic wlan0"
  exit 0
fi
if [ "$1" = "connect" ]; then
  if [ "${PHONE_STUB_CONNECT:-ok}" = "fail" ]; then
    echo "failed to connect to $2: No route to host"
    exit 0
  fi
  echo "connected to $2"
  exit 0
fi
if [ "$1" = "disconnect" ]; then
  echo "adb-stub $*"
  exit 0
fi
echo "adb-stub $*" >&2
exit 0
EOF

export PATH="$STUB:$PATH"

set +e
out="$(PHONE_STUB_TS=down PHONE_STUB_OPEN_PORTS="" "$SCREEN" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "unreachable should exit 1"
assert_contains "$out" "Can't reach the phone. Check the Mac's Tailscale is on the PERSONAL account (vishnu.rajan294@gmail.com), not Epicode's."
assert_contains "$out" "Check failed:"
assert_contains "$out" "i2301 is not in tailscale status"

set +e
out="$(PHONE_STUB_TS=up PHONE_STUB_OPEN_PORTS="" "$SCREEN" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "closed 5555 should exit 1"
assert_contains "$out" "Phone is up but network ADB is off (it probably rebooted). Plug in USB once and run npm run phone:wifi."
assert_contains "$out" "Check failed:"
assert_contains "$out" "Error: Connection refused"
assert_not_contains "$out" "Can't reach the phone"

set +e
out="$(PHONE_STUB_TS=up PHONE_STUB_OPEN_PORTS="" PHONE_STUB_USB="none" "$WIFI" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "no USB should exit 1"
assert_contains "$out" "Plug the phone in via USB and try again."
assert_contains "$out" "Check failed: adb devices -l (usb:)"

set +e
out="$(PHONE_STUB_TS=up PHONE_STUB_OPEN_PORTS="5555" PHONE_STUB_USB="one" PHONE_STUB_CONNECT="fail" PHONE_WIFI_WAIT_SECS=1 "$WIFI" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "failed adb connect should exit 1"$'\n'"$out"
assert_contains "$out" "Could not enable network ADB."
assert_contains "$out" "Tailscale 100.79.235.3:5555"
assert_contains "$out" "LAN 192.168.1.42:5555"
assert_contains "$out" "No route to host"
assert_not_contains "$out" "Network ADB is on"

set +e
out="$(PHONE_STUB_TS=up PHONE_STUB_OPEN_PORTS="5555" PHONE_STUB_USB="one" PHONE_STUB_CONNECT="ok" PHONE_WIFI_WAIT_SECS=1 "$WIFI" 2>&1)"
status=$?
set -e
[ "$status" -eq 0 ] || fail "successful adb connect should exit 0"$'\n'"$out"
assert_contains "$out" "Network ADB is on via Tailscale 100.79.235.3:5555"
assert_not_contains "$out" "192.168.1.7"

# Port 8022 (sshd) closed must not look like the wrong Tailscale account when
# the peer is up and ADB 5555 is open.
set +e
out="$(PHONE_STUB_TS=up PHONE_STUB_OPEN_PORTS="5555" PHONE_STUB_NET="device" "$SCREEN" 2>&1)"
status=$?
set -e
[ "$status" -eq 0 ] || fail "open 5555 should not require port 8022"$'\n'"$out"
assert_contains "$out" "scrcpy-stub --tcpip=100.79.235.3:5555"
assert_contains "$out" "--force-adb-forward"
assert_not_contains "$out" "Can't reach the phone"

echo "Phone mirroring mock checks passed."
