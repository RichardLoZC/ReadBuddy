// 预加载脚本：在隔离的渲染进程里安全地暴露导出 PDF 能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('erm', {
  isElectron: true,
  // 返回 { ok, path?, canceled?, error? }
  exportPdf: (html, suggestedName) => ipcRenderer.invoke('erm:export-pdf', { html, suggestedName }),
});
