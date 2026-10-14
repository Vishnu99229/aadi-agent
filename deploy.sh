#!/bin/sh
set -e
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/scripts/phone-host.sh"

if [ ! -f .env ]; then
  echo "Refusing to deploy: local .env is missing. Nothing was copied."
  exit 1
fi

# Read a single KEY=value line from .env, ignoring comments/blank lines.
# Prints the raw value (possibly empty) and returns 0 if the key exists.
dotenv_value() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" .env 2>/dev/null \
    | tail -n 1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?$1=//" || true
}

missing=""
check_required() {
  value="$(dotenv_value "$1" | tr -d '\r' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//;s/^"(.*)"$/\1/;s/^'"'"'(.*)'"'"'$/\1/')"
  if [ -z "$value" ]; then
    missing="${missing} $1"
  fi
}

check_required TELEGRAM_BOT_TOKEN
check_required OWNER_TELEGRAM_ID
check_required ANTHROPIC_API_KEY

# Voice notes are enabled only when explicitly opted in via
# VOICE_NOTES_ENABLED=true in the local .env; then SARVAM_API_KEY is required.
voice_flag="$(dotenv_value VOICE_NOTES_ENABLED | tr -d '\r[:space:]' | tr '[:upper:]' '[:lower:]')"
if [ "$voice_flag" = "true" ] || [ "$voice_flag" = "1" ] || [ "$voice_flag" = "yes" ]; then
  check_required SARVAM_API_KEY
fi

if [ -n "$missing" ]; then
  echo "Refusing to deploy: these keys are missing or empty in local .env:${missing}. Nothing was copied."
  exit 1
fi

rsync -av --exclude node_modules --exclude dist --exclude '*.db' --exclude google-token.json --exclude google-token-work.json --exclude .git --exclude test-fixtures --exclude .env.bak --exclude .env.phone -e "ssh -p $PHONE_PORT" ./ "$PHONE:~/aadi-agent/"
ssh -p "$PHONE_PORT" "$PHONE" 'cd ~/aadi-agent && npm install --no-audit --no-fund && pkill -f "[t]sx src/index.ts" || true'
echo "Deployed. Aadi restarts on the phone in about 5 seconds."
