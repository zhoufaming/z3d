/**
 * Electron 套壳主进程（CommonJS）。
 *
 * 前端已经是纯客户端 SPA（读取本地 3MF、WebGL 渲染、浏览器内导出），
 * 所以 Electron 侧只做三件事：
 *   1. 用一个小号 Node http 服务器把 `vite build` 产物 dist/ 托管起来
 *      —— ES module / 相对资源在 file:// 下会因 CORS 失败，必须走 http
 *   2. 开一个 BrowserWindow 加载这个本地地址
 *   3. 提供原生菜单（打开 / 追加 / 导出），直接驱动页面里已有的按钮
 *
 * 不引入任何 IPC / preload：菜单动作通过 webContents.executeJavaScript
 * 点页面按钮实现，复用 web 端完整的导入/导出逻辑，零双份代码。
 *
 * 用 .cjs 而非 .js：本项目 package.json 是 "type":"module"，写成 .js 会被当
 * 成 ESM，而 electron 自身是 CJS 包，ESM 加载器对其命名导出预解析会报错。
 */
const { app, BrowserWindow, Menu, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = 5188;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let rel = urlPath === '/' ? '/index.html' : urlPath;
        const filePath = path.normalize(path.join(DIST, rel));
        if (!filePath.startsWith(DIST)) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
              if (e2) res.writeHead(404).end('Not found');
              else res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
            });
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
          }).end(data);
        });
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function buildMenu(win) {
  const click = (id) =>
    win.webContents.executeJavaScript(
      `(() => { const b = document.getElementById('${id}'); if (b) b.click(); })()`,
    );

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开 3MF…', accelerator: 'CmdOrCtrl+O', click: () => click('btn-import') },
        { label: '追加合并…', click: () => click('btn-add') },
        { type: 'separator' },
        { label: '导出 3MF…', accelerator: 'CmdOrCtrl+S', click: () => click('btn-export') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => click('btn-undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => click('btn-redo') },
        { type: 'separator' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(win, {
              title: '关于 Bambu 3MF Studio',
              message: 'Bambu 3MF Studio',
              detail: '拓竹 3MF 项目文件查看与编辑器 · Electron 套壳',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b1d22',
    title: 'Bambu 3MF Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  buildMenu(win);
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  return win;
}

let server = null;
app.whenReady().then(async () => {
  server = await startStaticServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (server) server.close();
});
