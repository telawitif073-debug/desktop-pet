/**
 * 云 TTS 音频播放器（隐藏 WebView 桥）。
 *
 * 为什么不用 react-native-sound：热更无法新增原生模块；项目已内置 react-native-webview，
 * 用一个常驻隐藏 WebView 内的 HTMLAudioElement 播放云端合成的音频（data URL 或 http(s) URL），
 * 无需任何新原生依赖。对话朗读、设置页试听、商店试听统一走这里。
 *
 * 用法：本组件在 App 根部挂载一次；任意模块 import { playVoice, stopVoice } 即可。
 */
import React, { useRef } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

type EndCb = (ok: boolean) => void;

interface Bridge {
  ready: boolean;
  pending: Array<{ src: string; cb: EndCb }> | null;
  webviewRef: React.RefObject<WebView<unknown> | null>;
}

const bridge: Bridge = {
  ready: false,
  pending: null,
  webviewRef: { current: null },
};

/**
 * 播放一段音频。
 * @param src http(s) 直链或 data:audio/...;base64,... 数据地址
 * @param cb  播放结束（true=自然播完，false=出错/被打断）
 */
export function playVoice(src: string, cb?: EndCb): void {
  // 新播放打断旧播放
  const old = bridge.pending;
  bridge.pending = null;
  old?.forEach((p) => p.cb(false));
  if (!bridge.ready) {
    bridge.pending = [{ src, cb: cb ?? (() => undefined) }];
    return;
  }
  bridge.pending = [{ src, cb: cb ?? (() => undefined) }];
  bridge.webviewRef.current?.injectJavaScript(`window.__pb(${JSON.stringify(src)});true;`);
}

/** 停止当前播放（回调收到 false） */
export function stopVoice(): void {
  const cur = bridge.pending;
  bridge.pending = null;
  cur?.forEach((p) => p.cb(false));
  bridge.webviewRef.current?.injectJavaScript('window.__pbStop();true;');
}

/** WebView 是否就绪（未就绪时 playVoice 会排队等） */
export function isVoicePlayerReady(): boolean {
  return bridge.ready;
}

const PLAYER_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head>
<body><audio id="a" preload="auto" playsinline></audio>
<script>
(function(){
  var a=document.getElementById('a');
  function send(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
  a.addEventListener('ended',function(){send({t:'ended'});});
  a.addEventListener('error',function(){send({t:'error'});});
  window.__pb=function(src){
    try{
      a.pause();
      a.src=src;
      var p=a.play();
      if(p&&p.catch){p.catch(function(e){send({t:'error',m:String(e)});});}
    }catch(e){send({t:'error',m:String(e)});}
  };
  window.__pbStop=function(){try{a.pause();a.currentTime=0;}catch(e){}};
  send({t:'ready'});
})();
</script></body></html>`;

export default function VoicePlayer(): React.JSX.Element {
  const ref = useRef<WebView<unknown>>(null);
  // 模块级 bridge 绑定到本次渲染的 ref（组件全局只挂一个实例）
  bridge.webviewRef = ref;

  const onMessage = (e: WebViewMessageEvent): void => {
    let msg: { t?: string } = {};
    try {
      msg = JSON.parse(e.nativeEvent.data) as { t?: string };
    } catch {
      return;
    }
    if (msg.t === 'ready') {
      bridge.ready = true;
      const q = bridge.pending;
      bridge.pending = null;
      // 只播排队中的最后一条
      const last = q?.[q.length - 1];
      if (last) {
        bridge.pending = [last];
        ref.current?.injectJavaScript(`window.__pb(${JSON.stringify(last.src)});true;`);
      }
    } else if (msg.t === 'ended') {
      const cur = bridge.pending;
      bridge.pending = null;
      cur?.forEach((p) => p.cb(true));
    } else if (msg.t === 'error') {
      const cur = bridge.pending;
      bridge.pending = null;
      cur?.forEach((p) => p.cb(false));
    }
  };

  return (
    <View pointerEvents="none" style={{ width: 1, height: 1, opacity: 0, position: 'absolute' }}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html: PLAYER_HTML }}
        onMessage={onMessage}
        mixedContentMode="always"
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled={false}
        scrollEnabled={false}
        androidLayerType="hardware"
      />
    </View>
  );
}
