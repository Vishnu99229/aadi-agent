#!/bin/sh
set -e
BUILD_ID="$1"
PR_NUMBER="$2"
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

dotenv_value() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" .env 2>/dev/null \
    | tail -n 1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?$1=//" || true
}

strip_value() {
  printf '%s' "$1" | tr -d '\r' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//;s/^"(.*)"$/\1/;s/^'"'"'(.*)'"'"'$/\1/'
}

GITHUB_TOKEN="$(strip_value "$(dotenv_value GITHUB_TOKEN)")"
BOT_TOKEN="$(strip_value "$(dotenv_value TELEGRAM_BOT_TOKEN)")"
CHAT_ID="$(strip_value "$(dotenv_value OWNER_TELEGRAM_ID)")"
OWNER="Vishnu99229"
REPO="aadi-agent"
LIVE="$ROOT"
MERGE_JSON="$ROOT/.aadi-merge.json"
PR_JSON="$ROOT/.aadi-pr.json"
ROLLBACK="$HOME/aadi-agent.rollback"
STAGING="$HOME/aadi-agent.staging"
UNPACK="$HOME/aadi-agent.unpack"
ZIP="$HOME/aadi-agent-main.zip"
HEARTBEAT="$LIVE/.aadi-heartbeat"
RESULT="$LIVE/.aadi-deploy-result.json"
BACKUP_DIR="$LIVE/backups"
EXCLUDE_FILE="$HOME/aadi-rsync-excludes"
MERGED=0
REVERT_JSON=""
MERGE_SHA=""

send_tg() {
  if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    return 0
  fi
  curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" >/dev/null || true
}

write_result() {
  status="$1"
  err="$2"
  node -e '
    const fs = require("fs");
    const out = { buildId: Number(process.argv[1]), status: process.argv[2] };
    if (process.argv[3]) out.error = process.argv[3];
    fs.writeFileSync(process.argv[4], JSON.stringify(out));
  ' "$BUILD_ID" "$status" "$err" "$RESULT" || true
}

revert_github() {
  REVERT_JSON="$(node "$ROOT/scripts/github-revert-main.cjs" "$PR_NUMBER" 2>/dev/null || true)"
  if [ -z "$REVERT_JSON" ]; then
    REVERT_JSON='{"ok":false}'
  fi
}

rollback_telegram() {
  reason="$1"
  phone_note="$2"
  printf '%s' "$REVERT_JSON" | node -e '
    const fs = require("fs");
    let parsed = {};
    try { parsed = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { parsed = {}; }
    const reason = process.argv[1];
    const phone = process.argv[2];
    const prefix = ("Deploy failed: " + reason + " " + phone).replace(/\s+/g, " ").trim();
    if (parsed.ok && parsed.message) {
      process.stdout.write(prefix + " Reverted GitHub main (" + parsed.message + ").");
      return;
    }
    const sha = typeof parsed.mergeSha === "string" && /^[0-9a-f]{7,40}$/i.test(parsed.mergeSha)
      ? parsed.mergeSha
      : "HEAD";
    process.stdout.write(
      prefix +
        " GitHub main is still broken — the revert failed. On the Mac run: git pull && git revert --no-edit " +
        sha +
        " && git push origin main",
    );
  ' "$reason" "$phone_note"
}

fail() {
  reason="$1"
  if [ "$MERGED" = 1 ] && [ "$SKIP_GITHUB_REVERT" != "1" ]; then
    revert_github
    write_result failed "$reason"
    send_tg "$(rollback_telegram "$reason" "Phone was not switched.")"
    exit 1
  fi
  write_result failed "$reason"
  send_tg "Deploy failed: $reason"
  exit 1
}

rollback_and_exit() {
  reason="$1"
  echo "Rolling back: $reason" >&2
  if [ "$SKIP_GITHUB_REVERT" != "1" ]; then
    revert_github
  else
    REVERT_JSON='{"ok":true,"message":"main already reverted"}'
  fi
  if [ -d "$ROLLBACK" ]; then
    rsync -a --delete --exclude-from="$EXCLUDE_FILE" "$ROLLBACK/" "$LIVE/" || true
    (cd "$LIVE" && node scripts/ensure-allow-scripts.cjs && npm install --no-audit --no-fund) || true
  fi
  rm -f "$HEARTBEAT"
  pkill -f "[t]sx src/index.ts" || true
  waited=0
  while [ "$waited" -lt 180 ]; do
    if [ -f "$HEARTBEAT" ]; then
      write_result rolled_back "$reason"
      send_tg "$(rollback_telegram "$reason" "Rolled back the phone to the previous version.")"
      exit 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  write_result rolled_back "$reason"
  send_tg "$(rollback_telegram "$reason" "Phone rollback ran but restart did not become healthy.")"
  exit 1
}

if [ -z "$BUILD_ID" ] || [ -z "$PR_NUMBER" ]; then
  echo "Usage: phone-self-deploy.sh <buildId> <prNumber>" >&2
  exit 1
fi
if [ -z "$GITHUB_TOKEN" ]; then
  fail "GITHUB_TOKEN is missing."
fi
SKIP_GITHUB_REVERT=0
if [ "$PR_NUMBER" = "0" ]; then
  SKIP_GITHUB_REVERT=1
fi

cat > "$EXCLUDE_FILE" <<'EOF'
.env
.env.bak
.env.phone
google-token.json
google-token-work.json
google-credentials.json
*.db
backups
node_modules
dist
.git
VERSION
.aadi-heartbeat
.aadi-deploy-result.json
.aadi-merge.json
.aadi-pr.json
test-fixtures
whatsapp*
*session*
.wwebjs*
.baileys*
EOF

if [ "$PR_NUMBER" != "0" ]; then
  MERGE_CODE="$(curl -sS -o "$MERGE_JSON" -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/merge" \
    -d '{"merge_method":"squash"}')"
  if [ "$MERGE_CODE" != "200" ]; then
    PR_CODE="$(curl -sS -o "$PR_JSON" -w "%{http_code}" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}")"
    merged="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.merged===true?"yes":"no")}catch{process.stdout.write("no")}' "$PR_JSON")"
    if [ "$merged" != "yes" ]; then
      fail "Could not squash-merge PR #${PR_NUMBER}."
    fi
  fi
  MERGED=1
  MERGE_SHA="$(node -e '
    const fs = require("fs");
    function sha(p) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (typeof j.sha === "string" && j.sha) return j.sha;
        if (typeof j.merge_commit_sha === "string" && j.merge_commit_sha) return j.merge_commit_sha;
      } catch {}
      return "";
    }
    process.stdout.write(sha(process.argv[1]) || sha(process.argv[2]));
  ' "$MERGE_JSON" "$PR_JSON")"
  rm -f "$MERGE_JSON" "$PR_JSON"
fi

mkdir -p "$BACKUP_DIR"
stamp="$(TZ=Asia/Kolkata date +%Y%m%d-%H%M%S)"
if ! node scripts/sqlite-backup.cjs "$BACKUP_DIR/aadi-pre-build-$stamp.db"; then
  fail "Could not back up aadi.db."
fi

rm -rf "$ROLLBACK"
mkdir -p "$ROLLBACK"
rsync -a --exclude-from="$EXCLUDE_FILE" "$LIVE/" "$ROLLBACK/"

rm -f "$ZIP"
if ! curl -sS -L -o "$ZIP" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${OWNER}/${REPO}/zipball/main"; then
  fail "Could not download main."
fi

rm -rf "$UNPACK" "$STAGING"
mkdir -p "$UNPACK" "$STAGING"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP" -d "$UNPACK"
else
  python3 -c "import zipfile; zipfile.ZipFile('$ZIP').extractall('$UNPACK')"
fi
INNER="$(find "$UNPACK" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$INNER" ]; then
  fail "The main archive was empty."
fi
INNER_SHA="$(basename "$INNER" | awk -F- '{print $NF}')"
COMMIT="${INNER_SHA:-$MERGE_SHA}"
rsync -a "$INNER/" "$STAGING/"
rm -rf "$UNPACK" "$ZIP"

rsync -a --delete --exclude-from="$EXCLUDE_FILE" "$STAGING/" "$LIVE/"
rm -rf "$STAGING"

cd "$LIVE"
node scripts/ensure-allow-scripts.cjs
if ! npm install --no-audit --no-fund; then
  rollback_and_exit "npm install failed."
fi

sh scripts/write-version.sh "$LIVE" "$COMMIT" || true

rm -f "$HEARTBEAT"
pkill -f "[t]sx src/index.ts" || true

waited=0
while [ "$waited" -lt 180 ]; do
  if [ -f "$HEARTBEAT" ]; then
    write_result deployed
    exit 0
  fi
  sleep 3
  waited=$((waited + 3))
done

rollback_and_exit "Aadi did not become healthy in time."
