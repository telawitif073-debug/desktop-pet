# 生产部署

## 1. 准备服务器

需要一台 Linux 云服务器，开放 `80/443`，并将域名 A/AAAA 记录指向服务器公网 IP。

```bash
cd platform
tcp .env.production.example .env.production
# 修改数据库密码、S3 密钥、PUBLIC_URL 和 JWT_SECRET

docker compose up -d --build
```

应用默认监听 `http://SERVER_IP:8080`。生产环境应把 8080 仅开放给本机 Nginx。桌面端开发时，平台前端使用 `http://localhost:5174`，Electron 主窗口使用自己的 Vite 端口。

## 2. 配置 HTTPS

安装 Nginx 和 Certbot，将 `nginx-https.conf` 中的 `example.com` 替换为真实域名，先用 HTTP 配置申请证书：

```bash
sudo certbot certonly --nginx -d example.com -d www.example.com
sudo cp nginx-https.conf /etc/nginx/sites-available/desktop-pet
sudo ln -sf /etc/nginx/sites-available/desktop-pet /etc/nginx/sites-enabled/desktop-pet
sudo nginx -t && sudo systemctl reload nginx
```

Certbot 会负责续期；续期后执行 `systemctl reload nginx`。

## 3. 存储和安全

Compose 使用 MinIO 的 S3 API，设置 `STORAGE_DRIVER=s3` 后上传文件不会写入应用容器。ClamAV 通过 `CLAMAV_HOST` 启用病毒扫描；扫描失败会拒绝上传。生产环境应替换默认 MinIO 密钥和 JWT secret，并将数据库、MinIO、日志卷纳入备份策略。

## 4. 云对象存储

迁移到 AWS S3、Azure Blob S3 Gateway 或兼容服务时，设置 `STORAGE_ENDPOINT`、`S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY`、`S3_SECRET_KEY` 和 `STORAGE_PUBLIC_URL`，无需修改业务代码。
