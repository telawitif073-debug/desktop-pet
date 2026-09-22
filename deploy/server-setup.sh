#!/usr/bin/env bash
# 宠物平台服务器一键部署脚本（Ubuntu 22.04 / 24.04，t2.micro 可用）
# 用法：scp 上传后 sudo bash server-setup.sh
set -euo pipefail

echo "==> 1/6 安装 Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
sudo apt-get install -y nodejs >/dev/null
node -v

echo "==> 2/6 安装并初始化 PostgreSQL"
sudo apt-get install -y postgresql postgresql-contrib >/dev/null
# 建库建用户（密码与 .env 的 DB_PASSWORD 保持一致，可修改）
sudo -u postgres psql <<'SQL'
ALTER USER postgres PASSWORD 'pet_pg_2026';
SELECT 'db ready';
SQL
sudo -u postgres createdb desktop_pet_platform 2>/dev/null || echo "db exists"

echo "==> 3/6 解压部署包到 /opt/pet"
sudo mkdir -p /opt/pet
sudo tar -xzf /tmp/pet-deploy.tar.gz -C /opt/pet
sudo chown -R ubuntu:ubuntu /opt/pet
ls /opt/pet

echo "==> 4/6 安装 systemd 服务"
sudo cp /opt/pet/deploy/pet-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pet-backend
sleep 3
curl -s http://127.0.0.1:3001/api/app-update | head -c 120 && echo " ... backend OK"

echo "==> 5/6 安装并配置 nginx（80 端口：/ 静态分发，/api 与 /uploads 反代后端）"
sudo apt-get install -y nginx >/dev/null
sudo cp /opt/pet/deploy/nginx-pet.conf /etc/nginx/sites-available/pet
sudo ln -sf /etc/nginx/sites-available/pet /etc/nginx/sites-enabled/pet
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "==> 6/6 开机自启确认"
sudo systemctl is-enabled pet-backend postgresql nginx

echo ""
echo "部署完成！用浏览器访问 http://<服务器IP>/api/app-update 验证。"
