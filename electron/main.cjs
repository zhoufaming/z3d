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
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

// ==================================================================
// AI 本地控制服务（opt-in，默认关闭）
// ------------------------------------------------------------------
// 仅当渲染进程的「AI 辅助」面板被开启时，由渲染进程经 IPC 拉起。
// 绑定 127.0.0.1，所有请求必须携带开启时生成的一次性 token。
// 外部 AI 代理 / 脚本通过它 POST 命令 JSON，经渲染进程的
// window.__bambuBridge.run() 驱动软件修改模型（见 src/core/ai-bridge.js）。
// ==================================================================
let aiServer = null;
let aiToken = null;
let mainWindow = null;

function sendToBridge(command) {
  if (!mainWindow) throw new Error('窗口未就绪');
  // 在渲染进程里调用桥；结果（结构化对象）会跨 IPC 序列化返回。
  return mainWindow.webContents.executeJavaScript(
    `window.__bambuBridge.run(${JSON.stringify(command)})`,
  );
}

function startAIServer(port, token) {
  if (aiServer) return;
  aiToken = token;
  aiServer = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      return send(200, { ok: true, service: 'bambu-ai-bridge', endpoints: ['/command (POST)', '/scene (GET)'] });
    }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        if (req.method === 'GET' && url === '/scene') {
          const r = await sendToBridge({ cmd: 'scene' });
          return send(200, r);
        }
        if (req.method !== 'POST' || url !== '/command') {
          return send(404, { ok: false, error: '未知端点' });
        }
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'JSON 解析失败' }); }
        if (parsed.token !== aiToken) return send(403, { ok: false, error: 'token 无效' });
        const command = parsed.command;
        if (!command || typeof command !== 'object' || !command.cmd) {
          return send(400, { ok: false, error: 'command 必须含 {cmd, args?}' });
        }
        const r = await sendToBridge(command);
        return send(200, r);
      } catch (err) {
        return send(500, { ok: false, error: String(err && err.message || err) });
      }
    });
  });
  aiServer.listen(port, '127.0.0.1', () => {
    console.log(`[AI] 控制服务已启动 http://127.0.0.1:${port} （token: ${token}）`);
  });
}

function stopAIServer() {
  if (aiServer) {
    aiServer.close();
    aiServer = null;
    aiToken = null;
    console.log('[AI] 控制服务已关闭');
  }
}

ipcMain.handle('ai:enable', (e, { port, token }) => { startAIServer(port, token); return { ok: true, port }; });
ipcMain.handle('ai:disable', () => { stopAIServer(); return { ok: true }; });
ipcMain.handle('fs:writeFile', (e, { path: p, base64 }) => {
  fs.writeFileSync(p, Buffer.from(base64, 'base64'));
  return { ok: true, path: p };
});
ipcMain.handle('fs:readFile', (e, { path: p }) => {
  const buf = fs.readFileSync(p);
  return { ok: true, base64: buf.toString('base64') };
});

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
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  buildMenu(win);
  // 通过 URL 时间戳强刷 index.html，避免 rebuild 后 Electron 仍加载旧缓存
  win.loadURL(`http://127.0.0.1:${PORT}/?v=${Date.now()}`);
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const prefix = ['verbose', 'info', 'warning', 'error'][level] || level;
    console.log(`[render][${prefix}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
  });
  return win;
}

let server = null;
app.whenReady().then(async () => {
  server = await startStaticServer();
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (server) server.close();
  stopAIServer();
});
