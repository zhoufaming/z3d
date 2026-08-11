/**
 * 高层 3MF 读取：File -> Doc
 *
 * 拓竹的典型结构是两层间接：
 *   build/item(objectid=2) -> 3dmodel.model 里 object id=2（只有 components）
 *   -> component p:path="/3D/Objects/object_1.model" objectid=1 -> 真正的 mesh
 * 通用 3MF 则可能 object 直接内联 mesh。两种都要支持。
 */
import { Archive } from './archive.js';
import { parseModelXml } from './model-parser.js';
import { parseModelSettings, readProjectSettings } from './bambu-config.js';
import { readAttr } from '../fast-scan.js';

const DEFAULT_MODEL_PATH = '3D/3dmodel.model';

function findPrimaryModelPath(archive) {
  const rels = archive.text('_rels/.rels');
  if (rels) {
    let i = 0;
    for (;;) {
      const tag = rels.indexOf('<Relationship', i);
      if (tag === -1) break;
      const close = rels.indexOf('>', tag);
      const type = readAttr(rels, 'Type', tag, close) || '';
      const target = readAttr(rels, 'Target', tag, close);
      if (target && type.endsWith('/3dmodel')) {
        const clean = target.replace(/^\/+/, '');
        if (archive.resolve(clean)) return archive.resolve(clean);
      }
      i = close === -1 ? tag + 13 : close;
    }
  }
  return archive.resolve(DEFAULT_MODEL_PATH) || DEFAULT_MODEL_PATH;
}

function normalizePath(p) {
  return String(p || '').replace(/^\/+/, '');
}

export async function readThreeMF(file) {
  const archive = await Archive.fromBlob(file);
  const modelPath = findPrimaryModelPath(archive);
  const rootXml = archive.text(modelPath);
  if (!rootXml) {
    throw new Error(`找不到主模型文件：${modelPath}`);
  }

  const root = parseModelXml(rootXml);

  // 递归加载 components 引用的外部 .model
  const externals = new Map();
  const pending = new Set();
  const collectPaths = (parsed) => {
    for (const obj of parsed.objects.values()) {
      for (const c of obj.components) {
        if (c.path) pending.add(normalizePath(c.path));
      }
    }
  };
  collectPaths(root);

  let guard = 0;
  while (pending.size && guard++ < 64) {
    const batch = [...pending];
    pending.clear();
    for (const p of batch) {
      if (externals.has(p)) continue;
      const xml = archive.text(p);
      if (!xml) continue;
      const parsed = parseModelXml(xml);
      externals.set(p, parsed);
      for (const obj of parsed.objects.values()) {
        for (const c of obj.components) {
          const cp = normalizePath(c.path);
          if (cp && !externals.has(cp)) pending.add(cp);
        }
      }
    }
  }

  const settingsXml = archive.text('Metadata/model_settings.config');
  const settings = parseModelSettings(settingsXml);
  const projectJson = archive.json('Metadata/project_settings.config');
  const projectInfo = readProjectSettings(projectJson);

  return {
    name: file.name || 'untitled.3mf',
    size: file.size || 0,
    archive,
    modelPath,
    root,
    externals,
    settings,
    projectJson,
    projectInfo,
  };
}

/**
 * 在 doc 中按 (path, objectid) 定位一个 object。path 为空表示主模型文件。
 */
export function lookupObject(doc, objectId, path) {
  if (!path) return doc.root.objects.get(String(objectId)) || null;
  const parsed = doc.externals.get(normalizePath(path));
  return parsed ? parsed.objects.get(String(objectId)) || null : null;
}

/**
 * 把一个 object 递归展开为扁平的 mesh 列表。
 * @returns {{objectId, path, mesh, matrix: number[]|null, sourceObject}[]}
 */
export function flattenObject(doc, objectId, path = null, depth = 0) {
  if (depth > 16) return [];
  const obj = lookupObject(doc, objectId, path);
  if (!obj) return [];

  if (obj.mesh && obj.mesh.indices.length) {
    return [{ objectId: obj.id, path, mesh: obj.mesh, matrix: null, sourceObject: obj }];
  }

  const out = [];
  for (const c of obj.components) {
    const childPath = c.path ? normalizePath(c.path) : path;
    const sub = flattenObject(doc, c.objectid, childPath, depth + 1);
    for (const s of sub) {
      out.push({
        ...s,
        // component 上的 transform 需要向下传递
        matrix: composeMatrix(c.transform, s.matrix),
        componentId: c.objectid,
      });
    }
  }
  return out;
}

/** 两个列主序 4x4 数组相乘：parent * child，任一为空则返回另一个 */
function composeMatrix(parent, child) {
  if (!parent) return child;
  if (!child) return parent;
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += parent[k * 4 + row] * child[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
