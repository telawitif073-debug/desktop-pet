#!/usr/bin/env bash
# 平台前端静态托管：/ 服务商店 Web，SPA 回退；其余路径保持原有语义
set -euo pipefail
mkdir -p /srv/web
rm -rf /srv/web/*
tar -xzf /tmp/web-dist.tar.gz -C /srv/web
cat > /etc/nginx/sites-available/pet <<'NGINX'
# 宠物平台 nginx：80 统一入口（Web 商店 + 静态分发 + API 反代）
server {
    listen 80 default_server;
    server_name _;

    client_max_body_size 100m;

    # 平台前端（商店 Web）SPA
    root /srv/web;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }

    # APK 与热更 bundle 静态直出
    location = /MobilePet-1.0.apk {
        alias /srv/dist-share/MobilePet-1.0.apk;
        add_header Cache-Control "no-cache";
    }
    location ~ ^/pet-bundle-\d+\.zip$ {
        root /srv/dist-share;
        add_header Cache-Control "no-cache";
    }

    # API 与宠物资源走后端
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
    location /uploads/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }
}
NGINX
nginx -t 2>&1 | tail -1
systemctl reload nginx
sleep 1
echo '--- verify ---'
curl -s -o /dev/null -w 'web: %{http_code} %{size_download}\n' http://127.0.0.1/
curl -s -o /dev/null -w 'spa fallback: %{http_code}\n' http://127.0.0.1/store
curl -s -o /dev/null -w 'apk: %{http_code} %{size_download}\n' http://127.0.0.1/MobilePet-1.0.apk
curl -s -o /dev/null -w 'api: %{http_code}\n' http://127.0.0.1/api/pets
curl -s -o /dev/null -w 'bundle3: %{http_code}\n' http://127.0.0.1/pet-bundle-3.zip
