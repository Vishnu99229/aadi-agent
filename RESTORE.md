# Restore Aadi's database

The live database is `~/aadi-agent/aadi.db` on the phone. Deploy never overwrites it. Two kinds of backup exist.

## Mac snapshots (unencrypted)

Each `npm run deploy` copies the phone database to `backups/aadi-YYYYMMDD-HHMMSS.db` on the Mac (Asia/Kolkata timestamp). Latest 10 are kept. These files are already SQLite — do not decrypt them.

## Telegram backups (encrypted)

Sunday 21:00 and `/backup` send `aadi-YYYYMMDD-HHMM.db.enc`. Decrypt with the same `BACKUP_PASSWORD` stored in `.env` (and in your password manager):

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
  -in aadi-YYYYMMDD-HHMM.db.enc -out aadi.db \
  -pass env:BACKUP_PASSWORD
```

Check it:

```sh
sqlite3 aadi.db "PRAGMA integrity_check; SELECT id, name FROM accounts;"
```

## Put the file back on the phone

Only one copy of Aadi may run at a time.

1. From the Mac repo: `npm run phone:pause`
2. Copy the restored `aadi.db` into place (this replaces the live database):

```sh
. scripts/phone-host.sh
scp -P "$PHONE_PORT" aadi.db "$PHONE:~/aadi-agent/aadi.db"
```

3. `npm run phone:resume`
4. Confirm Aadi is up, then in Telegram send `/accounts`.

## Wireless screen mirroring

From the Mac, Tailscale on the personal account (`vishnu.rajan294@gmail.com`):

```sh
npm run phone:wifi     # USB cable once — turns on network ADB
npm run phone:screen   # unplug; mirrors over Tailscale
```

After a reboot, network ADB is off: plug in USB and run `phone:wifi` again. If the phone is unreachable, the Mac is probably on Epicode's tailnet — switch Tailscale to personal.

## Phone boot script

`scripts/phone-boot.sh` is the source of truth for `~/.termux/boot/start-aadi.sh`. Termux:Boot runs it on power-up: wake lock, wait ~20s, broadcast Tailscale `CONNECT_VPN` to `com.tailscale.ipn/.IPNReceiver` with a `MainActivity` fallback, a 10-minute reconnect loop, `sshd`, then the Aadi tmux loop (`cd ~/aadi-agent && npm start`). `deploy.sh` and `/build` never install or overwrite this file.

On a fresh phone, after Termux SSH works:

```sh
npm run phone:install-boot
```

That shows a diff, backs up the phone copy, then installs the repo script. It only runs when you invoke it.

Phone settings it relies on:

- Termux, Termux:Boot, and Tailscale from the same sources as now
- Tailscale Always-on VPN **ON**, “Block connections without VPN” **OFF**
- Battery Unrestricted + Autostart for Termux, Termux:Boot, and Tailscale
- Wall charger
- No screen lock
