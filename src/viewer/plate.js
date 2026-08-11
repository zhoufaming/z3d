/**
 * 热床可视化：床面 + 刻度网格 + 打印体积线框 + 原点标记。
 * 原点位于左前角 (0,0,0)，与切片器一致。
 */
import * as THREE from 'three';

export function buildPlate(bed) {
  const { width, depth, height } = bed;
  const group = new THREE.Group();
  group.userData.bed = bed;
  group.name = 'plate';

  // ---- 床面 ----
  const surfaceGeo = new THREE.PlaneGeometry(width, depth);
  surfaceGeo.translate(width / 2, depth / 2, 0);
  const surfaceMat = new THREE.MeshStandardMaterial({
    color: 0x1c1f26,
    roughness: 0.82,
    metalness: 0.12,
    map: makePlateTexture(width, depth),
  });
  const surface = new THREE.Mesh(surfaceGeo, surfaceMat);
  surface.receiveShadow = true;
  surface.position.z = -0.06;
  group.add(surface);

  // ---- 网格线：10mm 细线 + 50mm 粗线 ----
  group.add(makeGrid(width, depth, 10, 0x3b414d, 0.55));
  group.add(makeGrid(width, depth, 50, 0x5c6675, 0.9));

  // ---- 床面外框 ----
  const border = new THREE.LineSegments(
    edgesOfRect(width, depth),
    new THREE.LineBasicMaterial({ color: 0x8a94a6, transparent: true, opacity: 0.95 }),
  );
  border.position.z = 0.02;
  group.add(border);

  // ---- 打印体积线框 ----
  const boxGeo = new THREE.BoxGeometry(width, depth, height);
  boxGeo.translate(width / 2, depth / 2, height / 2);
  const volume = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({ color: 0x49505e, transparent: true, opacity: 0.28 }),
  );
  boxGeo.dispose();
  group.add(volume);

  // ---- 原点坐标轴 ----
  const axes = new THREE.AxesHelper(28);
  axes.position.set(0, 0, 0.05);
  axes.material.depthTest = false;
  axes.material.transparent = true;
  axes.material.opacity = 0.9;
  group.add(axes);

  return group;
}

function makeGrid(width, depth, step, color, opacity) {
  const pts = [];
  for (let x = 0; x <= width + 0.001; x += step) {
    pts.push(x, 0, 0, x, depth, 0);
  }
  for (let y = 0; y <= depth + 0.001; y += step) {
    pts.push(0, y, 0, width, y, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const lines = new THREE.LineSegments(geo, mat);
  lines.position.z = 0.01;
  return lines;
}

function edgesOfRect(width, depth) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, width, 0, 0,
    width, 0, 0, width, depth, 0,
    width, depth, 0, 0, depth, 0,
    0, depth, 0, 0, 0, 0,
  ], 3));
  return geo;
}

/** 生成带纹理感的床面贴图，避免大平面看起来过于死板 */
function makePlateTexture(width, depth) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#22262e';
  ctx.fillRect(0, 0, size, size);

  // 细密噪点模拟 PEI 磨砂面
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(width / 64, depth / 64);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
