/**
 * 对象级操作工具：镜像、阵列、合并零件、导出 STL。
 * 这些操作都返回新的 SceneObject（几何独立分配），原对象几何不 dispose，
 * 以便 History 快照持有原对象引用时可撤销恢复。
 */
import * as THREE from 'three';
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { SceneObject, ScenePart } from './project.js';

/** 轴字符串 -> 索引 */
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * 几何镜像：沿 axis 轴翻转顶点坐标，并翻转三角形绕序修正法线。
 * 返回一份新的 BufferGeometry（不修改入参）。
 */
export function mirrorGeometry(geo, axis) {
  const ax = AXIS_INDEX[axis] ?? 2;
  const g = geo.clone();
  const pos = g.getAttribute('position');
  const arr = pos.array;
  for (let i = 0; i < arr.length; i += 3) arr[i + ax] = -arr[i + ax];

  const idx = g.getIndex();
  if (idx) {
    // indexed：交换每三角的后两个索引，反转缠绕
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
  } else {
    // non-indexed：每三个顶点一组交换后两个
    for (let i = 0; i < arr.length; i += 9) {
      const t0 = arr[i + 3], t1 = arr[i + 4], t2 = arr[i + 5];
      arr[i + 3] = arr[i + 6]; arr[i + 4] = arr[i + 7]; arr[i + 5] = arr[i + 8];
      arr[i + 6] = t0; arr[i + 7] = t1; arr[i + 8] = t2;
    }
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * 复制一个对象并沿 axis 镜像其几何（镜像已 bake 进几何顶点，
 * 保留 group 的原有变换，因此外部调用通常再落板+居中把副本摆回热床）。
 */
export function mirrorObject(source, axis, ScenePart, SceneObject) {
  const copy = new SceneObject({
    docId: source.docId,
    name: `${source.name} 镜像${axis.toUpperCase()}`,
    sourceObjectId: source.sourceObjectId,
    printable: source.printable,
    settingsObject: source.settingsObject,
  });
  copy.group.position.copy(source.group.position);
  copy.group.quaternion.copy(source.group.quaternion);
  copy.group.scale.copy(source.group.scale);
  copy.group.updateMatrix();

  for (const p of source.parts) {
    const part = new ScenePart({
      name: p.name,
      geometry: mirrorGeometry(p.geometry, axis),
      extruder: p.extruder,
      subtype: p.subtype,
      triAttrs: p.triAttrs,
      localMatrix: new THREE.Matrix4().copy(p.localMatrix),
      sourceObjectId: p.sourceObjectId,
      sourcePath: p.sourcePath,
      settingsPart: p.settingsPart,
    });
    part.material.color.copy(p.material.color);
    copy.addPart(part);
  }
  return copy;
}

/**
 * 线性 / 圆形阵列：以 source 为模板生成 (count-1) 个副本。
 * @param {{mode:'linear'|'circular', count:number, axis?:'x'|'y'|'z', spacing?:number, radius?:number}} opts
 * @returns {SceneObject[]} 不含原对象的副本列表
 */
export function arrayObjects(source, opts, ScenePart, SceneObject, cloneFn) {
  const count = Math.max(2, Math.floor(opts.count) || 2);
  const base = source.group.position.clone();
  const out = [];
  for (let i = 1; i < count; i++) {
    const copy = cloneFn(source, ScenePart, SceneObject);
    if (opts.mode === 'circular') {
      const ang = (i / count) * Math.PI * 2;
      const r = opts.radius ?? 50;
      copy.group.position.x = base.x + r * Math.cos(ang);
      copy.group.position.y = base.y + r * Math.sin(ang);
    } else {
      const ax = AXIS_INDEX[opts.axis ?? 'x'] ?? 0;
      const step = opts.spacing ?? 30;
      if (ax === 0) copy.group.position.x += i * step;
      else if (ax === 1) copy.group.position.y += i * step;
      else copy.group.position.z += i * step;
    }
    copy.group.updateMatrixWorld(true);
    out.push(copy);
  }
  return out;
}

/**
 * 合并一个对象内的所有（可见）零件为单一几何。
 * 把每 part 的 world 变换 bake 进顶点坐标，拼接成一份几何，
 * 返回一个新 SceneObject（含单个零件）。
 */
export function collapseObject(source) {
  source.group.updateMatrixWorld(true);
  const positions = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (const p of source.parts) {
    if (!p.visible) continue;
    const geo = p.geometry;
    const pos = geo.getAttribute('position');
    const m = new THREE.Matrix4().multiplyMatrices(source.group.matrixWorld, p.localMatrix);
    const idx = geo.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t;
      const i1 = idx ? idx.getX(t + 1) : t + 1;
      const i2 = idx ? idx.getX(t + 2) : t + 2;
      va.fromBufferAttribute(pos, i0).applyMatrix4(m);
      vb.fromBufferAttribute(pos, i1).applyMatrix4(m);
      vc.fromBufferAttribute(pos, i2).applyMatrix4(m);
      positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  const obj = new SceneObject({
    name: `${source.name} 合并`,
    sourceObjectId: null,
  });
  const part = new ScenePart({
    name: `${source.name} 合并`,
    geometry: merged,
    extruder: source.parts[0]?.extruder ?? 1,
    subtype: 'normal_part',
    localMatrix: new THREE.Matrix4(),
  });
  part.material.color.copy(source.parts[0]?.material.color || new THREE.Color(0xcccccc));
  obj.addPart(part);
  return obj;
}

/**
 * 把多个对象（各自的所有可见零件）bake 到世界坐标后拼成一个单一几何，
 * 返回一个新 SceneObject（含单个零件）。用于多对象合并。
 */
export function mergeObjects(sources, SceneObject, ScenePart) {
  const positions = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  let extruder = null;
  let color = null;
  for (const src of sources) {
    src.group.updateMatrixWorld(true);
    for (const p of src.parts) {
      if (!p.visible) continue;
      const geo = p.geometry;
      const pos = geo.getAttribute('position');
      const m = new THREE.Matrix4().multiplyMatrices(src.group.matrixWorld, p.localMatrix);
      const idx = geo.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t < n; t += 3) {
        const i0 = idx ? idx.getX(t) : t;
        const i1 = idx ? idx.getX(t + 1) : t + 1;
        const i2 = idx ? idx.getX(t + 2) : t + 2;
        va.fromBufferAttribute(pos, i0).applyMatrix4(m);
        vb.fromBufferAttribute(pos, i1).applyMatrix4(m);
        vc.fromBufferAttribute(pos, i2).applyMatrix4(m);
        positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
      }
      if (extruder === null) {
        extruder = p.extruder;
        color = p.material.color;
      }
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  const obj = new SceneObject({
    name: `合并 ${sources.length} 个对象`,
    sourceObjectId: null,
  });
  const part = new ScenePart({
    name: `合并 ${sources.length} 个对象`,
    geometry: merged,
    extruder: extruder ?? 1,
    subtype: 'normal_part',
    localMatrix: new THREE.Matrix4(),
  });
  if (color) part.material.color.copy(color);
  obj.addPart(part);
  return obj;
}

/**
 * 为对象自动生成底座 / 支撑：取对象世界包围盒，
 * 在床面(z=0)到对象最低点之间生成一块矩形基座，覆盖对象 XY 投影（含留边）。
 * 对象悬空时即为连接床面的支撑柱；已贴床时则是薄床板，提升附着力。
 * 返回一个新的 SceneObject（含单个基座零件），几何已 bake 到世界坐标。
 */
export function buildAutoBase(source, ScenePart, SceneObject, opts = {}) {
  const margin = opts.margin != null ? opts.margin : null;
  const box = source.computeBox(new THREE.Box3());
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const m = margin != null ? margin : Math.max(2, Math.min(size.x, size.y) * 0.1);
  const w = size.x + m * 2;
  const d = size.y + m * 2;
  // 基座从床面一直延伸到对象最低点（向上多探 1mm 保证咬合），最少 2mm 厚
  const h = Math.max(2, box.min.z + 1);
  const geo = new THREE.BoxGeometry(w, d, h);
  geo.translate(center.x, center.y, h / 2); // 底面坐落在 z=0，XY 对齐对象投影
  const obj = new SceneObject({
    name: `${source.name} 底座`,
    sourceObjectId: null,
  });
  const part = new ScenePart({
    name: '底座',
    geometry: geo,
    extruder: opts.extruder ?? 1,
    subtype: 'normal_part',
    localMatrix: new THREE.Matrix4(),
  });
  part.material.color.set('#9aa3ad');
  part.material.roughness = 0.85;
  obj.addPart(part);
  return obj;
}

/**
 * 把一个对象所有可见零件 bake 成世界坐标的单一几何（non-indexed）。
 * 用于布尔运算：两个对象都已处于世界坐标，结果几何即世界坐标、可直接落为独立对象。
 */
function bakeWorldGeometry(source) {
  const positions = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  source.group.updateMatrixWorld(true);
  for (const p of source.parts) {
    if (!p.visible) continue;
    const geo = p.geometry;
    const pos = geo.getAttribute('position');
    const m = new THREE.Matrix4().multiplyMatrices(source.group.matrixWorld, p.localMatrix);
    const idx = geo.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t;
      const i1 = idx ? idx.getX(t + 1) : t + 1;
      const i2 = idx ? idx.getX(t + 2) : t + 2;
      va.fromBufferAttribute(pos, i0).applyMatrix4(m);
      vb.fromBufferAttribute(pos, i1).applyMatrix4(m);
      vc.fromBufferAttribute(pos, i2).applyMatrix4(m);
      positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * 布尔运算：union / difference(A−B) / intersection。
 * 返回新的单一零件对象（几何已在世界坐标）。源对象几何不释放，供撤销。
 */
export function booleanObjects(a, b, op, SceneObject, ScenePart) {
  const brushA = new Brush(bakeWorldGeometry(a));
  const brushB = new Brush(bakeWorldGeometry(b));
  brushA.updateMatrixWorld();
  brushB.updateMatrixWorld();
  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  // 烤出的几何只有 position + normal（无 uv），而 Evaluator 默认还会追踪 uv，
  // 缺 uv 属性会在 evaluate 时读 undefined.array 崩溃。仅保留实际存在的属性。
  evaluator.attributes = ['position', 'normal'];
  const opCode = op === 'union' ? ADDITION : op === 'intersection' ? INTERSECTION : SUBTRACTION;
  const result = evaluator.evaluate(brushA, brushB, opCode);
  const geo = result.geometry;
  geo.computeVertexNormals();

  const sym = op === 'union' ? '∪' : op === 'intersection' ? '∩' : '−';
  const label = op === 'union' ? '并集' : op === 'intersection' ? '交集' : '差集';
  const aName = a.name || 'A';
  const bName = b.name || 'B';
  const resultName = `${aName} ${sym} ${bName}`;
  const obj = new SceneObject({ name: resultName, sourceObjectId: null });
  const part = new ScenePart({
    name: resultName,
    geometry: geo,
    extruder: a.parts[0]?.extruder ?? 1,
    subtype: 'normal_part',
    localMatrix: new THREE.Matrix4(),
  });
  if (a.parts[0]?.material) part.material.color.copy(a.parts[0].material.color);
  // 运算结果配色：并集/差集继承 A（差集即「被挖后的 A」）；交集是两体共有部分，
  // 给一个高亮琥珀色，方便在场景与对象树中一眼认出结果类型。
  if (op === 'intersection') part.material.color.setHex(0xffb74d);
  obj.addPart(part);

  // 上报信息，供 UI 预览提示（三角数 / 包围盒尺寸）
  const triAttr = geo.getIndex() ? geo.getIndex().count : geo.getAttribute('position').count;
  const triCount = triAttr / 3;
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  let dims = null;
  if (box) {
    dims = {
      x: +(box.max.x - box.min.x).toFixed(1),
      y: +(box.max.y - box.min.y).toFixed(1),
      z: +(box.max.z - box.min.z).toFixed(1),
    };
  }
  obj.booleanReport = { op, label, a: aName, b: bName, symbol: sym, triangles: triCount, dims };
  return obj;
}

/** 收集所有可打印、可见零件的世界坐标三角形（Vector3 扁平数组 [A,B,C,A,B,C,...]） */
function collectWorldTriangles(project) {
  const out = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (const o of project.activeObjects()) {
    if (!o.printable) continue;
    o.group.updateMatrixWorld(true);
    for (const p of o.parts) {
      if (!p.visible) continue;
      const geo = p.geometry;
      const pos = geo.getAttribute('position');
      const m = new THREE.Matrix4().multiplyMatrices(o.group.matrixWorld, p.localMatrix);
      const idx = geo.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t < n; t += 3) {
        const i0 = idx ? idx.getX(t) : t;
        const i1 = idx ? idx.getX(t + 1) : t + 1;
        const i2 = idx ? idx.getX(t + 2) : t + 2;
        va.fromBufferAttribute(pos, i0).applyMatrix4(m);
        vb.fromBufferAttribute(pos, i1).applyMatrix4(m);
        vc.fromBufferAttribute(pos, i2).applyMatrix4(m);
        out.push(va.clone(), vb.clone(), vc.clone());
      }
    }
  }
  return out;
}

/**
 * 导出 STL（二进制）。所有对象 baked 到世界坐标后写出。
 * @returns {Blob}
 */
export function writeSTL(project) {
  const tris = collectWorldTriangles(project);
  const triCount = tris.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  // 80 字节头（留空）
  dv.setUint32(80, triCount, true);
  let off = 84;
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const A = tris[t * 3];
    const B = tris[t * 3 + 1];
    const C = tris[t * 3 + 2];
    ab.subVectors(B, A);
    ac.subVectors(C, A);
    nrm.crossVectors(ab, ac).normalize();
    dv.setFloat32(off, nrm.x, true);
    dv.setFloat32(off + 4, nrm.y, true);
    dv.setFloat32(off + 8, nrm.z, true);
    off += 12;
    dv.setFloat32(off, A.x, true);
    dv.setFloat32(off + 4, A.y, true);
    dv.setFloat32(off + 8, A.z, true);
    off += 12;
    dv.setFloat32(off, B.x, true);
    dv.setFloat32(off + 4, B.y, true);
    dv.setFloat32(off + 8, B.z, true);
    off += 12;
    dv.setFloat32(off, C.x, true);
    dv.setFloat32(off + 4, C.y, true);
    dv.setFloat32(off + 8, C.z, true);
    off += 12;
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}
