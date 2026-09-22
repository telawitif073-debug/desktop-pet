#!/usr/bin/env bash
# 服务器侧：nginx + 静态资源 + 清单地址
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get install -y nginx >/dev/null 2>&1

mkdir -p /srv/dist-share
cp /opt/pet/dist-share/MobilePet-1.0.apk /opt/pet/dist-share/pet-bundle-1.zip /opt/pet/dist-share/pet-bundle-2.zip /srv/dist-share/

python3 - <<'PY'
import json, io
p = '/opt/pet/backend/app-update.json'
d = json.load(io.open(p, encoding='utf-8'))
d['apkUrl'] = 'http://39.105.178.6/MobilePet-1.0.apk'
io.open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
print('apkUrl updated')
PY

cp /opt/pet/deploy/nginx-pet.conf /etc/nginx/sites-available/pet
ln -sf /etc/nginx/sites-available/pet /etc/nginx/sites-enabled/pet
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1 | tail -1
systemctl reload nginx

echo '--- verify ---'
curl -s -m 5 http://127.0.0.1/
curl -s -o /dev/null -w 'apk: %{http_code} %{size_download}\n' http://127.0.0.1/MobilePet-1.0.apk
curl -s -o /dev/null -w 'bundle: %{http_code}\n' http://127.0.0.1/pet-bundle-2.zip
curl -s -m 5 http://127.0.0.1/api/app-update | python3 -c 'import json,sys; d=json.load(sys.stdin); print("manifest:", d["versionCode"], d["apkUrl"]); print("notes:", d["notes"][:40])'
