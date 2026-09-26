#!/usr/bin/env bash
# Viralense — one-command setup for a fresh Vultr Ubuntu server (22.04 / 24.04).
#
#   curl -fsSL https://raw.githubusercontent.com/ElvyaAne/viralense/finish-viralense/deploy/setup-vultr.sh | sudo bash
#
# Optional settings (put them before "bash"):
#   DOMAIN=viralense.example.com   use your own domain (point its A record at this server first)
#   BRANCH=main                    deploy a different git branch
#   TIGER_DATABASE_URL=postgres://...   store data in Tiger Data instead of a local file
#
# Re-run the same command any time to pull the latest code and restart.
#
# What it does: installs Node.js and Caddy, puts the app in /opt/viralense,
# runs it as a systemd service that restarts on crashes and reboots, and puts
# it behind HTTPS (browsers only allow the microphone on HTTPS). With no
# DOMAIN it uses a free <server-ip>.sslip.io address so HTTPS works right away.

set -euo pipefail

REPO="${REPO:-https://github.com/ElvyaAne/viralense.git}"
BRANCH="${BRANCH:-finish-viralense}"
APP_DIR=/opt/viralense
APP_USER=viralense
PORT=3000

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run this as root (put 'sudo' before 'bash')."
command -v apt-get >/dev/null || fail "This script expects Ubuntu or Debian."
export DEBIAN_FRONTEND=noninteractive

say "Installing basics"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node -v)"

if ! command -v caddy >/dev/null; then
  say "Installing Caddy (automatic HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Getting the code ($BRANCH)"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR" \
    || fail "Couldn't clone $REPO. If the repo is private, make it public or clone it into $APP_DIR yourself, then re-run."
fi

say "Installing app dependencies"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

# .env: create once, keep your edits on later runs
if [ ! -f .env ]; then
  say "Creating .env"
  {
    echo "PORT=$PORT"
    echo "HOST=127.0.0.1"
    echo "HASH_SALT=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
    echo "DEFAULT_LAT=45.4231"
    echo "DEFAULT_LNG=-75.6831"
    if [ -n "${TIGER_DATABASE_URL:-}" ]; then echo "TIGER_DATABASE_URL=$TIGER_DATABASE_URL"; fi
  } > .env
elif [ -n "${TIGER_DATABASE_URL:-}" ] && ! grep -q '^TIGER_DATABASE_URL=' .env; then
  echo "TIGER_DATABASE_URL=$TIGER_DATABASE_URL" >> .env
fi
chmod 600 .env
mkdir -p data
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if grep -q '^TIGER_DATABASE_URL=' .env; then
  say "Setting up the Tiger Data tables"
  sudo -u "$APP_USER" node db/init.js || echo "(db:init failed — the app will fall back to the local data file)"
fi

say "Starting the app as a service"
cat > /etc/systemd/system/viralense.service <<EOF
[Unit]
Description=Viralense
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node server.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable viralense >/dev/null
systemctl restart viralense

for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null \
  || { journalctl -u viralense -n 30 --no-pager; fail "The app didn't start — see the log above."; }

say "Setting up HTTPS"
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -4 -fsS https://api.ipify.org || true)"
  [ -n "$IP" ] || fail "Couldn't find this server's public IP. Re-run with DOMAIN=your.domain"
  DOMAIN="${IP//./-}.sslip.io"
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "Done!"
cat <<EOF

  Viralense is live at:   https://$DOMAIN
  (the HTTPS certificate can take up to a minute the first time)

  Useful commands:
    Logs:        journalctl -u viralense -f
    Restart:     systemctl restart viralense
    Settings:    nano $APP_DIR/.env   (then restart)
    Demo data:   cd $APP_DIR && sudo -u $APP_USER node db/seed.js
    Update:      re-run the same curl command

  If the page doesn't load, check that your Vultr firewall group
  allows ports 80 and 443.
EOF
