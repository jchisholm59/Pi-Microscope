#!/bin/bash
# Copy Pi-Microscope to the Pi and restart it under pm2 (root SSH; files owned by jim, who runs pm2).
set -e
PI=${PI:-root@192.168.2.94}
cd "$(dirname "$0")"
tar cf - --exclude=data --exclude=.git --exclude=__pycache__ . |
  ssh "$PI" 'mkdir -p /home/jim/pi-microscope && cd /home/jim/pi-microscope && tar xf - && chown -R jim:jim /home/jim/pi-microscope &&
    su - jim -c "cd ~/pi-microscope && (pm2 describe pi-microscope >/dev/null 2>&1 && pm2 restart pi-microscope >/dev/null || pm2 start ecosystem.config.js >/dev/null) && pm2 save >/dev/null && echo deployed"'
