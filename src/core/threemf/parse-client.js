/**
 * 3MF 异步解析客户端：用 Web Worker 池把「解压 + XML 解析」移出主线程。
 *
 * - 掉入文件时主线程不再冻结，可继续渲染、响应交互。
 * - 多文件并发：按 CPU 核数开一个小池，队列调度，充分利用多核。
 * - 兼容性兜底：Worker 不可用（极少数环境）时回退主线程同步解析。
 *
 * 用法：
 *   import { parseThreeMF } from './parse-client.js';
 *   const doc = await parseThreeMF(file);  // 与 readThreeMF 返回结构一致
 */
import { Archive } from './archive.js';
import { readThreeMF } from './reader.js';

let pool = [];
let queue = [];
let seq = 0;
let workerDisabled = false;

function ensurePool() {
  if (pool.length || workerDisabled) return;
  const size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4)));
  for (let i = 0; i < size; i++) {
    let worker;
    try {
      worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
    } catch {
      workerDisabled = true;
      pool = [];
      return;
    }
    const slot = { worker, task: null };
    worker.onmessage = (e) => {
      const { doc, error } = e.data;
      const t = slot.task;
      slot.task = null;
      if (t) {
        if (error) t.reject(new Error(error));
        else {
          // Worker 回传的 archive 丢失了 Archive 方法，重建实例
          doc.archive = new Archive(doc.archive.files);
          t.resolve(doc);
        }
      }
      dispatch();
    };
    worker.onerror = (err) => {
      const t = slot.task;
      slot.task = null;
      if (t) t.reject(err);
      dispatch();
    };
    pool.push(slot);
  }
}

function dispatch() {
  if (!queue.length) return;
  const slot = pool.find((p) => !p.task);
  if (!slot) return;
  const task = queue.shift();
  slot.task = task;
  task.file
    .arrayBuffer()
    .then((buf) => {
      // buf 通过 transfer 零拷贝交给 Worker
      slot.worker.postMessage(
        { id: ++seq, buf, name: task.file.name, size: task.file.size },
        [buf],
      );
    })
    .catch((err) => {
      slot.task = null;
      task.reject(err);
      dispatch();
    });
}

/**
 * 解析一个 .3mf 文件，返回与 readThreeMF 完全一致的 doc。
 * @param {File|Blob} file
 * @returns {Promise<object>}
 */
export function parseThreeMF(file) {
  ensurePool();
  if (workerDisabled) {
    // 兜底：直接主线程同步解析
    return readThreeMF(file);
  }
  return new Promise((resolve, reject) => {
    queue.push({ file, resolve, reject });
    dispatch();
  });
}
