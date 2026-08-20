/**
 * Electron 启动器（CommonJS）。
 *
 * 本机环境里被全局注入了 `ELECTRON_RUN_AS_NODE=1`，
 * 它会让 electron 二进制退化成普通 node：
 *   - require('electron') 退回 npm 包的字符串路径而不是主进程 API
 *   - process.type 变成 undefined
 *   - --version 打印的是 node 版本
 * 结果就是 main 进程里 app / BrowserWindow 全是 undefined。
 *
 * 解决：用 node 跑本脚本，spawn 真正的 electron 二进制前，
 * 把 ELECTRON_RUN_AS_NODE 从环境变量里删掉，子进程就不会退化。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

// 真正的 electron 可执行文件
const exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');

// 清理会让 electron 退化成 node 或直接拒绝启动的环境变量：
// - ELECTRON_RUN_AS_NODE：让 electron 退化成普通 node
// - NODE_OPTIONS（本机可能被注入 --use-system-ca 等 electron 不允许的标志）
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.NODE_OPTIONS;

const args = process.argv.slice(2);

// 默认 Chromium 标志：在 CI/沙箱/无显示环境中避免 GPU process 崩溃，
// 同时不影响正常桌面使用（仍启用硬件渲染）。
const safeFlags = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
];

// 在 CI / 无 GPU / 远程桌面等环境中，GPU process 可能完全无法初始化，
// 设置 BAMBU_ELECTRON_DISABLE_GPU=1 可强制软件渲染，仅用于验证启动。
if (process.env.BAMBU_ELECTRON_DISABLE_GPU === '1') {
  safeFlags.push('--disable-gpu');
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.NODE_OPTIONS;

const child = spawn(exe, [...safeFlags, ...(args.length ? args : ['.'])], {
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code) => process.exit(code === null ? 0 : code));
