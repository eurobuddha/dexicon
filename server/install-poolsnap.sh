#!/usr/bin/env bash
# One-time setup on the dexicon.org server (hetzner, eurobuddha.com) for the live book's POOL rows.
# Run from ~/Projects/minima:   ssh eurobuddha.com 'bash -s' < mds/dexicon/server/install-poolsnap.sh
#
#  1. Apache: serve /var/www/dexicon-live/ at https://dexicon.org/live/ (outside the site folder, so a site deploy
#     with rsync --delete can never wipe it). The vhost config is backed up first and tested before the reload.
#  2. systemd: run /root/pandapools-anchor/poolsnap.py every minute (read-only: block / coins / runscript on the
#     MegaMMR node at 127.0.0.1:9005; never sends, never signs) -> /var/www/dexicon-live/pools.json.
# Undo: systemctl disable --now dexicon-poolsnap.timer; restore the .bak config; systemctl reload apache2.
set -euo pipefail
C=/etc/apache2/sites-available/dexicon.org-le-ssl.conf
test -f /root/pandapools-anchor/poolsnap.py || { echo "copy server/poolsnap.py to /root/pandapools-anchor/ first"; exit 1; }
cp "$C" "/root/dexicon.org-le-ssl.conf.bak-$(date +%Y%m%d%H%M)"
mkdir -p /var/www/dexicon-live /var/lib/dexicon-live
if ! grep -q "Alias /live/" "$C"; then
  sed -i '0,/DocumentRoot \/var\/www\/dexicon.org/s##DocumentRoot /var/www/dexicon.org\n    Alias /live/ /var/www/dexicon-live/\n    <Directory /var/www/dexicon-live>\n        Require all granted\n    </Directory>#' "$C"
fi
apache2ctl configtest
systemctl reload apache2

cat > /etc/systemd/system/dexicon-poolsnap.service <<'EOF'
[Unit]
Description=dexicon.org live pool snapshot (read-only) -> /var/www/dexicon-live/pools.json
After=network-online.target
[Service]
Type=oneshot
Environment=PP_RPC=http://127.0.0.1:9005/
ExecStart=/usr/bin/python3 /root/pandapools-anchor/poolsnap.py
TimeoutStartSec=120
Nice=10
EOF
cat > /etc/systemd/system/dexicon-poolsnap.timer <<'EOF'
[Unit]
Description=Refresh dexicon.org pools.json every minute
[Timer]
OnActiveSec=10s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now dexicon-poolsnap.timer
sleep 20
ls -la /var/www/dexicon-live/pools.json && curl -s -o /dev/null -w "https://dexicon.org/live/pools.json -> %{http_code}\n" https://dexicon.org/live/pools.json
