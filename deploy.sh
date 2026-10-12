#!/bin/sh
set -e
PHONE="u0_a289@192.168.1.7"
rsync -av --exclude node_modules --exclude dist --exclude '*.db' --exclude google-token.json --exclude .git -e "ssh -p 8022" ./ "$PHONE:~/aadi-agent/"
ssh -p 8022 "$PHONE" 'cd ~/aadi-agent && npm install --no-audit --no-fund && pkill -f "[t]sx src/index.ts" || true'
echo "Deployed. Aadi restarts on the phone in about 5 seconds."
