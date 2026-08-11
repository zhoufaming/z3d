/**
 * 3MF 导出。
 *
 * 输出结构完全模仿 Bambu Studio 原生格式（几何拆到 3D/Objects/object_N.model，
 * 主文件只放容器 object 与 build item，启用 production extension + UUID），
 * 这样 Bambu Studio 的读取路径与它自己写出的文件完全一致，兼容风险最小。
 *
 * 保真策略：以第一个导入的文档为模板复制整个 Archive，
 * 只重写几何与配置相关的条目，其余（打印参数、缩略图、自定义 G-code 等）原样保留。
 */
import * as THREE from 'three';
import { Archive, CONTENT_TYPES_XML, ROOT_RELS_XML } from './archive.js';
import { serialize3mfTransform, serializeConfigMatrix } from './model-parser.js';
import { serializeModelSettings, setMeta } from './bambu-config.js';
import { escapeXml } from '../fast-scan.js';

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const BBS_NS = 'http://schemas.bambulab.com/package/2021';
const REL_TYPE_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

const uuid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

/** 坐标序列化：6 位小数足够（3MF 单位是毫米，精度 1nm），且避免科学计数法 */
function fmtCoord(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  if (r === 0) return '0';
  return String(r);
}

/**
 * 分块字符串构造器。
 * 直接往一个数组里 push 上百万个小片段，join 时会瞬间产生巨大内存峰值；
 * 这里每积累一定数量就合并一次，把峰值压下来。
 */
class ChunkWriter {
  constructor(flushAt = 8192) {
    this.buf = [];
    this.chunks = [];
    this.flushAt = flushAt;
  }
  push(s) {
    this.buf.push(s);
    if (this.buf.length >= this.flushAt) {
      this.chunks.push(this.buf.join(''));
      this.buf.length = 0;
    }
  }
  toString() {
    if (this.buf.length) {
      this.chunks.push(this.buf.join(''));
      this.buf.length = 0;
    }
    return this.chunks.join('');
  }
}

/**
 * 把一个 ScenePart 的几何写成 <object> 片段。
 * 顶点直接从 TypedArray 读，不做任何中间对象分配。
 */
function writeMeshObject(w, part, objectId) {
  const geo = part.geometry;
  const pos = geo.getAttribute('position').array;
  const index = geo.getIndex();
  const triAttrs = part.triAttrs;

  w.push(`  <object id="${objectId}" p:UUID="${uuid()}" type="model">\n`);
  w.push('   <mesh>\n    <vertices>\n');
  for (let i = 0; i < pos.length; i += 3) {
    w.push(
      `     <vertex x="${fmtCoord(pos[i])}" y="${fmtCoord(pos[i + 1])}" z="${fmtCoord(pos[i + 2])}"/>\n`,
    );
  }
  w.push('    </vertices>\n    <triangles>\n');

  if (index) {
    const arr = index.array;
    for (let t = 0, i = 0; i < arr.length; i += 3, t++) {
      const extra = triAttrs?.get(t);
      if (extra) {
        let s = '';
        for (const k of Object.keys(extra)) s += ` ${k}="${escapeXml(extra[k])}"`;
        w.push(`     <triangle v1="${arr[i]}" v2="${arr[i + 1]}" v3="${arr[i + 2]}"${s}/>\n`);
      } else {
        w.push(`     <triangle v1="${arr[i]}" v2="${arr[i + 1]}" v3="${arr[i + 2]}"/>\n`);
      }
    }
  } else {
    const n = pos.length / 3;
    for (let i = 0; i < n; i += 3) {
      w.push(`     <triangle v1="${i}" v2="${i + 1}" v3="${i + 2}"/>\n`);
    }
  }
  w.push('    </triangles>\n   </mesh>\n  </object>\n');
}

function modelHeader(extraMetadata = []) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="${BBS_NS}" xmlns:p="${PROD_NS}" requiredextensions="p">`,
  ];
  for (const m of extraMetadata) {
    lines.push(` <metadata name="${escapeXml(m.name)}">${escapeXml(m.value)}</metadata>`);
  }
  return lines.join('\n') + '\n';
}

/**
 * 导出工作区为 3MF Blob。
 * @param {import('../project.js').Project} project
 * @param {{application?: string}} opts
 */
export async function writeThreeMF(project, opts = {}) {
  const baseDoc = project.docs.get(project.baseDocId);
  const archive = baseDoc ? baseDoc.archive.clone() : new Archive();

  // ---- 清掉所有旧几何与失效的切片产物 ----
  for (const p of archive.list('3d/objects/')) archive.remove(p);
  for (const p of archive.list('3D/Objects/')) archive.remove(p);
  archive.remove('Metadata/slice_info.config');
  for (const p of [...archive.list('metadata/'), ...archive.list('Metadata/')]) {
    if (/\.gcode(\.md5)?$/i.test(p)) archive.remove(p);
  }

  // ---- 分配全局唯一 id（模仿拓竹：几何 object 与容器 object 共用一个递增序列）----
  let nextId = 1;
  const plan = [];
  for (const obj of project.objects) {
    const parts = obj.parts.map((part) => ({ part, id: nextId++ }));
    plan.push({ obj, parts, containerId: nextId++ });
  }

  // ---- 逐对象写出 3D/Objects/object_N.model ----
  const objectFiles = [];
  plan.forEach((entry, i) => {
    const path = `3D/Objects/object_${i + 1}.model`;
    const w = new ChunkWriter();
    w.push(modelHeader());
    w.push(' <resources>\n');
    for (const { part, id } of entry.parts) writeMeshObject(w, part, id);
    w.push(' </resources>\n <build/>\n</model>\n');
    archive.setText(path, w.toString());
    entry.path = '/' + path;
    objectFiles.push(path);
  });

  // ---- 主模型 3D/3dmodel.model ----
  const meta = baseDoc?.root.metadata?.length
    ? baseDoc.root.metadata.filter((m) => m.name !== 'Application')
    : [];
  meta.unshift({ name: 'Application', value: opts.application || 'Bambu3MF-Studio-0.1' });
  if (!meta.some((m) => m.name === 'BambuStudio:3mfVersion')) {
    meta.push({ name: 'BambuStudio:3mfVersion', value: '1' });
  }

  const mw = new ChunkWriter();
  mw.push(modelHeader(meta));
  mw.push(' <resources>\n');
  for (const entry of plan) {
    mw.push(`  <object id="${entry.containerId}" p:UUID="${uuid()}" type="model">\n`);
    mw.push('   <components>\n');
    for (const { part, id } of entry.parts) {
      // 零件矩阵取 localMatrix：mesh.matrixAutoUpdate 为 false，
      // 调 updateMatrix() 反而会用默认 TRS 把它冲掉。
      const t = serialize3mfTransform(part.localMatrix.elements, fmtCoord);
      mw.push(
        `    <component p:path="${entry.path}" objectid="${id}" p:UUID="${uuid()}" transform="${t}"/>\n`,
      );
    }
    mw.push('   </components>\n  </object>\n');
  }
  mw.push(' </resources>\n');
  mw.push(` <build p:UUID="${uuid()}">\n`);
  for (const entry of plan) {
    entry.obj.group.updateMatrix();
    const t = serialize3mfTransform(entry.obj.group.matrix.elements, fmtCoord);
    mw.push(
      `  <item objectid="${entry.containerId}" p:UUID="${uuid()}" transform="${t}" printable="${entry.obj.printable ? 1 : 0}"/>\n`,
    );
  }
  mw.push(' </build>\n</model>\n');
  archive.setText('3D/3dmodel.model', mw.toString());

  // ---- 关系文件 ----
  const relLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  ];
  objectFiles.forEach((p, i) => {
    relLines.push(` <Relationship Target="/${p}" Id="rel-${i + 1}" Type="${REL_TYPE_MODEL}"/>`);
  });
  relLines.push('</Relationships>', '');
  archive.setText('3D/_rels/3dmodel.model.rels', relLines.join('\n'));

  if (!archive.resolve('_rels/.rels')) archive.setText('_rels/.rels', ROOT_RELS_XML);
  if (!archive.resolve('[Content_Types].xml')) archive.setText('[Content_Types].xml', CONTENT_TYPES_XML);

  // ---- Metadata/model_settings.config ----
  archive.setText('Metadata/model_settings.config', buildModelSettings(project, plan, baseDoc));

  // ---- Metadata/project_settings.config：同步耗材颜色 ----
  if (baseDoc?.projectJson) {
    const json = JSON.parse(JSON.stringify(baseDoc.projectJson));
    if (project.filaments.length) {
      const n = Math.max(project.filaments.length, (json.filament_colour || []).length);
      const colours = [];
      const types = [];
      for (let i = 0; i < n; i++) {
        const f = project.filaments[i];
        colours.push(f ? f.color : (json.filament_colour?.[i] ?? '#FFFFFF'));
        types.push(f?.type || json.filament_type?.[i] || 'PLA');
      }
      json.filament_colour = colours;
      if (json.filament_type) json.filament_type = types;
    }
    archive.setText('Metadata/project_settings.config', JSON.stringify(json, null, 4));
  } else if (project.filaments.length) {
    // 纯新建（没有导入任何文件）时，基底归档是空的，需要自己造一份
    // 最小可识别的 project_settings.config，否则 Bambu Studio 打开会缺热床/耗材。
    archive.setText('Metadata/project_settings.config', JSON.stringify(defaultProjectJson(project), null, 4));
  }

  return archive.toBlob();
}

/** 纯新建项目时生成的最小 project_settings.config（模仿 Bambu 字段） */
function defaultProjectJson(project) {
  const { width, depth, height } = project.bed;
  const area = [`0x0`, `${width}x0`, `${width}x${depth}`, `0x${depth}`];
  return {
    printer_model: 'Bambu Lab X1 Carbon',
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printable_area: area,
    printable_height: String(height),
    filament_colour: project.filaments.map((f) => (f.color || '#FFFFFF').toLowerCase()),
    filament_type: project.filaments.map((f) => f.type || 'PLA'),
    filament_settings_id: project.filaments.map(() => '\"\"'),
    layer_height: 0.2,
    sparse_infill_density: 15,
    nozzle_diameter: 0.4,
  };
}

function buildModelSettings(project, plan, baseDoc) {
  const cfg = { objects: [], plates: [], assemble: [] };
  const tmpMatrix = new THREE.Matrix4();

  for (const entry of plan) {
    const src = entry.obj.settingsObject;
    // 复制原有 metadata（保留 support/seam 等我们没做 UI 的高级设置），再覆盖已知字段
    const metadata = src ? src.metadata.map((m) => ({ ...m })) : [];
    setMeta(metadata, 'name', entry.obj.name);
    if (!metadata.some((m) => m.key === 'extruder')) {
      setMeta(metadata, 'extruder', String(entry.obj.parts[0]?.extruder ?? 1));
    }

    const objNode = { id: String(entry.containerId), metadata, parts: [] };

    for (const { part, id } of entry.parts) {
      const sp = part.settingsPart;
      const pMeta = sp ? sp.metadata.map((m) => ({ ...m })) : [];
      setMeta(pMeta, 'name', part.name);
      tmpMatrix.copy(part.localMatrix);
      setMeta(pMeta, 'matrix', serializeConfigMatrix(tmpMatrix.elements, fmtCoord));
      setMeta(pMeta, 'extruder', String(part.extruder));
      objNode.parts.push({
        id: String(id),
        subtype: part.subtype || 'normal_part',
        metadata: pMeta,
        extra: sp?.extra ?? [],
      });
    }

    cfg.objects.push(objNode);
  }

  // 盘面：沿用基底文档第一个 plate 的设置，实例列表按当前对象重建
  const basePlate = baseDoc?.settings.plates?.[0];
  const plateMeta = basePlate
    ? basePlate.metadata.map((m) => ({ ...m }))
    : [
        { key: 'plater_id', value: '1' },
        { key: 'plater_name', value: '' },
        { key: 'locked', value: 'false' },
      ];
  setMeta(plateMeta, 'plater_id', '1');

  const instances = plan.map((entry, i) => ({
    metadata: [
      { key: 'object_id', value: String(entry.containerId) },
      { key: 'instance_id', value: '0' },
      { key: 'identify_id', value: String(100 + i * 2) },
    ],
  }));
  cfg.plates.push({ metadata: plateMeta, instances });

  cfg.assemble = plan.map((entry) => {
    entry.obj.group.updateMatrix();
    return {
      object_id: String(entry.containerId),
      instance_id: '0',
      transform: serializeConfigMatrix(entry.obj.group.matrix.elements, fmtCoord),
      offset: '0 0 0',
    };
  });

  return serializeModelSettings(cfg);
}
