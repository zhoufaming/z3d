/**
 * 一键拆件：把选中对象重组成若干独立的 SceneObject。
 *
 * 两种模式：
 *   1) splitShells  —— 连通体拆分（Bambu Studio 的「拆分」）
 *      按三角网格的「共享顶点」连通性，把互不相连的分壳体拆成独立对象。
 *   2) cutObject    —— 平面切割（Bambu Studio 的「切割」）
 *      用 XY/任意平面把单个实体切成两半/多块，可选在截面生成封盖（实心）。
 *
 * 设计要点：
 *   - 所有操作都在「世界坐标三角形」层面进行：先 apply 各 part 的世界矩阵，
 *     再按规则重建几何。新对象几何独立分配，group 保持单位变换，视觉位置不变。
 *   - **绝不 dispose 原对象几何**：History 快照是引用，撤销时要靠原对象几何恢复。
 *   - 新生成的零件统一用 DoubleSide 材质，避免开放截面/封盖因法线朝内而发黑。
 */
import * as THREE from 'three';
import earcut from 'earcut';
import { SceneObject, ScenePart } from './project.js';

/** 收集对象所有可见 part 的世界坐标三角形（已应用 mesh.matrixWorld）。 */
export function collectWorldTriangles(object) {
  object.group.updateMatrixWorld(true);
  const tris = [];
  for (const part of object.parts) {
    if (!part.visible) continue;
    const geo = part.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    const m = part.mesh.matrixWorld;
    const idx = geo.getIndex();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const v = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      const vs = [];
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        v.fromBufferAttribute(pos, vi);
        vs.push(v.clone().applyMatrix4(m));
      }
      tris.push(vs);
    }
  }
  return tris;
}

function firstExtruder(object) {
  for (const p of object.parts) if (p.visible) return p.extruder || 1;
  return 1;
}

/** 由一组世界坐标三角形（[v0,v1,v2]）生成非索引 BufferGeometry */
function geometryFromTris(tris, side = THREE.FrontSide) {
  const positions = [];
  for (const t of tris) for (const v of t) positions.push(v.x, v.y, v.z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

function makeObject(name, tris, extruder) {
  const geo = geometryFromTris(tris, THREE.DoubleSide);
  const part = new ScenePart({
    name: 'part',
    geometry: geo,
    extruder,
    subtype: 'normal_part',
  });
  part.material.side = THREE.DoubleSide;
  const obj = new SceneObject({ name, sourceObjectId: null });
  obj.addPart(part);
  return obj;
}

// ===================== 连通体拆分 =====================

/**
 * 按连通分量拆分。
 * @param {SceneObject} object
 * @param {{minVolume?:number, maxPieces?:number}} [opts]
 *   minVolume  — 体积 < 该值(mm³)的碎屑壳体并入最大件，避免拆出碎渣
 *   maxPieces  — 最多保留的件数，超出部分并入最大件
 * @returns {{ objects: SceneObject[], changed: boolean }}
 */
export function splitShells(object, opts = {}) {
  const minVolume = opts.minVolume || 0;
  const maxPieces = opts.maxPieces || Infinity;
  const tris = collectWorldTriangles(object);
  if (tris.length === 0) return { objects: [], changed: false };

  // 顶点 weld：把坐标量化到 1e-3 mm 容差，空间重合的顶点视为同一个。
  const weld = new Map();
  let nextId = 0;
  const vid = (v) => {
    const k = `${Math.round(v.x * 1e3)},${Math.round(v.y * 1e3)},${Math.round(v.z * 1e3)}`;
    let id = weld.get(k);
    if (id === undefined) {
      id = nextId++;
      weld.set(k, id);
    }
    return id;
  };

  const tVids = tris.map((t) => [vid(t[0]), vid(t[1]), vid(t[2])]);

  // 并查集
  const parent = new Array(nextId);
  for (let i = 0; i < nextId; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (const [a, b, c] of tVids) {
    union(a, b);
    union(b, c);
  }

  // 分组：root -> 三角形列表
  const groups = new Map();
  for (let i = 0; i < tris.length; i++) {
    const r = find(tVids[i][0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(tris[i]);
  }

  if (groups.size <= 1) {
    // 单一连通体，没有可拆的「多体」
    return { objects: [], changed: false };
  }

  // 阈值过滤
  let groupsArr = [...groups.values()].map((g) => ({ tris: g, vol: triVolume(g) }));
  // 1) 碎屑归并：体积小于 minVolume 的并入最大件
  if (minVolume > 0 && groupsArr.length > 1) {
    const maxIdx = groupsArr.reduce((mi, g, i, arr) => (g.vol > arr[mi].vol ? i : mi), 0);
    const kept = [];
    for (let i = 0; i < groupsArr.length; i++) {
      if (i === maxIdx || groupsArr[i].vol >= minVolume) kept.push(groupsArr[i]);
      else kept[maxIdx].tris = kept[maxIdx].tris.concat(groupsArr[i].tris);
    }
    groupsArr = kept;
  }
  // 2) 件数上限：超过 maxPieces 时只保留体积最大的若干件，其余并入最大件
  if (groupsArr.length > maxPieces && maxPieces >= 1) {
    groupsArr.sort((a, b) => b.vol - a.vol);
    const base = groupsArr[0];
    for (let i = maxPieces; i < groupsArr.length; i++) {
      base.tris = base.tris.concat(groupsArr[i].tris);
    }
    groupsArr = groupsArr.slice(0, maxPieces);
  }

  if (groupsArr.length <= 1) {
    return { objects: [], changed: false };
  }

  const extruder = firstExtruder(object);
  const objects = [];
  let idx = 1;
  for (const g of groupsArr) {
    objects.push(makeObject(`${object.name} · 件${idx}`, g.tris, extruder));
    idx++;
  }
  return { objects, changed: true };
}

// ===================== 平面切割 =====================

/** 把多边形 fan 三角化，三角形 push 进 out（数组元素为 [v0,v1,v2]） */
function pushFan(out, poly) {
  for (let i = 1; i + 1 < poly.length; i++) out.push([poly[0], poly[i], poly[i + 1]]);
}

/** 一组世界坐标三角形的有向体积（取绝对值即实体积，单位 mm³）。 */
export function triVolume(tris) {
  let v = 0;
  for (const [a, b, c] of tris) {
    v += a.x * (b.y * c.z - b.z * c.y)
       - a.y * (b.x * c.z - b.z * c.x)
       + a.z * (b.x * c.y - b.y * c.x);
  }
  return Math.abs(v) / 6;
}

/**
 * 由截面交线段重建有序边界环（可能多个：外轮廓 + 洞）。
 * 每条 segment 是 [Vector3, Vector3]（一条被平面切的三角形边产生的两个交点）。
 * 交点 weld 后度数应为 2，沿边邻接走一圈即得闭环比。
 * @returns {Array<Array<THREE.Vector3>>} 每个元素是一条首尾不重复的环
 */
export function buildRings(segments, tol = 1e-3) {
  const weld = new Map();
  let next = 0;
  const keyOf = (p) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)},${Math.round(p.z / tol)}`;
  const wid = (p) => {
    const k = keyOf(p);
    let entry = weld.get(k);
    if (entry === undefined) {
      entry = { id: next++, p: p.clone() };
      weld.set(k, entry);
    }
    return entry.id;
  };
  const pts = [];
  const adj = new Map(); // wid -> 边索引数组
  const edges = [];
  for (const [pa, pb] of segments) {
    const ia = wid(pa);
    const ib = wid(pb);
    if (ia === ib) continue;
    const ei = edges.length;
    edges.push([ia, ib]);
    if (!adj.has(ia)) adj.set(ia, []);
    if (!adj.has(ib)) adj.set(ib, []);
    adj.get(ia).push(ei);
    adj.get(ib).push(ei);
  }
  for (const { p } of weld.values()) pts.push(p);

  const used = new Array(edges.length).fill(false);
  const rings = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const startV = edges[s][0];
    const ring = [pts[startV], pts[edges[s][1]]];
    let cur = edges[s][1];
    let guard = 0;
    while (guard++ < edges.length * 2) {
      let nextE = -1;
      for (const ei of (adj.get(cur) || [])) {
        if (!used[ei]) { nextE = ei; break; }
      }
      if (nextE === -1) break; // 无未用边（多为退化），结束本环
      used[nextE] = true;
      const e = edges[nextE];
      const nxt = e[0] === cur ? e[1] : e[0];
      if (nxt === startV) break; // 回到起点，闭环
      ring.push(pts[nxt]);
      cur = nxt;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** 把平面上的点集按指定轴投影成 2D。 */
function project2(p, axis) {
  if (axis === 0) return new THREE.Vector2(p.y, p.z);
  if (axis === 1) return new THREE.Vector2(p.x, p.z);
  return new THREE.Vector2(p.x, p.y);
}

/**
 * 截面封盖三角化（支持凹轮廓、带洞）。多级回退：
 *   1) THREE.ShapeUtils.triangulateShape（凹轮廓/带洞，首选）
 *   2) earcut（同为凹轮廓/带洞三角化，更鲁棒的回退）
 *   3) 返回空 —— 由 cutObject 外层 convexHull2D 兜底（凸包近似，绝不丢封盖）
 * @returns {Array<Array<THREE.Vector3>>} 封盖三角形（3D）
 */
export function triangulateCap(segments, axis) {
  const rings = buildRings(segments);
  if (!rings.length) return [];
  const projRings = rings.map((r) => r.map((p) => project2(p, axis)));
  const signedArea = (poly) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  };
  const ranked = projRings
    .map((poly, i) => ({ poly, ring: rings[i], area: signedArea(poly) }))
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const outer = ranked[0].poly;
  const holes = ranked.slice(1).map((r) => r.poly);
  // 三角化索引引用的是「2D 点拼接列表」；封盖要用原始 3D 点（保留 z 轴）
  const flat3D = [...ranked[0].ring, ...ranked.slice(1).map((r) => r.ring).flat()];

  // 第 1 级：THREE.ShapeUtils
  let faces = null;
  try {
    faces = THREE.ShapeUtils.triangulateShape(outer, holes);
  } catch (e) {
    faces = null;
  }

  // 第 2 级：earcut 回退（外轮廓 + 洞，扁平 2D 顶点 + hole 起始索引）
  if (!faces || !faces.length) {
    try {
      const vertices = [];
      const holeIndices = [];
      for (const xy of outer) vertices.push(xy.x, xy.y);
      for (const h of holes) {
        holeIndices.push(vertices.length / 2);
        for (const xy of h) vertices.push(xy.x, xy.y);
      }
      const idx = earcut(vertices, holeIndices.length ? holeIndices : null, 2);
      faces = [];
      for (let i = 0; i + 2 < idx.length; i += 3) faces.push([idx[i], idx[i + 1], idx[i + 2]]);
    } catch (e) {
      faces = null;
    }
  }

  if (!faces || !faces.length) return [];
  const out = [];
  for (const [a, b, c] of faces) {
    out.push([flat3D[a].clone(), flat3D[b].clone(), flat3D[c].clone()]);
  }
  return out;
}

/**
 * 截面交点的 2D 凸包（monotone chain），返回有序 3D 点环（按投影逆时针）。
 * 作为 triangulateCap 失败时的兜底：退化/带洞无法三角化时仍能填上一个凸包近似封盖。
 */
export function convexHull2D(points, axis) {
  const proj = points.map((p) => {
    let x, y;
    if (axis === 0) { x = p.y; y = p.z; }
    else if (axis === 1) { x = p.x; y = p.z; }
    else { x = p.x; y = p.y; }
    return { x, y, p };
  });
  const uniq = [];
  const seen = new Set();
  for (const q of proj) {
    const k = `${Math.round(q.x * 1e3)},${Math.round(q.y * 1e3)}`;
    if (!seen.has(k)) { seen.add(k); uniq.push(q); }
  }
  if (uniq.length < 3) return uniq.map((q) => q.p);
  uniq.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].map((q) => q.p);
}

const AXIS_LABEL = {
  x: ['+X 侧', '-X 侧'],
  y: ['+Y 侧', '-Y 侧'],
  z: ['上半', '下半'],
};

/**
 * 按平面 {axis} = dist 切割。
 * @param {SceneObject} object
 * @param {'x'|'y'|'z'} axis
 * @param {number} dist 平面在 axis 轴上的世界坐标 (mm)
 * @param {boolean} cap 是否在截面生成封盖（实心）
 * @returns {{ objects: SceneObject[], changed: boolean }}
 */
export function cutObject(object, axis, dist, cap) {
  const tris = collectWorldTriangles(object);
  if (!tris.length) return { objects: [], changed: false };

  const ax = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const posTris = [];
  const negTris = [];
  const segments = []; // 截面边界线段（封盖用）

  for (const t of tris) {
    const d = [t[0].getComponent(ax) - dist, t[1].getComponent(ax) - dist, t[2].getComponent(ax) - dist];
    const pos = [];
    const neg = [];
    const ips = []; // 本三角形被切出的交点（恰好 2 个时连成一条截面边界段）
    for (let e = 0; e < 3; e++) {
      const a = e;
      const b = (e + 1) % 3;
      const va = t[a];
      const vb = t[b];
      if (d[a] >= 0) pos.push(va);
      if (d[a] <= 0) neg.push(va);
      if (d[a] * d[b] < 0) {
        const tt = d[a] / (d[a] - d[b]);
        const ip = va.clone().lerp(vb, tt);
        pos.push(ip);
        neg.push(ip);
        ips.push(ip.clone());
      }
    }
    if (ips.length === 2) segments.push([ips[0], ips[1]]);
    if (pos.length >= 3) pushFan(posTris, pos);
    if (neg.length >= 3) pushFan(negTris, neg);
  }

  if (!posTris.length || !negTris.length) {
    // 平面没有穿过模型，无法切割
    return { objects: [], changed: false };
  }

  // 可选封盖：截面三角化（凹轮廓/带洞均正确），正/负两侧各填一份（DoubleSide 双面可见）
  if (cap && segments.length) {
    let capTris = triangulateCap(segments, ax);
    // 兜底：三角化封盖失败时（退化/带洞无法三角化）回退凸包近似，至少把截面填上
    if (!capTris.length) {
      const hull = convexHull2D(segments.flat(), ax);
      capTris = [];
      for (let i = 1; i + 1 < hull.length; i++) capTris.push([hull[0], hull[i], hull[i + 1]]);
    }
    for (const ct of capTris) {
      posTris.push([ct[0], ct[1], ct[2]]);
      negTris.push([ct[0], ct[2], ct[1]]); // 反转缠绕，法线朝 -axis
    }
  }

  const extruder = firstExtruder(object);
  const labels = AXIS_LABEL[axis];
  return {
    objects: [
      makeObject(`${object.name} ${labels[0]}`, posTris, extruder),
      makeObject(`${object.name} ${labels[1]}`, negTris, extruder),
    ],
    changed: true,
  };
}

// ===================== 网格整齐排列 =====================

/**
 * 把若干对象按网格整齐排到热床（XY 行优先，列满换行），最后整体居中。
 * 调用方需保证对象已落板（min.z=0）。
 * @param {SceneObject[]} objects
 * @param {{width:number, depth:number}} bed
 */
export function gridLayout(objects, bed) {
  const pad = 6;
  const { width, depth } = bed;
  const tmp = new THREE.Box3();
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  for (const o of objects) {
    o.computeBox(tmp);
    o.group.position.x += cursorX - tmp.min.x;
    o.group.position.y += cursorY - tmp.min.y;
    o.group.updateMatrixWorld(true);
    o.computeBox(tmp);
    const s = tmp.getSize(new THREE.Vector3());
    cursorX += s.x + pad;
    rowH = Math.max(rowH, s.y);
    if (cursorX > width - 4) {
      cursorX = 0;
      cursorY += rowH + pad;
      rowH = 0;
    }
  }
  // 整体居中到热床中心（仅 XY）
  const all = new THREE.Box3();
  for (const o of objects) all.union(o.computeBox(tmp));
  const c = all.getCenter(new THREE.Vector3());
  const shiftX = width / 2 - c.x;
  const shiftY = depth / 2 - c.y;
  for (const o of objects) {
    o.group.position.x += shiftX;
    o.group.position.y += shiftY;
    o.group.updateMatrixWorld(true);
  }
}

// ===================== 切割后底座 =====================

/**
 * 给一个对象生成贴合其底部的圆盘底座（类 Bambu Studio「添加底座」）。
 * 底座为圆柱：直径 = 对象 XY 投影外接圆直径 × margin，厚 thickness(mm)，底面贴床(z=0)。
 * @param {SceneObject} object 需已更新 matrixWorld（computeBox 会自行刷新）
 * @param {{thickness?:number, margin?:number}} [opts]
 * @returns {SceneObject} 仅含一个底座 part 的独立对象
 */
export function createBase(object, { thickness = 2, margin = 1.15 } = {}) {
  const box = object.computeBox(new THREE.Box3());
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = (Math.max(size.x, size.y) / 2) * margin;
  const geo = new THREE.CylinderGeometry(r, r, thickness, 64);
  geo.rotateX(Math.PI / 2); // 圆柱轴 Y -> Z（Z-up）
  geo.translate(center.x, center.y, thickness / 2); // 底面贴床 z=0
  const part = new ScenePart({
    name: 'base',
    geometry: geo,
    extruder: firstExtruder(object),
    subtype: 'normal_part',
  });
  part.material.side = THREE.DoubleSide;
  const baseObj = new SceneObject({ name: `${object.name} 底座`, sourceObjectId: null });
  baseObj.addPart(part);
  return baseObj;
}
