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
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('找不到根元素 #root，请检查 index.html');
}

// 同一份渲染包三个用途：宠物窗（默认）、宠工坊（#/workshop）、
// 以及嵌在资源中心窗口内容区里的宠工坊（#/workshop/embedded，隐藏多余的顶栏入口）
const route = window.location.hash.replace(/^#/, '').split('/').filter(Boolean);
const isWorkshop = route[0] === 'workshop';
const isEmbedded = isWorkshop && route[1] === 'embedded';

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {isWorkshop ? <Studio brand="宠工坊" embedded={isEmbedded} /> : <App />}
  </React.StrictMode>
);