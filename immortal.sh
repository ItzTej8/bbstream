#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="bigg-boss-live"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ $EUID -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

# Never carry experimental/obsolete JavaScriptCore options into Bun.
for _bb_env in ${!BUN_JSC_@}; do unset "$_bb_env"; done
unset BUN_JSC_forceGC 2>/dev/null || true

if [[ ! -f "$PROJECT_DIR/package.json" || ! -f "$PROJECT_DIR/src/index.mjs" ]]; then
  echo "ERROR: Run this from the project root."
  exit 1
fi

RUN_USER="${SUDO_USER:-admin}"
if ! id "$RUN_USER" >/dev/null 2>&1; then RUN_USER="admin"; fi
GROUP_NAME="$(id -gn "$RUN_USER")"
BUN_BIN="/usr/local/bin/bun"

if [[ ! -x "$BUN_BIN" ]]; then
  BUN_BIN="$(su - "$RUN_USER" -c 'command -v bun' 2>/dev/null || true)"
fi
if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "ERROR: Bun not found. Expected /usr/local/bin/bun"
  exit 1
fi

echo "[1/5] Installing runtime packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ffmpeg curl ca-certificates fonts-noto-color-emoji fonts-dejavu-core fonts-freefont-ttf fontconfig

echo "[2/5] Bun: $BUN_BIN"
"$BUN_BIN" --version
ffmpeg -version | head -n 1

echo "[3/5] Installing dependencies..."
chown -R "$RUN_USER":"$GROUP_NAME" "$PROJECT_DIR"
su - "$RUN_USER" -c "cd '$PROJECT_DIR' && '$BUN_BIN' install --frozen-lockfile || '$BUN_BIN' install"

rm -f /etc/systemd/system/bigg-boss-immortal.service /etc/systemd/system/bigg-boss-vps-canvas.service 2>/dev/null || true

cat > "$SERVICE_FILE" <<EOF2
[Unit]
Description=Bigg Boss 24x7 YouTube Live - Immortal
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$RUN_USER
Group=$GROUP_NAME
WorkingDirectory=$PROJECT_DIR
Environment="NODE_ENV=production"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
ExecStart=$BUN_BIN run src/index.mjs
Restart=always
RestartSec=5
TimeoutStartSec=0
TimeoutStopSec=20
KillSignal=SIGTERM
KillMode=control-group
NoNewPrivileges=true
LimitNOFILE=65535
TasksMax=infinity
OOMScoreAdjust=-200
Environment="HOME=/home/$RUN_USER"
Nice=0
CPUWeight=100
IOWeight=100
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF2

echo "[4/5] Enabling service..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service"
systemctl reset-failed "$SERVICE_NAME.service" || true
systemctl restart "$SERVICE_NAME.service"

echo "[5/5] Status..."
sleep 4
systemctl --no-pager --full status "$SERVICE_NAME.service" || true

echo
printf '%s\n' '============================================================'
printf '%s\n' ' IMMORTAL STREAM INSTALLED — STABLE VPS MODE'
printf '%s\n' '============================================================'
printf ' Bun     : %s\n' "$BUN_BIN"
printf ' Project : %s\n' "$PROJECT_DIR"
printf ' Service : %s\n' "$SERVICE_NAME"
printf '%s\n' ''
printf '%s\n' 'SSH/Bitvise can be closed safely.'
printf '%s\n' 'The stream is owned by systemd, not your SSH session.'
printf '%s\n' ''
printf '%s\n' 'Logs:'
printf '%s\n' "  sudo journalctl -u $SERVICE_NAME -f"
printf '%s\n' 'Status:'
printf '%s\n' "  sudo systemctl status $SERVICE_NAME"
printf '%s\n' 'Restart:'
printf '%s\n' "  sudo systemctl restart $SERVICE_NAME"
printf '%s\n' '============================================================'
