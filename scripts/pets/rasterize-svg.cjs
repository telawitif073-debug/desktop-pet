#!/usr/bin/env electron
/**
 * 可选工具：把 SVG 矢量素材栅格化为带透明通道的 PNG
 * ---------------------------------------------------------------------------
 * 为什么用 Electron：项目已依赖 Electron（Chromium），渲染结果与最终运行环境一致，
 * 且不引入 cairosvg/rsvg/sharp 之类额外原生依赖。
 *
 * 为什么**不在**默认导入管线里：Chromium 的栅格化结果与 DPI/版本相关（实测同一文件在
 * 150% 缩放下输出 770x768、在 100% 下输出 512x512）。本项目的资产管线要求「跑两遍无 diff」，
 * 因此默认管线只把 SVG 登记进资源库（可预览），需要转成宠物形象/动作时再单独跑本工具。
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe scripts\pets\rasterize-svg.cjs \
 *       <file.svg|dir> [more...] --out=<dir> [--size=512]
 *
 * 产物：<out>/<原名>.png（SIZE×SIZE，RGBA，透明底）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// DPI 归一：否则 capturePage 返回的是设备像素尺寸，随系统缩放变化
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith('--out='));
const sizeArg = argv.find((a) => a.startsWith('--size='));
const SIZE = sizeArg ? Number(sizeArg.split('=')[1]) : 512;
const OUT = outArg ? outArg.split('=')[1] : path.join(process.cwd(), 'svg-rasterized');
const inputs = argv.filter((a) => !a.startsWith('--'));

function collect(target, out = []) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) collect(path.join(target, name), out);
  } else if (/\.svg$/i.test(target)) {
    out.push(target);
  }
  return out;
}

function htmlFor(svgBase64) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
  img{width:${SIZE}px;height:${SIZE}px;object-fit:contain;display:block}
  </style></head><body><img src="data:image/svg+xml;base64,${svgBase64}"></body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const files = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      console.error(`跳过（不存在）：${input}`);
      continue;
    }
    collect(input, files);
  }
  if (!files.length) {
    console.error('没有找到 .svg 输入');
    app.exit(1);
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-raster-'));
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  let ok = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const svg = fs.readFileSync(file, 'utf8');
      const htmlPath = path.join(tmpDir, `${path.basename(file, '.svg')}.html`);
      fs.writeFileSync(htmlPath, htmlFor(Buffer.from(svg).toString('base64')));
      await win.loadFile(htmlPath);
      await sleep(250); // 等 Chromium 解码/绘制完成
      const image = await win.webContents.capturePage();
      const target = path.join(OUT, `${path.basename(file).replace(/\.svg$/i, '')}.png`);
      fs.writeFileSync(target, image.toPNG());
      const size = image.getSize();
      console.log(`OK   ${path.basename(file)} -> ${size.width}x${size.height} ${fs.statSync(target).size}B`);
      ok++;
    } catch (e) {
      console.error(`FAIL ${path.basename(file)}: ${e.message}`);
      failed++;
    }
  }
  win.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`SUMMARY ok=${ok} failed=${failed} out=${OUT} size=${SIZE}`);
  app.exit(failed ? 2 : 0);
});
