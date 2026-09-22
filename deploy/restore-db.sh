#!/usr/bin/env bash
# 恢复数据库并输出各表行数
set -euo pipefail
sudo -u postgres pg_restore -h /var/run/postgresql --clean --if-exists -d desktop_pet_platform /root/pet-data.dump 2>&1 | tail -3 || true
echo '--- row counts ---'
sudo -u postgres psql -d desktop_pet_platform -t -A -F' | ' -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
