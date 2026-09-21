const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const port = 8899;
// /api/* 反向代理到本地 NestJS(3001)：一条隧道同时服务 APK 下载与平台 API
const apiPort = 3001;

function proxyApi(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.statusCode = 502;
    res.end('Bad Gateway');
  });
  req.pipe(upstream);
}

http
  .createServer((req, res) => {
    if (req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) return proxyApi(req, res);
    const u = decodeURIComponent(req.url.split('?')[0]);
    const name = u === '/' ? 'MobilePet-1.0.apk' : u.replace(/^\/+/, '');
    const f = path.join(dir, name);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.statusCode = 404;
      return res.end('404 Not Found');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(f)}"`);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
    console.log('served ' + f);
  })
  .listen(port, '0.0.0.0', () => console.log('listening on ' + port));
