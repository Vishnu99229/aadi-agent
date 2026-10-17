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

ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
BACKUP_DIR="$ROOT/backups"
mkdir -p "$BACKUP_DIR"

snapshot_phone_db() {
  stamp="$(TZ=Asia/Kolkata date +%Y%m%d-%H%M%S)"
  dest="$BACKUP_DIR/aadi-$stamp.db"
  echo "Snapshotting phone aadi.db to backups/aadi-$stamp.db"
  ssh -p "$PHONE_PORT" "$PHONE" "mkdir -p ~/aadi-agent/scripts"
  scp -q -P "$PHONE_PORT" "$ROOT/scripts/sqlite-backup.cjs" "$PHONE:~/aadi-agent/scripts/sqlite-backup.cjs"
  if ssh -p "$PHONE_PORT" "$PHONE" 'cd ~/aadi-agent && node scripts/sqlite-backup.cjs "$HOME/aadi-agent/.aadi-deploy-backup.db"'; then
    scp -q -P "$PHONE_PORT" "$PHONE:~/aadi-agent/.aadi-deploy-backup.db" "$dest"
    ssh -p "$PHONE_PORT" "$PHONE" 'rm -f "$HOME/aadi-agent/.aadi-deploy-backup.db"'
    echo "Saved $dest"
  else
    ssh -p "$PHONE_PORT" "$PHONE" 'rm -f "$HOME/aadi-agent/.aadi-deploy-backup.db"' || true
    echo "Warning: could not snapshot phone aadi.db. Continuing deploy."
    return 0
  fi
  keep=10
  n=0
  for f in $(ls -t "$BACKUP_DIR"/aadi-*.db 2>/dev/null); do
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then
      rm -f "$f"
    fi
  done
}

cd "$ROOT"
if ! git fetch origin; then
  echo "Could not git fetch origin. Nothing was copied."
  exit 1
fi
behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
if [ "$behind" -gt 0 ]; then
  echo "Mac is behind origin/main — run git pull first"
  exit 1
fi

snapshot_phone_db

rsync -av --exclude node_modules --exclude dist --exclude '*.db' --exclude backups --exclude 'google-token*.json' --exclude .git --exclude test-fixtures --exclude .env.bak --exclude .env.phone --exclude .aadi-heartbeat --exclude .aadi-deploy-result.json -e "ssh -p $PHONE_PORT" ./ "$PHONE:~/aadi-agent/"
ssh -p "$PHONE_PORT" "$PHONE" 'cd ~/aadi-agent && npm install --no-audit --no-fund && pkill -f "[t]sx src/index.ts" || true'
echo "Deployed. Aadi restarts on the phone in about 5 seconds."
