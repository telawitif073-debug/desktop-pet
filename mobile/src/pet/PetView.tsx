/**
 * 宠物渲染分流（新契约：宠物一律以**宠物包 zip** 分发）。
 * ---------------------------------------------------------------------------
 * 本体入口来自服务端校验快照的 `manifest.entry`（存在 PetAssetRef.entryPath）。
 * 渲染前确保包已解压到 `pets/<id>/`（安装时已解压则直接复用，缺失才补解压）：
 *  - image          → 本体是单张位图，直接显示（GIF 由原生自动播放）；
 *  - pack           → 本体是**帧序列**（body-animation），播放本体入口所在目录的帧图；
 *  - live2d/model3d → WebView 加载本地 overlay.html（复用桌面端 Pixi/three 管线，库走 CDN 需联网）。
 * 不再有「远端单图回退」：本体只存在于包内，因此先补解压、失败才提示。
 * 能力边界：本体入口是 webm 视频（kind=video）时移动端不播放透明视频，会落到单图分支并提示加载失败。
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { buildOverlayUrl } from '../native/OverlayPet';
import { useAppStore } from '../store/appStore';
import { listImages, unzipPetPack } from './petFiles';
import type { PetAssetRef } from '../types';

/** 去掉文件名取所在目录（RNFS 的 Android 路径统一用 `/`） */
const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'));

export default function PetView({ asset, size = 220 }: { asset: PetAssetRef | null; size?: number }): React.JSX.Element {
  const [entryFile, setEntryFile] = useState<string | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  // 服务器地址变化时自动重试（改对地址后无需退出重进）
  const baseUrl = useAppStore((s) => s.baseUrl);

  useEffect(() => {
    setEntryFile(null);
    setFrames([]);
    setError('');
    setIndex(0);
    if (!asset) return;
    let alive = true;
    (async () => {
      let entry = asset.localPath && (await RNFS.exists(asset.localPath)) ? asset.localPath : null;
      if (!entry) {
        if (!asset.entryPath) throw new Error('宠物包缺少本体入口信息，请重新安装');
        if (!asset.packUrl) throw new Error('宠物包缺少下载地址，请重新安装');
        const dir = await unzipPetPack(asset.id, asset.packUrl);
        entry = `${dir}/${asset.entryPath}`;
        if (!(await RNFS.exists(entry))) throw new Error(`宠物包里找不到本体：${asset.entryPath}`);
      }
      const list = asset.format === 'pack' ? await listImages(dirOf(entry)) : [];
      return { entry, list };
    })()
      .then((result) => {
        if (!alive) return;
        setEntryFile(result.entry);
        setFrames(result.list);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [asset?.id, asset?.packUrl, asset?.entryPath, baseUrl]);

  // 帧序列动画：120ms/帧（约 8fps，与桌面端包帧率量级一致）
  useEffect(() => {
    if (frames.length < 2) return;
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

  if (error) {
    return (
      <View style={[styles.box, styles.placeholder, box]}>
        <Text style={styles.hint}>宠物包加载失败{'\n'}{error}</Text>
      </View>
    );
  }

  if (!entryFile) {
    return (
      <View style={[styles.box, styles.placeholder, box]}>
        <ActivityIndicator />
        <Text style={styles.hint}>正在准备宠物包…</Text>
      </View>
    );
  }

  if (asset.format === 'live2d' || asset.format === 'model3d') {
    // iOS 暂未打包渲染页资源（Android 优先）；Android 加载与悬浮窗相同的 overlay.html。
    // 用解压后的**本地**入口路径替换 localPath，overlay 才能 file:// 直接读到模型与其相对资源。
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
          source={{ uri: buildOverlayUrl({ ...asset, localPath: entryFile }) }}
          style={styles.webview}
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

  const frameUri = frames.length > 1 ? frames[Math.min(index, frames.length - 1)] : entryFile;
  return <Image source={{ uri: `file://${frameUri}` }} style={box} resizeMode="contain" />;
}

const styles = StyleSheet.create({
  box: { alignSelf: 'center' },
  webview: { flex: 1, backgroundColor: 'transparent' },
  placeholder: { justifyContent: 'center', alignItems: 'center', borderRadius: 12, backgroundColor: '#F2F3F5' },
  hint: { color: '#888', textAlign: 'center', fontSize: 13, lineHeight: 20 },
});
