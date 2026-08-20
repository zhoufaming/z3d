/**
 * Electron 预加载脚本（CommonJS，沙箱内安全暴露 IPC）。
 * 仅向渲染进程暴露一个最小、可控的桥：invoke（请求/响应）与 on（事件）。
 * 渲染进程通过 window.bambu.invoke('channel', payload) 与主进程通信，
 * 用于：开启/关闭 AI 本地控制服务、文件读写（导出/导入 3MF）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bambu', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => ipcRenderer.on(channel, (event, ...args) => listener(...args)),
});
