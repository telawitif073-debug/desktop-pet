/// <reference types="vite/client" />

/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Studio from './components/Studio';
import PetWindow from './components/pet/PetWindow';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('找不到根元素 #root，请检查 index.html');
}

// 同一份渲染包四个用途：对话窗口（默认）、创作中心（#/workshop）、
// 嵌在资源中心窗口内容区里的创作中心（#/workshop/embedded，隐藏多余的顶栏入口），
// 以及桌宠悬浮窗（#/pet，透明/无边框/置顶）
const route = window.location.hash.replace(/^#/, '').split('/').filter(Boolean);
const isWorkshop = route[0] === 'workshop';
const isEmbedded = isWorkshop && route[1] === 'embedded';
const isPet = route[0] === 'pet';

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {isPet ? <PetWindow /> : isWorkshop ? <Studio brand="创作中心" embedded={isEmbedded} /> : <App />}
  </React.StrictMode>
);