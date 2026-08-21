/**
 * 3MF 解析 Web Worker。
 *
 * 打开文件时最重的同步操作是「解压 + XML 解析」（数十万面模型可达数百毫秒，
 * 直接卡死主线程 UI）。这里把整段解析搬进 Worker：
 *   - 主线程只负责把文件字节 transfer 过来（零拷贝）
 *   - Worker 解压 + 线性扫描解析，产出与 readThreeMF 完全一致的 doc
 *   - Archive 字节通过 transfer 零拷贝回传，导出逻辑无需改动
 *
 * 几何构建（computeVertexNormals 等）仍在主线程 importDoc 里完成，
 * 实测仅约 50ms，不构成卡顿，留主线程可避免重建 Three.js 对象跨线程的复杂度。
 */
import { parseArchiveBytes } from './reader.js';

self.onmessage = async (e) => {
  const { id, buf, name, size } = e.data;
  try {
    const doc = await parseArchiveBytes(new Uint8Array(buf), { name, size });

    // 收集 Archive 内所有底层 ArrayBuffer，回传时零拷贝 transfer
    // 同一 buffer 可能被多个条目引用，去重避免 DataCloneError
    const transfer = [];
    const seen = new Set();
    const files = doc.archive.files;
    for (const key of Object.keys(files)) {
      const u = files[key];
      if (u && u.buffer && !seen.has(u.buffer)) {
        seen.add(u.buffer);
        transfer.push(u.buffer);
      }
    }

    self.postMessage({ id, doc }, transfer);
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
