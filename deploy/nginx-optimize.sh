#!/usr/bin/env bash
# nginx 优化：gzip 压缩 + uploads 静态直出（不再代理到 node）
set -euo pipefail
cat > /etc/nginx/sites-available/pet <<'NGINX'
# 宠物平台 nginx：80 统一入口（Web 商店 + 静态分发 + API 反代）
server {
    listen 80 default_server;
    server_name _;

    client_max_body_size 100m;

    # gzip：API JSON / 文本资源压缩，弱网加载提速 3-5 倍
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types application/json application/javascript text/css text/plain image/svg+xml;

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

    # API 走后端
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }

    # 宠物资源 nginx 静态直出（带浏览器缓存，比 node 代理快）
    location /uploads/ {
        alias /opt/pet/backend/uploads/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }
}
NGINX
nginx -t 2>&1 | tail -1
systemctl reload nginx
sleep 1
echo '--- verify ---'
curl -s -o /dev/null -w 'png direct: %{http_code} %{size_download}\n' -H 'Accept-Encoding: gzip' http://127.0.0.1/uploads/1789719223734-f273859e6f78a60e.png
curl -s -o /dev/null -w 'pets gzip: %{http_code} %{size_download} enc=%{content_type}\n' -H 'Accept-Encoding: gzip' http://127.0.0.1/api/pets
curl -s -o /dev/null -w 'apk: %{http_code}\n' http://127.0.0.1/MobilePet-1.0.apk
curl -s -o /dev/null -w 'web: %{http_code}\n' http://127.0.0.1/
