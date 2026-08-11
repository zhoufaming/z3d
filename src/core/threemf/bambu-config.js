/**
 * 拓竹 / OrcaSlicer 私有元数据解析。
 *
 * Metadata/model_settings.config —— 对象名、零件矩阵、挤出机(料槽)分配、盘面信息
 * Metadata/project_settings.config —— 切片参数 JSON，含耗材颜色与打印机热床尺寸
 */
import { readAttr, unescapeXml, escapeXml } from '../fast-scan.js';

/** 扫描 [from,to) 内的 <metadata key=".." value=".."/>，保持原有顺序 */
function scanMetadata(xml, from, to) {
  const list = [];
  let i = from;
  for (;;) {
    const tag = xml.indexOf('<metadata', i);
    if (tag === -1 || tag >= to) break;
    const close = xml.indexOf('>', tag);
    if (close === -1) break;
    const key = readAttr(xml, 'key', tag, close);
    const value = readAttr(xml, 'value', tag, close);
    if (key !== null) list.push({ key, value: unescapeXml(value ?? '') });
    i = close + 1;
  }
  return list;
}

function metaValue(list, key) {
  const hit = list.find((m) => m.key === key);
  return hit ? hit.value : null;
}

export function parseModelSettings(xml) {
  const result = { objects: [], plates: [], assemble: null };
  if (!xml) return result;

  // ---- objects ----
  let i = 0;
  for (;;) {
    const start = xml.indexOf('<object ', i);
    if (start === -1) break;
    const head = xml.indexOf('>', start);
    const end = xml.indexOf('</object>', head);
    const stop = end === -1 ? xml.length : end;

    const obj = {
      id: readAttr(xml, 'id', start, head),
      metadata: [],
      parts: [],
    };

    // 对象自身的 metadata 只取第一个 <part> 之前的部分，避免把零件属性吃进来
    const firstPart = xml.indexOf('<part ', head);
    const objMetaEnd = firstPart === -1 || firstPart > stop ? stop : firstPart;
    obj.metadata = scanMetadata(xml, head, objMetaEnd);

    let j = head;
    for (;;) {
      const p = xml.indexOf('<part ', j);
      if (p === -1 || p >= stop) break;
      const pHead = xml.indexOf('>', p);
      const pEnd = xml.indexOf('</part>', pHead);
      const pStop = pEnd === -1 ? stop : pEnd;
      const part = {
        id: readAttr(xml, 'id', p, pHead),
        subtype: readAttr(xml, 'subtype', p, pHead) || 'normal_part',
        metadata: scanMetadata(xml, pHead, pStop),
        // mesh_stat 等我们不理解的子节点原样保留，导出时写回
        extra: [],
      };
      let k = pHead;
      for (;;) {
        const ms = xml.indexOf('<mesh_stat', k);
        if (ms === -1 || ms >= pStop) break;
        const mc = xml.indexOf('>', ms);
        part.extra.push(xml.slice(ms, mc + 1));
        k = mc + 1;
      }
      obj.parts.push(part);
      j = pEnd === -1 ? pHead + 1 : pEnd + 7;
    }

    result.objects.push(obj);
    i = end === -1 ? head + 1 : end + 9;
  }

  // ---- plates ----
  i = 0;
  for (;;) {
    const start = xml.indexOf('<plate>', i);
    if (start === -1) break;
    const end = xml.indexOf('</plate>', start);
    const stop = end === -1 ? xml.length : end;
    const firstInst = xml.indexOf('<model_instance>', start);
    const metaEnd = firstInst === -1 || firstInst > stop ? stop : firstInst;

    const plate = {
      metadata: scanMetadata(xml, start, metaEnd),
      instances: [],
    };
    let j = start;
    for (;;) {
      const mi = xml.indexOf('<model_instance>', j);
      if (mi === -1 || mi >= stop) break;
      const miEnd = xml.indexOf('</model_instance>', mi);
      plate.instances.push({ metadata: scanMetadata(xml, mi, miEnd === -1 ? stop : miEnd) });
      j = miEnd === -1 ? mi + 16 : miEnd + 17;
    }
    result.plates.push(plate);
    i = end === -1 ? start + 7 : end + 8;
  }

  // ---- assemble ----
  {
    const start = xml.indexOf('<assemble>');
    if (start !== -1) {
      const end = xml.indexOf('</assemble>', start);
      const stop = end === -1 ? xml.length : end;
      const items = [];
      let j = start;
      for (;;) {
        const a = xml.indexOf('<assemble_item', j);
        if (a === -1 || a >= stop) break;
        const ac = xml.indexOf('>', a);
        items.push({
          object_id: readAttr(xml, 'object_id', a, ac),
          instance_id: readAttr(xml, 'instance_id', a, ac),
          transform: readAttr(xml, 'transform', a, ac),
          offset: readAttr(xml, 'offset', a, ac),
        });
        j = ac + 1;
      }
      result.assemble = items;
    }
  }

  return result;
}

export function serializeModelSettings(cfg) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];

  for (const obj of cfg.objects) {
    out.push(`  <object id="${escapeXml(obj.id)}">`);
    for (const m of obj.metadata) {
      out.push(`    <metadata key="${escapeXml(m.key)}" value="${escapeXml(m.value)}"/>`);
    }
    for (const part of obj.parts) {
      out.push(`    <part id="${escapeXml(part.id)}" subtype="${escapeXml(part.subtype)}">`);
      for (const m of part.metadata) {
        out.push(`      <metadata key="${escapeXml(m.key)}" value="${escapeXml(m.value)}"/>`);
      }
      for (const ex of part.extra) out.push(`      ${ex}`);
      out.push('    </part>');
    }
    out.push('  </object>');
  }

  for (const plate of cfg.plates) {
    out.push('  <plate>');
    for (const m of plate.metadata) {
      out.push(`    <metadata key="${escapeXml(m.key)}" value="${escapeXml(m.value)}"/>`);
    }
    for (const inst of plate.instances) {
      out.push('    <model_instance>');
      for (const m of inst.metadata) {
        out.push(`      <metadata key="${escapeXml(m.key)}" value="${escapeXml(m.value)}"/>`);
      }
      out.push('    </model_instance>');
    }
    out.push('  </plate>');
  }

  if (cfg.assemble && cfg.assemble.length) {
    out.push('  <assemble>');
    for (const a of cfg.assemble) {
      const attrs = [`object_id="${escapeXml(a.object_id)}"`, `instance_id="${escapeXml(a.instance_id)}"`];
      if (a.transform) attrs.push(`transform="${escapeXml(a.transform)}"`);
      if (a.offset) attrs.push(`offset="${escapeXml(a.offset)}"`);
      out.push(`   <assemble_item ${attrs.join(' ')} />`);
    }
    out.push('  </assemble>');
  }

  out.push('</config>');
  out.push('');
  return out.join('\n');
}

export { metaValue };

/** 读取或写入 metadata 列表中的某个 key */
export function setMeta(list, key, value) {
  const hit = list.find((m) => m.key === key);
  if (hit) hit.value = String(value);
  else list.push({ key, value: String(value) });
  return list;
}

/**
 * 从 project_settings.config 提取我们关心的信息。
 * 该文件是 OrcaSlicer/BambuStudio 的完整参数集，字段极多，这里只挑必要的。
 */
export function readProjectSettings(json) {
  if (!json) return null;
  const colours = json.filament_colour || json.filament_color || [];
  const types = json.filament_type || [];
  const filaments = colours.map((c, idx) => ({
    index: idx + 1,
    color: normalizeColor(c),
    type: types[idx] || 'PLA',
  }));

  let bed = null;
  const area = json.printable_area;
  if (Array.isArray(area) && area.length >= 3) {
    // 形如 ["0x0","256x0","256x256","0x256"]
    const pts = area
      .map((s) => String(s).split('x').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (pts.length) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      bed = {
        width: Math.max(...xs) - Math.min(...xs),
        depth: Math.max(...ys) - Math.min(...ys),
        height: Number(json.printable_height) || 250,
      };
    }
  }

  return {
    filaments,
    bed,
    printerModel: json.printer_model || json.printer_settings_id || '',
  };
}

export function normalizeColor(c) {
  if (!c) return '#CCCCCC';
  let s = String(c).trim();
  if (!s.startsWith('#')) s = '#' + s;
  // 拓竹会带 8 位 ARGB/RGBA，裁掉 alpha
  if (s.length === 9) s = s.slice(0, 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return '#CCCCCC';
  return s.toUpperCase();
}
