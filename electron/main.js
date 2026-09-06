// Electron 主进程：内嵌启动本地服务，再开窗口加载页面；
// 另提供 printToPDF 导出（IPC 供渲染进程调用，--export-pdf 供命令行/测试用）
const { app, BrowserWindow } = require('electron');
const { renderPdfFromHtml, registerExportIpc } = require('./export');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.ERM_PORT || 3456);
const URL = `http://127.0.0.1:${PORT}`;

let serverProc = null;
let win = null;

function startServer() {
  // 用 Electron 自带的 Node 能力跑 server.js，避免依赖系统 PATH 里有 node
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => console.log(`[server] ${d}`.trim()));
  serverProc.stderr.on('data', (d) => console.error(`[server] ${d}`.trim()));
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (code && code !== 0 && win && !win.isDestroyed()) {
      win.loadURL(`data:text/html,<h2>本地服务启动失败（exit ${code}）</h2><pre>请在终端运行 npm run web 查看报错</pre>`);
    }
  });
}

async function waitServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 640,
    title: 'ReadBuddy',
    autoHideMenuBar: true,
    backgroundColor: '#faf8f4',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const ok = await waitServer();
  if (!ok) {
    win.loadURL(`data:text/html,<h2>本地服务未就绪</h2><pre>请重启应用；若持续失败，在终端运行 npm run web 查看报错</pre>`);
    return;
  }
  await win.loadURL(URL);
}

// 命令行测试模式：electron . --export-pdf <in.html> <out.pdf>（不联网、不开主窗口）
async function exportPdfCli(inFile, outFile) {
  await app.whenReady();
  const buf = await renderPdfFromHtml(fs.readFileSync(inFile, 'utf8'));
  fs.writeFileSync(outFile, buf);
  console.log(`已导出 ${outFile}（${(buf.length / 1024).toFixed(0)} KB）`);
  app.quit();
}

const argi = process.argv.indexOf('--export-pdf');
if (argi > 0 && process.argv[argi + 1] && process.argv[argi + 2]) {
  exportPdfCli(process.argv[argi + 1], process.argv[argi + 2]);
} else {
  registerExportIpc(require('electron').ipcMain, () => win, require('electron').dialog);

  app.whenReady().then(() => {
    startServer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS：手滑关掉窗口不退出应用，留在 Dock，点图标即恢复（服务保持运行）
    if (process.platform !== 'darwin') {
      if (serverProc) serverProc.kill();
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (serverProc) serverProc.kill();
  });
}
