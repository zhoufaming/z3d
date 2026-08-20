/**
 * 轻量网格修复。导入实际 3MF 时常带非流形 / 自交 / 破洞，这里做三件事：
 *   1) 剔除退化三角形（面积≈0、含 NaN、任意两点重合）
 *   2) 焊接重合顶点（位置量化后合并，消除重复顶点）
 *   3) 边界环检测 + earcut 封盖（闭合破洞）
 * 不保证 100% 流形，但能修掉最常见的导入缺陷。封盖面材质会置为双面以兜底法线方向。
 */
import * as THREE from 'three';
import earcut from 'earcut';

const EPS = 1e-4;

function key3(x, y, z, tol = 1e-3) {
  const q = (v) => Math.round(v / tol);
  return `${q(x)},${q(y)},${q(z)}`;
}

/** 取几何的三角形索引列表（每三角 3 个顶点索引，兼容 indexed / non-indexed） */
function triangleList(geo) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const out = [];
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) out.push([a[i], a[i + 1], a[i + 2]]);
  } else {
    for (let i = 0; i < pos.count; i += 3) out.push([i, i + 1, i + 2]);
  }
  return out;
}

/**
 * @param {THREE.BufferGeometry} src
 * @returns {{ geometry: THREE.BufferGeometry, report: {triangles:number, removedDegenerate:number, weldedVertices:number, filledHoles:number} }}
 */
export function repairGeometry(src) {
  const pos = src.getAttribute('position');
  const tris = triangleList(src);

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  // 1) 剔除退化
  let removedDegenerate = 0;
  const clean = [];
  for (const [ia, ib, ic] of tris) {
    va.fromBufferAttribute(pos, ia);
    vb.fromBufferAttribute(pos, ib);
    vc.fromBufferAttribute(pos, ic);
    if (![va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z].every(isFinite)) {
      removedDegenerate++;
      continue;
    }
    if (
      va.distanceToSquared(vb) < EPS * EPS ||
      vb.distanceToSquared(vc) < EPS * EPS ||
      va.distanceToSquared(vc) < EPS * EPS
    ) {
      removedDegenerate++;
      continue;
    }
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    if (ab.cross(ac).lengthSq() < 1e-8) {
      removedDegenerate++;
      continue;
    }
    clean.push([ia, ib, ic]);
  }

  // 2) 焊接重合顶点
  const map = new Map();
  const newPos = [];
  const remap = (i) => {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = key3(x, y, z);
    let ni = map.get(k);
    if (ni === undefined) {
      ni = newPos.length / 3;
      newPos.push(x, y, z);
      map.set(k, ni);
    }
    return ni;
  };
  const welded = clean.map(([a, b, c]) => [remap(a), remap(b), remap(c)]);
  const weldedVertices = Math.max(0, pos.count - newPos.length / 3);

  // 3) 封洞：统计边出现次数，只出现一次的是边界边，走环并 earcut 封盖
  const edgeCount = new Map();
  const ekey = (i, j) => (i < j ? `${i}_${j}` : `${j}_${i}`);
  for (const [a, b, c] of welded) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = ekey(u, v);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  const boundary = [];
  for (const [k, c] of edgeCount) {
    if (c === 1) {
      const [u, v] = k.split('_').map(Number);
      boundary.push([u, v]);
    }
  }

  let filledHoles = 0;
  const extra = [];
  if (boundary.length) {
    const adj = new Map();
    for (const [u, v] of boundary) {
      (adj.get(u) || adj.set(u, []).get(u)).push(v);
      (adj.get(v) || adj.set(v, []).get(v)).push(u);
    }
    const used = new Set();
    for (const start of adj.keys()) {
      if (used.has(start)) continue;
      const loop = [];
      let cur = start;
      let guard = 0;
      while (cur !== -1 && !used.has(cur) && guard++ < 100000) {
        used.add(cur);
        loop.push(cur);
        const nbrs = adj.get(cur) || [];
        let nx = -1;
        for (const n of nbrs) {
          if (!used.has(n)) {
            nx = n;
            break;
          }
        }
        if (nx === -1) break;
        cur = nx;
      }
      if (loop.length < 3) continue;

      // 投影到最佳平面做 earcut
      const pts = loop.map((vi) => new THREE.Vector3(newPos[vi * 3], newPos[vi * 3 + 1], newPos[vi * 3 + 2]));
      const bb = new THREE.Box3().setFromPoints(pts);
      const s = bb.getSize(new THREE.Vector3());
      let axis = 'z';
      if (s.x <= s.y && s.x <= s.z) axis = 'x';
      else if (s.y <= s.z) axis = 'y';
      const proj = (p) => (axis === 'x' ? [p.y, p.z] : axis === 'y' ? [p.x, p.z] : [p.x, p.y]);
      const flat = [];
      for (const p of pts) {
        const [a, b] = proj(p);
        flat.push(a, b);
      }
      const idx2 = earcut(flat);
      for (let i = 0; i < idx2.length; i += 3) {
        extra.push([loop[idx2[i]], loop[idx2[i + 1]], loop[idx2[i + 2]]]);
      }
      filledHoles++;
    }
  }

  const allTris = welded.concat(extra);
  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  const IndexArray = newPos.length / 3 > 65535 ? Uint32Array : Uint16Array;
  const arr = IndexArray === Uint32Array
    ? new Uint32Array(allTris.length * 3)
    : new Uint16Array(allTris.length * 3);
  for (let i = 0; i < allTris.length; i++) {
    arr[i * 3] = allTris[i][0];
    arr[i * 3 + 1] = allTris[i][1];
    arr[i * 3 + 2] = allTris[i][2];
  }
  outGeo.setIndex(new THREE.BufferAttribute(arr, 1));
  outGeo.computeVertexNormals();
  outGeo.computeBoundingBox();
  outGeo.computeBoundingSphere();

  return {
    geometry: outGeo,
    report: {
      triangles: allTris.length,
      removedDegenerate,
      weldedVertices,
      filledHoles,
    },
  };
}

/** 给单个零件做修复并替换几何（不释放旧几何，留给撤销快照） */
export function repairPart(part) {
  const { geometry, report } = repairGeometry(part.geometry);
  part.geometry = geometry;
  part.mesh.geometry = geometry;
  part.material.side = THREE.DoubleSide;
  part.material.needsUpdate = true;
  return report;
}
