#!/bin/bash
# Install the daily publication harvester inside CT101 (run on the Proxmox host as root):
#   bash /tmp/harvester/install.sh
set -euo pipefail
pct exec 101 -- mkdir -p /opt/nvc-harvester /home/dspace/harvest
pct push 101 /tmp/harvester/harvest.py /opt/nvc-harvester/harvest.py --perms 755
pct exec 101 -- test -f /opt/nvc-harvester/harvester.json || pct push 101 /tmp/harvester/harvester.json /opt/nvc-harvester/harvester.json --perms 600
pct exec 101 -- bash -c 'cat > /etc/systemd/system/nvc-harvester.service <<UNIT
[Unit]
Description=NVC Knowledge Hub faculty publication harvester
After=network-online.target dspace-backend.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/nvc-harvester/harvest.py
StandardOutput=append:/var/log/nvc-harvester.log
StandardError=append:/var/log/nvc-harvester.log
UNIT
cat > /etc/systemd/system/nvc-harvester.timer <<UNIT
[Unit]
Description=Run the NVC publication harvester daily at 03:30

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
UNIT
chown dspace:dspace /home/dspace/harvest
systemctl daemon-reload && systemctl enable --now nvc-harvester.timer && systemctl list-timers nvc-harvester.timer --no-pager'
echo "installed. Test without publishing:  pct exec 101 -- python3 /opt/nvc-harvester/harvest.py --dry-run"
