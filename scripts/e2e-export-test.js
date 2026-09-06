// 无头 e2e：真实加载应用页面（含 preload），从 localStorage 历史打开文章，
// 点击真正的「📄 导出 PDF」按钮，经 IPC → printToPDF 落盘（ERM_EXPORT_PATH 跳过对话框）。
// 用法：ERM_EXPORT_PATH=/tmp/out.pdf node_modules/.bin/electron scripts/e2e-export-test.js
// 依赖已在运行的应用服务（http://127.0.0.1:3456），不会另起服务。
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerExportIpc } = require('../electron/export');

const URL = 'http://127.0.0.1:3456/';
const OUT = process.env.ERM_EXPORT_PATH || '/tmp/readbuddy-e2e.pdf';

registerExportIpc(ipcMain, () => null, dialog);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
    });
    await win.loadURL(URL);
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 等 app.js 初始化真正完成：loadProfile 之后才会填充水平下拉选项
        for (let i = 0; i < 100 && !document.querySelector('#levelSelect option'); i++) await sleep(100);
        if (!document.querySelector('#levelSelect option')) throw new Error('app.js 未初始化完成');
        if (!window.erm?.isElectron) throw new Error('preload 未注入 window.erm');
        window.__errs = [];
        window.addEventListener('error', (e) => window.__errs.push('ERR:' + e.message));
        window.addEventListener('unhandledrejection', (e) => window.__errs.push('REJ:' + (e.reason?.message || String(e.reason))));
        // 注入一篇带标注的文章到 localStorage，走与用户点击历史条目完全相同的路径
        const text = 'The scientist gave a lucid explanation of the paradox, but its ramifications remained opaque to most of the audience. She reiterated her thesis with meticulous care, hoping to elucidate the subtle nuances for everyone.';
        const list = [
          { word: 'ramifications', ipa: 'ræmɪfɪˈkeɪʃənz', common: 'n. 衍生结果；分支', context: 'n.（事件的）连带影响' },
          { word: 'reiterated', ipa: 'riˈɪtəreɪtɪd', common: 'v. 重申', context: 'v. 反复强调' },
          { word: 'elucidate', ipa: 'ɪˈluːsɪdeɪt', common: 'v. 阐明', context: 'v. 解释清楚' },
        ];
        localStorage.setItem('erm_history', JSON.stringify([{ id: Date.now(), createdAt: new Date().toISOString(), title: window.makeTitle(text), text, list, extras: [], mock: false }]));
        window.renderHistory();
        document.querySelector('#historyList .history-item .ht')?.click();
        await sleep(300);
        const anno = document.querySelectorAll('#articleRender ruby.anno').length;
        if (!anno) throw new Error('阅读页未渲染标注；errs=' + JSON.stringify(window.__errs) +
          '；readerHidden=' + document.querySelector('#readerCard')?.classList.contains('hidden') +
          '；paras=' + document.querySelectorAll('#articleRender p').length +
          '；freqLoaded=' + (window.state?.freq ? 1 : 'n/a'));
        document.querySelector('#btnExportPdf').click();
        // exportPdf 是 async 的，等 toast 出现即返回结果
        for (let i = 0; i < 100; i++) {
          await sleep(200);
          const t = document.querySelector('#toast, .toast');
          if (t && t.textContent.includes('已导出')) return { anno, toast: t.textContent };
        }
        return { anno, toast: '未等到导出结果' };
      })()
    `);
    console.log('e2e-result:', JSON.stringify(result));
    console.log('file-exists:', fs.existsSync(OUT), fs.existsSync(OUT) ? fs.statSync(OUT).size : 0);
    win.destroy();
  } catch (e) {
    console.error('e2e-failed:', e.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
