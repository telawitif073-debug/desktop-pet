/**
 * 宠物渲染分流：image/gif → RN Image（GIF 由原生自动播放）；
 * pack → 下载 zip 解压后帧序列定时器动画；
 * live2d/model3d → react-native-webview 加载本地 overlay.html（与悬浮窗同一渲染页，
 * 复用桌面端 Pixi/three.js 渲染管线，资源走平台 URL；渲染库从 CDN 加载需联网）。
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { unzip } from 'react-native-zip-archive';
import { assetUrl } from '../api/platform';
import { buildOverlayUrl } from '../native/OverlayPet';
import { useAppStore } from '../store/appStore';
import { normalizeFileUrl } from './petFiles';
import type { PetAssetRef } from '../store/appStore';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

async function walkImages(dir: string): Promise<string[]> {
  const entries = await RNFS.readDir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await walkImages(entry.path)));
    else if (IMAGE_RE.test(entry.name)) files.push(entry.path);
  }
  // 按文件名自然排序（frame1, frame2, ... frame10）
  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** pack 宠物：zip 下载解压到应用文档目录，返回帧图 file:// 路径列表（已存在则直接复用） */
async function ensurePackFrames(petId: string, fileUrl: string): Promise<string[]> {
  const dir = `${RNFS.DocumentDirectoryPath}/pets/${petId}`;
  if (await RNFS.exists(dir)) {
    const frames = await walkImages(dir);
    if (frames.length) return frames;
  }
  const zipPath = `${RNFS.DocumentDirectoryPath}/pets/${petId}.zip`;
  await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/pets`).catch(() => undefined);
  await RNFS.downloadFile({ fromUrl: assetUrl(normalizeFileUrl(fileUrl)), toFile: zipPath }).promise;
  await unzip(zipPath, dir);
  await RNFS.unlink(zipPath).catch(() => undefined);
  const frames = await walkImages(dir);
  if (!frames.length) throw new Error('动作包中没有可用的帧图');
  return frames;
}

export default function PetView({ asset, size = 220 }: { asset: PetAssetRef | null; size?: number }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  // image/gif：本地缓存优先；加载失败（文件缺失）时回退远程 URL
  const [useLocal, setUseLocal] = useState(true);
  const [imgFailed, setImgFailed] = useState(false);
  // 服务器地址变化时自动重置重试（改对地址后无需退出重进）
  const baseUrl = useAppStore((s) => s.baseUrl);

  const isPack = asset?.format === 'pack';

  useEffect(() => {
    setFrames(null);
    setError('');
    setIndex(0);
    setUseLocal(true);
    setImgFailed(false);
    if (!asset || asset.format !== 'pack') return;
    let alive = true;
    ensurePackFrames(asset.id, asset.fileUrl)
      .then((list) => {
        if (alive) setFrames(list);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [asset?.id, asset?.format, baseUrl]);

  // 帧序列动画：120ms/帧（约 8fps，与桌面包帧率量级一致）
  useEffect(() => {
    if (!frames || frames.length < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % frames.length), 120);
    return () => clearInterval(timer);
  }, [frames]);

  const box = { width: size, height: size } as const;

  if (!asset) {
    return (
      <View style={[styles.box, styles.placeholder, box]}>
        <Text style={styles.hint}>还没有宠物{'\n'}去商店领养一只吧</Text>
      </View>
    );
  }

  if (asset.format === 'live2d' || asset.format === 'model3d') {
    // iOS 暂未打包渲染页资源（Android 优先）；Android 加载与悬浮窗相同的 overlay.html
    if (Platform.OS !== 'android') {
      return (
        <View style={[styles.box, styles.placeholder, box]}>
          <Text style={styles.hint}>
            {asset.name}
            {'\n'}（{asset.format === 'live2d' ? 'Live2D' : '3D 模型'}渲染仅支持 Android）
          </Text>
        </View>
      );
    }
    return (
      <View style={[styles.box, box]}>
        <WebView
          source={{ uri: buildOverlayUrl(asset) }}
          style={[styles.webview, { backgroundColor: 'transparent' }]}
          originWhitelist={['*']}
          allowFileAccess
          domStorageEnabled
          javaScriptEnabled
          mixedContentMode="always"
          scrollEnabled={false}
          mediaPlaybackRequiresUserAction={false}
        />
      </View>
    );
  }

  if (asset.format === 'pack') {
    if (error) {
      return (
        <View style={[styles.box, styles.placeholder, box]}>
          <Text style={styles.hint}>帧包加载失败{'\n'}{error}</Text>
        </View>
      );
    }
    if (!frames) {
      return (
        <View style={[styles.box, styles.placeholder, box]}>
          <ActivityIndicator />
          <Text style={styles.hint}>正在下载帧包…</Text>
        </View>
      );
    }
    return (
      <Image
        source={{ uri: `file://${frames[Math.min(index, frames.length - 1)]}` }}
        style={[styles.image, box]}
        resizeMode="contain"
      />
    );
  }

  // image / gif：本地缓存文件优先（离线可用），失败回退平台远程（历史绝对 URL 归一为相对）
  const imageUri =
    useLocal && asset.localPath ? `file://${asset.localPath}` : assetUrl(normalizeFileUrl(asset.fileUrl));
  if (imgFailed) {
    return (
      <View style={[styles.box, styles.placeholder, box]}>
        <Text style={styles.hint}>
          形象加载失败{'\n'}请检查「设置 → 平台服务器」地址{'\n'}恢复后此宠物会自动缓存到本机
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: imageUri }}
      style={[styles.image, box]}
      resizeMode="contain"
      onError={() => {
        if (useLocal && asset.localPath) setUseLocal(false);
        else setImgFailed(true);
      }}
    />
  );
}

const styles = StyleSheet.create({
  box: { alignSelf: 'center' },
  image: {},
  webview: { flex: 1, backgroundColor: 'transparent' },
  placeholder: { justifyContent: 'center', alignItems: 'center', borderRadius: 12, backgroundColor: '#F2F3F5' },
  hint: { color: '#888', textAlign: 'center', fontSize: 13, lineHeight: 20 },
});
