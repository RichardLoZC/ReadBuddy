// PDF 导出共享模块：离屏窗口渲染打印版 HTML → Chromium printToPDF
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function renderPdfFromHtml(html) {
  const tmpHtml = path.join(os.tmpdir(), `readbuddy-export-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await pdfWin.loadFile(tmpHtml);
    await pdfWin.webContents.executeJavaScript('document.fonts.ready');
    const buf = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }, // 页边距交给打印版 HTML 的 CSS 控制
    });
    return buf;
  } finally {
    pdfWin.destroy();
    try { fs.unlinkSync(tmpHtml); } catch { /* 临时文件清理失败无所谓 */ }
  }
}

// 注册 IPC；saveDialog 用回调拿主窗口（测试场景可能没有主窗口）
function registerExportIpc(ipcMain, getWin, dialog) {
  ipcMain.handle('erm:export-pdf', async (_ev, { html, suggestedName }) => {
    try {
      const buf = await renderPdfFromHtml(html);
      // ERM_EXPORT_PATH：跳过保存对话框直接写文件（自动化测试 / 命令行导出用）
      if (process.env.ERM_EXPORT_PATH) {
        fs.writeFileSync(process.env.ERM_EXPORT_PATH, buf);
        return { ok: true, path: process.env.ERM_EXPORT_PATH };
      }
      const { canceled, filePath } = await dialog.showSaveDialog(getWin(), {
        title: '导出 PDF',
        defaultPath: suggestedName || 'ReadBuddy.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      fs.writeFileSync(filePath, buf);
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { renderPdfFromHtml, registerExportIpc };
