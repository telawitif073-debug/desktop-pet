#!/bin/bash
# 在 nginx server 块中加入版本化 APK 静态直出（幂等：已存在则跳过）
set -e
CONF=$(ls /etc/nginx/sites-enabled/*)
if grep -q '^/MobilePet-[^/]+\.apk' "$CONF"; then
  echo "already configured"
else
  sed -i '/# APK 与热更 bundle 静态直出/a\
    location ~ ^/MobilePet-[^/]+\\.apk$ {\
        root /srv/dist-share;\
        add_header Cache-Control "no-cache";\
    }' "$CONF"
fi
nginx -t
systemctl reload nginx
grep -n -A3 'MobilePet\|pet-bundle' "$CONF"
