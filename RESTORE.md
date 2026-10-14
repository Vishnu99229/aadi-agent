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
