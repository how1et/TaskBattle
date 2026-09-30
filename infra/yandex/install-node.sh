#!/usr/bin/env bash
set -euo pipefail

# Run on the approved Ubuntu VM only. Both arguments are mandatory, reviewed pins.
version=${1:?Usage: sudo bash install-node.sh 24.x.y SHA256_FROM_OFFICIAL_MANIFEST}
expected_sha=${2:?Supply the archive SHA-256 from nodejs.org for that exact version}
[[ $EUID == 0 ]] || { echo 'Run as root on the target VM.' >&2; exit 1; }
[[ $version =~ ^24\.[0-9]+\.[0-9]+$ && $expected_sha =~ ^[a-fA-F0-9]{64}$ ]] || exit 1
[[ $(uname -m) == x86_64 ]] || { echo 'This deployment requires amd64.' >&2; exit 1; }
if [[ -x /usr/bin/node ]]; then
    [[ $(/usr/bin/node --version) == "v$version" ]] && exit 0
    echo '/usr/bin/node already exists with a different version; review its replacement first.' >&2
    exit 1
fi

archive="node-v${version}-linux-x64.tar.xz"
target="/opt/node-v${version}-linux-x64"
[[ ! -e $target ]] || { echo 'Target Node directory already exists; inspect it first.' >&2; exit 1; }
temp_dir=$(mktemp -d /tmp/taskbattle-node.XXXXXXXX)
trap 'rm -f -- "$temp_dir/$archive"; rmdir -- "$temp_dir"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://nodejs.org/dist/v${version}/${archive}" -o "$temp_dir/$archive"
printf '%s  %s\n' "$expected_sha" "$temp_dir/$archive" | sha256sum --check --status
tar --extract --xz --file "$temp_dir/$archive" --directory /opt --no-same-owner
ln -s "$target/bin/node" /usr/bin/node
[[ $(/usr/bin/node --version) == "v$version" ]]
echo "Installed Node v$version. Deploy validation will also check the bundled SQLite version."
