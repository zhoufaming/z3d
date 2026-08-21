/**
 * 3MF 容器读写。
 *
 * 关键设计：读取时把 zip 内 **所有** entry 原样保存在 files 里。
 * 导出时只覆盖我们真正改动过的条目，其余字节原样写回。
 * 这是保证拓竹私有元数据（切片参数、缩略图、slice_info 等）不丢失、
 * 导出文件能被 Bambu Studio 正常打开的前提。
 */
import { unzip, zip, strFromU8, strToU8 } from 'fflate';

export class Archive {
  constructor(files = {}) {
    /** @type {Record<string, Uint8Array>} 路径 -> 原始字节 */
    this.files = files;
  }

  static async fromBlob(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return Archive.fromArrayBuffer(buf);
  }

  /**
   * 直接从已读入内存的字节解压。Worker 与主线程共用，避免重复实现解压逻辑。
   * @param {Uint8Array|ArrayBuffer} buf
   */
  static async fromArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    const files = await new Promise((resolve, reject) => {
      unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
    });
    return new Archive(files);
  }

  has(path) {
    return Object.prototype.hasOwnProperty.call(this.files, path);
  }

  /** 大小写不敏感 + 兼容前导斜杠的查找，3mf 各家写法不统一 */
  resolve(path) {
    const norm = path.replace(/^\/+/, '').toLowerCase();
    if (this.has(path)) return path;
    for (const key of Object.keys(this.files)) {
      if (key.replace(/^\/+/, '').toLowerCase() === norm) return key;
    }
    return null;
  }

  bytes(path) {
    const key = this.resolve(path);
    return key ? this.files[key] : null;
  }

  text(path) {
    const b = this.bytes(path);
    return b ? strFromU8(b) : null;
  }

  json(path) {
    const t = this.text(path);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  setText(path, content) {
    this.files[path] = strToU8(content);
  }

  setBytes(path, data) {
    this.files[path] = data;
  }

  remove(path) {
    const key = this.resolve(path);
    if (key) delete this.files[key];
  }

  list(prefix) {
    const p = prefix.toLowerCase();
    return Object.keys(this.files).filter((k) => k.toLowerCase().startsWith(p));
  }

  clone() {
    return new Archive({ ...this.files });
  }

  async toBlob() {
    // XML/config 用 deflate，PNG 等已压缩资源用 store，避免无谓 CPU 开销
    const input = {};
    for (const [path, data] of Object.entries(this.files)) {
      const lower = path.toLowerCase();
      const precompressed = /\.(png|jpg|jpeg|gz|zip)$/.test(lower);
      input[path] = [data, { level: precompressed ? 0 : 6 }];
    }
    const out = await new Promise((resolve, reject) => {
      zip(input, { mtime: new Date() }, (err, data) => (err ? reject(err) : resolve(data)));
    });
    return new Blob([out], { type: 'model/3mf' });
  }
}

/** 3MF 规范要求的基础骨架文件，从零构建工程时使用 */
export const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
 <Default Extension="config" ContentType="application/octet-stream"/>
</Types>`;

export const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
