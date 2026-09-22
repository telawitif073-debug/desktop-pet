const http = require('http');
function get(path) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get({ host: '39.105.178.6', path, timeout: 30000 }, (r) => {
      let n = 0;
      r.on('data', (c) => { n += c.length; });
      r.on('end', () => resolve({ status: r.statusCode, bytes: n, secs: (Date.now() - t0) / 1000, headers: r.headers }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}
(async () => {
  const png = await get('/uploads/1789719223734-f273859e6f78a60e.png');
  console.log(`png 1.4MB: ${png.status} ${png.secs.toFixed(1)}s = ${(png.bytes / 1024 / 1024 / png.secs).toFixed(2)} MB/s (${(png.bytes / 1024 / png.secs).toFixed(0)} KB/s)`);
  const zip = await get('/pet-bundle-4.zip');
  console.log(`bundle 343KB: ${zip.status} ${zip.secs.toFixed(1)}s`);
  const list = await get('/api/pets');
  console.log(`pets 11KB: ${list.status} ${list.secs.toFixed(1)}s gzip=${list.headers['content-encoding'] || 'none'}`);
})().catch((e) => console.log('ERR', e.code || e.message));
