#!/usr/bin/env bash
set -euo pipefail

# This changes the approved target VM only; it does not provision cloud resources.
release_input=${1:?Usage: sudo bash deploy.sh /opt/taskbattle/releases/RELEASE_ID domain.example}
domain=${2:?Supply the domain whose DNS already points to the approved VM}
[[ $EUID == 0 ]] || { echo 'Run as root on the target VM.' >&2; exit 1; }
[[ $domain =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && $domain == *.* ]] || exit 1
release=$(realpath -- "$release_input")
[[ $release == /opt/taskbattle/releases/* && -d $release ]] || exit 1
[[ $release != *$'\n'* && $release != *$'\r'* ]] || exit 1
for entry in runtime/start.mjs runtime/cleanup.mjs runtime/backup.mjs package.json; do
    [[ -f "$release/$entry" ]] || { echo "Missing release file: $entry" >&2; exit 1; }
done
[[ -d "$release/dist-yandex" && -d "$release/node_modules" ]] || { echo 'Missing built dist-yandex or runtime dependencies.' >&2; exit 1; }
[[ $(stat -c %U "$release") == root ]] || { echo 'The reviewed release directory must be owned by root.' >&2; exit 1; }
[[ -f /etc/taskbattle/runtime.env ]] || { echo 'Install runtime.env first.' >&2; exit 1; }
[[ -x /usr/bin/node ]] || { echo 'Install a pinned Node 24 archive first.' >&2; exit 1; }

NODE_NO_WARNINGS=1 /usr/bin/node --input-type=module - "$domain" <<'NODE'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24 is required');
const sqlite = new DatabaseSync(':memory:');
const version = sqlite.prepare('select sqlite_version() as version').get().version;
sqlite.close();
const [major, minor, patch] = version.split('.').map(Number);
const fixed = major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6)));
if (!fixed) throw new Error(`SQLite ${version} lacks the WAL-reset fix`);
const config = parseEnv(readFileSync('/etc/taskbattle/runtime.env', 'utf8'));
for (const name of ['YANDEX_BUCKET', 'YANDEX_BACKUP_BUCKET', 'YANDEX_LOCKBOX_SECRET_ID', 'APP_ORIGIN']) {
  if (!config[name] || /[\r\n]/.test(config[name])) throw new Error(`Missing or invalid ${name}`);
}
if (config.APP_ORIGIN !== `https://${process.argv[2]}`) throw new Error('APP_ORIGIN must match the HTTPS domain without a trailing slash');
if (config.DB_PATH !== '/var/lib/taskbattle/taskbattle.sqlite') throw new Error('Unexpected DB_PATH');
if (config.HOST !== '127.0.0.1' || config.PORT !== '3000' || config.NODE_ENV !== 'production') throw new Error('Expected production loopback settings');
if (config.YANDEX_BUCKET === config.YANDEX_BACKUP_BUCKET) throw new Error('Use separate photo and backup buckets');
NODE

id taskbattle >/dev/null
command -v caddy >/dev/null
install -d -o taskbattle -g taskbattle -m 0700 /var/lib/taskbattle
install -d -o root -g root -m 0755 /opt/taskbattle
chown root:taskbattle /etc/taskbattle/runtime.env
chmod 0640 /etc/taskbattle/runtime.env
# An import run as root can leave SQLite/WAL files unreadable to the service.
runuser -u taskbattle -- test -r /etc/taskbattle/runtime.env
runuser -u taskbattle -- test -w /var/lib/taskbattle
[[ -f /var/lib/taskbattle/taskbattle.sqlite ]] || { echo 'Import and verify the database before deployment.' >&2; exit 1; }
for data_file in /var/lib/taskbattle/taskbattle.sqlite /var/lib/taskbattle/taskbattle.sqlite-wal /var/lib/taskbattle/taskbattle.sqlite-shm; do
    if [[ -e $data_file ]]; then
        runuser -u taskbattle -- test -r "$data_file"
        runuser -u taskbattle -- test -w "$data_file"
    fi
done

infra="$release/infra/yandex"
[[ -f "$infra/Caddyfile.template" && -d "$infra/systemd" ]] || exit 1
candidate=$(mktemp /etc/caddy/taskbattle.XXXXXXXX)
trap 'rm -f -- "$candidate"' EXIT
sed "s/__DOMAIN__/$domain/g" "$infra/Caddyfile.template" > "$candidate"
caddy validate --config "$candidate" --adapter caddyfile
systemd-analyze verify "$infra/systemd/"*.service "$infra/systemd/"*.timer

# Keep the previous release for reviewed rollback. Never remove the SQLite directory.
if [[ -L /opt/taskbattle/current ]]; then
    readlink -f /opt/taskbattle/current > /opt/taskbattle/previous-release
elif [[ -e /opt/taskbattle/current ]]; then
    echo '/opt/taskbattle/current must be a managed symbolic link.' >&2
    exit 1
fi
ln -s "$release" /opt/taskbattle/current.next
mv -Tf /opt/taskbattle/current.next /opt/taskbattle/current
install -o root -g root -m 0644 "$candidate" /etc/caddy/Caddyfile
install -o root -g root -m 0644 "$infra/systemd/"*.service "$infra/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable taskbattle.service taskbattle-cleanup.timer taskbattle-backup.timer caddy.service
systemctl restart taskbattle.service
systemctl restart caddy.service
systemctl start taskbattle-cleanup.timer taskbattle-backup.timer
systemctl is-active --quiet taskbattle.service caddy.service
echo 'Services started. Verify readiness, HTTPS, persistence and backup restore before opening access.'
