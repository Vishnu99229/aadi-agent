# Shared phone SSH target. Sourced by deploy.sh, phone-pause.sh, and phone-resume.sh.
# Tailscale MagicDNS (i2301 → 100.79.235.3). Override for a one-off LAN deploy:
#   PHONE_HOST=192.168.1.7 npm run deploy
PHONE_HOST="${PHONE_HOST:-i2301}"
PHONE_USER="u0_a289"
PHONE_PORT="8022"
PHONE="${PHONE_USER}@${PHONE_HOST}"
