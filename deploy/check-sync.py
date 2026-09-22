#!/usr/bin/env bash
set -euo pipefail
sudo -u postgres psql -d desktop_pet_platform -t -A -F' | ' -c "SELECT u.username, s.kind, octet_length(s.data::text) FROM user_sync_data s JOIN users u ON u.id=s.user_id ORDER BY u.username, s.kind;"
