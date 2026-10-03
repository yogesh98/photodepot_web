#!/usr/bin/env bash
set -euo pipefail

# Run with sudo on the Ubuntu VM after uploading this repository and both DMGs.
if [[ $EUID -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
source_dir=${PHOTODEPOT_SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
app_dir=/srv/photodepot/app
app_user=photodepot
id "$app_user" >/dev/null
for arch in arm64 x64; do
  test -s "$source_dir/public/downloads/photodepot-0.1.0-$arch.dmg"
done
test -s "$source_dir/.env"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils nginx

# Install the current Node 22 LTS Linux build from the official distribution,
# checking its SHA-256 before extraction. This app requires Node >=22.18.
if [[ ! -x /opt/photodepot-node/bin/node ]]; then
  node_tmp=$(mktemp -d)
  trap 'rm -rf "$node_tmp"' EXIT
  curl -fsSLo "$node_tmp/SHASUMS256.txt" https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  node_archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' "$node_tmp/SHASUMS256.txt")
  test -n "$node_archive"
  curl -fsSLo "$node_tmp/$node_archive" "https://nodejs.org/dist/latest-v22.x/$node_archive"
  (cd "$node_tmp" && awk -v name="$node_archive" '$2 == name' SHASUMS256.txt | sha256sum --check -)
  install -d /opt/photodepot-node
  tar -xJf "$node_tmp/$node_archive" --strip-components=1 -C /opt/photodepot-node
fi
export PATH="/opt/photodepot-node/bin:/opt/photodepot-tools/node_modules/.bin:$PATH"
node --version
if [[ ! -x /opt/photodepot-tools/node_modules/.bin/pnpm ]]; then
  npm install --prefix /opt/photodepot-tools pnpm@10.32.1
fi

install -d -o "$app_user" -g "$app_user" -m 0750 /srv/photodepot "$app_dir"
install -d -o "$app_user" -g "$app_user" -m 0700 /var/lib/photodepot
install -o "$app_user" -g "$app_user" -m 0700 "$source_dir/deploy/print-waitlist.sh" "/home/$app_user/waitlist.sh"
if [[ ! -f /srv/photodepot/.env ]]; then
  install -o "$app_user" -g "$app_user" -m 0600 "$source_dir/.env" /srv/photodepot/.env
fi

# Copy the source and installers, then install Linux dependencies and BUILD ON
# THE VM. Do not copy macOS node_modules or use next dev in production.
tar -C "$source_dir" --exclude='./node_modules' --exclude='./.pnpm-store' --exclude='./.next' --exclude='./.git' \
  --exclude='./.env*' --exclude='./data' --exclude='./.DS_Store' --exclude='*.tsbuildinfo' -cf - . \
  | tar -C "$app_dir" -xf -
ln -sfn /srv/photodepot/.env "$app_dir/.env"
chown -R "$app_user:$app_user" "$app_dir"
runuser -u "$app_user" -- env PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 \
  bash -c 'cd /srv/photodepot/app && pnpm install --frozen-lockfile && pnpm build'

install -m 0644 "$source_dir/deploy/photodepot.service" /etc/systemd/system/photodepot.service
install -m 0644 "$source_dir/deploy/nginx-lan.conf" /etc/nginx/sites-available/photodepot
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi
ln -sfn /etc/nginx/sites-available/photodepot /etc/nginx/sites-enabled/photodepot
nginx -t
systemctl daemon-reload
systemctl enable photodepot nginx
systemctl restart photodepot
systemctl reload-or-restart nginx
systemctl is-active photodepot nginx
echo 'Photodepot production build is running at http://192.168.1.152'
echo 'Reverse proxy upstream: http://192.168.1.152:80 (preserve Host and X-Forwarded-Proto).'
echo 'Private environment file: /srv/photodepot/.env'
echo 'Waitlist database: /var/lib/photodepot/waitlist.sqlite'
