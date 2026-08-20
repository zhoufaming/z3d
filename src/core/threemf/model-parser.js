/**
 * 3MF 核心模型文件（*.model）解析器。
 *
 * 不使用 DOMParser：一个 30 万面的模型会生成 30 万个 Element 节点，
 * 解析耗时和内存都无法接受。这里按标签做线性扫描，几何直接写进 TypedArray。
 */
import { scanFloat, scanInt, getCursor, readAttr, unescapeXml } from '../fast-scan.js';

/**
 * 统计子串出现次数。indexOf 是引擎原生实现，比正则快得多。
 */
function countOccurrences(s, needle, from, to) {
  let n = 0;
  let i = from;
  for (;;) {
    const idx = s.indexOf(needle, i);
    if (idx === -1 || idx >= to) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

/**
 * 解析 <mesh> 区间内的顶点与三角形。
 * @returns {{positions: Float32Array, indices: Uint32Array, triAttrs: Map<number, object>|null}}
 */
function parseMesh(xml, meshStart, meshEnd) {
  // 起点必须跳过容器标签本身：'<vertices' 前缀匹配 '<vertex'、
  // '<triangles' 前缀匹配 '<triangle'，否则首个元素会被重复计入一次。
  const vTag = xml.indexOf('<vertices', meshStart);
  const vStart = vTag === -1 ? -1 : xml.indexOf('>', vTag) + 1;
  const vEnd = vStart <= 0 ? -1 : xml.indexOf('</vertices>', vStart);
  const tTag = xml.indexOf('<triangles', meshStart);
  const tStart = tTag === -1 ? -1 : xml.indexOf('>', tTag) + 1;
  const tEnd = tStart <= 0 ? -1 : xml.indexOf('</triangles>', tStart);

  let positions = new Float32Array(0);
  let indices = new Uint32Array(0);

  if (vStart > 0 && vEnd !== -1 && vEnd <= meshEnd) {
    const count = countOccurrences(xml, '<vertex', vStart, vEnd);
    positions = new Float32Array(count * 3);
    let p = 0;
    let i = vStart;
    for (let k = 0; k < count; k++) {
      const tag = xml.indexOf('<vertex', i);
      if (tag === -1 || tag >= vEnd) break;
      // 属性顺序固定为 x y z（3MF 规范如此，拓竹/Orca/Prusa 均遵守）
      const xi = xml.indexOf('x="', tag);
      positions[p++] = scanFloat(xml, xi + 3, vEnd);
      const yi = xml.indexOf('y="', getCursor());
      positions[p++] = scanFloat(xml, yi + 3, vEnd);
      const zi = xml.indexOf('z="', getCursor());
      positions[p++] = scanFloat(xml, zi + 3, vEnd);
      i = getCursor();
    }
  }

  /** @type {Map<number, object>|null} 三角形上的非几何属性（MMU 涂色、材质），需原样保留 */
  let triAttrs = null;

  if (tStart > 0 && tEnd !== -1) {
    const count = countOccurrences(xml, '<triangle', tStart, tEnd);
    indices = new Uint32Array(count * 3);
    let p = 0;
    let i = tStart;
    let real = 0;
    for (let k = 0; k < count; k++) {
      const tag = xml.indexOf('<triangle', i);
      if (tag === -1 || tag >= tEnd) break;
      const close = xml.indexOf('>', tag);

      const v1i = xml.indexOf('v1="', tag);
      indices[p++] = scanInt(xml, v1i + 4, tEnd);
      const v2i = xml.indexOf('v2="', getCursor());
      indices[p++] = scanInt(xml, v2i + 4, tEnd);
      const v3i = xml.indexOf('v3="', getCursor());
      indices[p++] = scanInt(xml, v3i + 4, tEnd);

      // 只有带额外属性的三角形才记录，绝大多数三角形没有，稀疏 Map 更省内存
      const paint = readAttr(xml, 'paint_color', tag, close);
      const pid = readAttr(xml, 'pid', tag, close);
      const p1 = readAttr(xml, 'p1', tag, close);
      if (paint !== null || pid !== null || p1 !== null) {
        if (!triAttrs) triAttrs = new Map();
        const rec = {};
        if (paint !== null) rec.paint_color = paint;
        if (pid !== null) rec.pid = pid;
        if (p1 !== null) rec.p1 = p1;
        const p2 = readAttr(xml, 'p2', tag, close);
        const p3 = readAttr(xml, 'p3', tag, close);
        if (p2 !== null) rec.p2 = p2;
        if (p3 !== null) rec.p3 = p3;
        triAttrs.set(real, rec);
      }
      real++;
      i = close === -1 ? tag + 9 : close;
    }
    if (real * 3 !== indices.length) indices = indices.subarray(0, real * 3);
  }

  return { positions, indices, triAttrs };
}

/**
 * 3MF 的 transform 是 4x3 行主序、行向量约定（v * M）。
 * Three.js 用列向量约定（M * v），因此需要转置。
 * @returns {number[]} 长度 16 的列主序数组，可直接喂给 Matrix4.fromArray
 */
export function parse3mfTransform(str) {
  if (!str) return null;
  const v = str.trim().split(/\s+/).map(Number);
  if (v.length < 12 || v.some((n) => !Number.isFinite(n))) return null;
  // Matrix4.fromArray 接受列主序：[m11,m21,m31,m41, m12,m22,...]
  return [
    v[0], v[1], v[2], 0,
    v[3], v[4], v[5], 0,
    v[6], v[7], v[8], 0,
    v[9], v[10], v[11], 1,
  ];
}

/** 与 parse3mfTransform 相反：列主序 Matrix4.elements -> 3MF transform 字符串 */
export function serialize3mfTransform(elements, fmt) {
  const e = elements;
  const v = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]];
  return v.map(fmt).join(' ');
}

/**
 * model_settings.config 里的 matrix 是 16 个数，同样是行主序行向量约定。
 */
export function parseConfigMatrix(str) {
  if (!str) return null;
  const v = str.trim().split(/\s+/).map(Number);
  if (v.length < 16 || v.some((n) => !Number.isFinite(n))) return null;
  return [
    v[0], v[1], v[2], v[3],
    v[4], v[5], v[6], v[7],
    v[8], v[9], v[10], v[11],
    v[12], v[13], v[14], v[15],
  ];
}

export function serializeConfigMatrix(elements, fmt) {
  const e = elements;
  return [
    e[0], e[1], e[2], 0,
    e[4], e[5], e[6], 0,
    e[8], e[9], e[10], 0,
    e[12], e[13], e[14], 1,
  ].map(fmt).join(' ');
}

/**
 * 解析一个 .model 文件。
 * @returns {{unit, metadata, objects: Map<string, object>, build: object[], baseMaterials: object[], rawHeader: string}}
 */
export function parseModelXml(xml) {
  const result = {
    unit: readAttr(xml, 'unit', 0, 400) || 'millimeter',
    metadata: [],
    objects: new Map(),
    build: [],
    buildUUID: null,
    baseMaterials: [],
  };

  // ---- 文档级 metadata（Application / Designer / BambuStudio:3mfVersion 等）----
  {
    const resIdx = xml.indexOf('<resources');
    const limit = resIdx === -1 ? xml.length : resIdx;
    let i = 0;
    for (;;) {
      const tag = xml.indexOf('<metadata', i);
      if (tag === -1 || tag >= limit) break;
      const close = xml.indexOf('>', tag);
      const endTag = xml.indexOf('</metadata>', close);
      const name = readAttr(xml, 'name', tag, close);
      const value = endTag === -1 ? '' : xml.slice(close + 1, endTag);
      if (name) result.metadata.push({ name, value: unescapeXml(value) });
      i = endTag === -1 ? close + 1 : endTag + 11;
    }
  }

  // ---- basematerials ----
  {
    let i = 0;
    for (;;) {
      const start = xml.indexOf('<basematerials', i);
      if (start === -1) break;
      const end = xml.indexOf('</basematerials>', start);
      const groupId = readAttr(xml, 'id', start, xml.indexOf('>', start));
      const materials = [];
      let j = start;
      const stop = end === -1 ? xml.length : end;
      for (;;) {
        const b = xml.indexOf('<base ', j);
        if (b === -1 || b >= stop) break;
        const bc = xml.indexOf('>', b);
        materials.push({
          name: unescapeXml(readAttr(xml, 'name', b, bc) || ''),
          displaycolor: readAttr(xml, 'displaycolor', b, bc) || '#FFFFFF',
        });
        j = bc;
      }
      result.baseMaterials.push({ id: groupId, materials });
      i = end === -1 ? start + 14 : end + 16;
    }
  }

  // ---- objects ----
  {
    let i = xml.indexOf('<resources');
    if (i === -1) i = 0;
    for (;;) {
      const start = xml.indexOf('<object', i);
      if (start === -1) break;
      const headEnd = xml.indexOf('>', start);
      if (headEnd === -1) break;

      const selfClosing = xml.charCodeAt(headEnd - 1) === 47; /* '/' */
      const objEnd = selfClosing ? headEnd : xml.indexOf('</object>', headEnd);
      const scopeEnd = objEnd === -1 ? xml.length : objEnd;

      const id = readAttr(xml, 'id', start, headEnd);
      const obj = {
        id,
        type: readAttr(xml, 'type', start, headEnd) || 'model',
        name: unescapeXml(readAttr(xml, 'name', start, headEnd) || ''),
        uuid: readAttr(xml, 'p:UUID', start, headEnd) || readAttr(xml, 'UUID', start, headEnd),
        pid: readAttr(xml, 'pid', start, headEnd),
        pindex: readAttr(xml, 'pindex', start, headEnd),
        mesh: null,
        components: [],
      };

      if (!selfClosing) {
        const meshStart = xml.indexOf('<mesh', start);
        if (meshStart !== -1 && meshStart < scopeEnd) {
          obj.mesh = parseMesh(xml, meshStart, scopeEnd);
        }
        const compStart = xml.indexOf('<components', start);
        if (compStart !== -1 && compStart < scopeEnd) {
          const compEnd = xml.indexOf('</components>', compStart);
          const cStop = compEnd === -1 ? scopeEnd : compEnd;
          let j = compStart;
          for (;;) {
            const c = xml.indexOf('<component', j);
            if (c === -1 || c >= cStop) break;
            const cc = xml.indexOf('>', c);
            obj.components.push({
              objectid: readAttr(xml, 'objectid', c, cc),
              path: readAttr(xml, 'p:path', c, cc) || readAttr(xml, 'path', c, cc),
              uuid: readAttr(xml, 'p:UUID', c, cc),
              transform: parse3mfTransform(readAttr(xml, 'transform', c, cc)),
            });
            j = cc;
          }
        }
      }

      if (id) result.objects.set(id, obj);
      i = objEnd === -1 ? headEnd : objEnd + 9;
    }
  }

  // ---- build ----
  {
    const bStart = xml.indexOf('<build');
    if (bStart !== -1) {
      const bHead = xml.indexOf('>', bStart);
      result.buildUUID = readAttr(xml, 'p:UUID', bStart, bHead);
      const bEnd = xml.indexOf('</build>', bStart);
      const stop = bEnd === -1 ? xml.length : bEnd;
      let i = bStart;
      for (;;) {
        const it = xml.indexOf('<item', i);
        if (it === -1 || it >= stop) break;
        const ic = xml.indexOf('>', it);
        const plateRaw = readAttr(xml, 'p:plate', it, ic) || readAttr(xml, 'plate', it, ic);
        result.build.push({
          objectid: readAttr(xml, 'objectid', it, ic),
          uuid: readAttr(xml, 'p:UUID', it, ic),
          plate: plateRaw != null ? Number(plateRaw) : null,
          transform: parse3mfTransform(readAttr(xml, 'transform', it, ic)),
          printable: readAttr(xml, 'printable', it, ic) !== '0',
        });
        i = ic;
      }
    }
  }

  return result;
}
