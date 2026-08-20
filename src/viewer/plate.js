/**
 * 热床可视化：仿真拓竹打印盘。
 * - 圆角床面 + 磨砂深灰质感（带 10/50mm 刻度纹理）
 * - 轻量打印体积线框、原点坐标轴、中心标记
 * 原点位于左前角 (0,0,0)，与切片器一致。
 */
import * as THREE from 'three';

const TILE_MM = 50; // 纹理平铺周期（毫米），保证刻度间距不随床尺寸缩放

export function buildPlate(bed) {
  const { width, depth, height } = bed;
  const group = new THREE.Group();
  group.userData.bed = bed;
  group.name = 'plate';

  const corner = Math.min(width, depth) * 0.018; // 圆角半径，随机型略缩放

  // ---- 床面（圆角 + 纹理）----
  // 坐标系：原点位于热床左前角，床面范围 (0,0)..(width,depth)
  const surfaceGeo = new THREE.ShapeGeometry(roundedRect(width, depth, corner));
  // ShapeGeometry 的 UV 是原始坐标（0..w），需归一化后纹理才能按 TILE_MM 正确平铺
  {
    const pos = surfaceGeo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) / width;
      uv[i * 2 + 1] = pos.getY(i) / depth;
    }
    surfaceGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const surfaceMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.04,
    map: makePlateTexture(width, depth),
  });
  const surface = new THREE.Mesh(surfaceGeo, surfaceMat);
  surface.receiveShadow = true;
  surface.position.z = -0.05;
  group.add(surface);

  // ---- 床面外框（圆角描边，接近拓竹冷却盘的亮边）----
  const border = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(roundedRectPoints(width, depth, corner, 0.4)),
    new THREE.LineBasicMaterial({ color: 0x9aa6b8, transparent: true, opacity: 0.85 }),
  );
  border.position.z = 0.02;
  group.add(border);

  // ---- 打印体积线框（淡）----
  const boxGeo = new THREE.BoxGeometry(width, depth, height);
  boxGeo.translate(width / 2, depth / 2, height / 2);
  const volume = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({ color: 0x49505e, transparent: true, opacity: 0.22 }),
  );
  boxGeo.dispose();
  group.add(volume);

  // ---- 原点坐标轴 ----
  const axes = new THREE.AxesHelper(28);
  axes.position.set(0, 0, 0.06);
  axes.material.depthTest = false;
  axes.material.transparent = true;
  axes.material.opacity = 0.9;
  group.add(axes);

  // ---- 中心标记 ----
  const c = new THREE.Mesh(
    new THREE.RingGeometry(2.2, 3.0, 24),
    new THREE.MeshBasicMaterial({ color: 0x6c7686, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  c.position.set(width / 2, depth / 2, 0.03);
  group.add(c);

  return group;
}

function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  s.moveTo(r, 0);
  s.lineTo(w - r, 0);
  s.quadraticCurveTo(w, 0, w, r);
  s.lineTo(w, d - r);
  s.quadraticCurveTo(w, d, w - r, d);
  s.lineTo(r, d);
  s.quadraticCurveTo(0, d, 0, d - r);
  s.lineTo(0, r);
  s.quadraticCurveTo(0, 0, r, 0);
  return s;
}

function roundedRectPoints(w, d, r, z) {
  const pts = [];
  const seg = 6;
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * (i / seg);
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z));
    }
  };
  arc(w - r, r, -Math.PI / 2, 0);
  arc(w - r, d - r, 0, Math.PI / 2);
  arc(r, d - r, Math.PI / 2, Math.PI);
  arc(r, r, Math.PI, Math.PI * 1.5);
  return pts;
}

/** 生成拓竹风格磨砂床面纹理：中灰底 + 细噪点 + 10/50mm 格子条纹（按 TILE_MM 平铺，间距恒定）*/
function makePlateTexture(width, depth) {
  const PX = 512; // 每 TILE_MM 像素
  const c = document.createElement('canvas');
  c.width = PX;
  c.height = PX;
  const ctx = c.getContext('2d');

  // 底色：中灰，避免与暗材质相乘后全黑
  ctx.fillStyle = '#434954';
  ctx.fillRect(0, 0, PX, PX);

  // 细微噪点模拟 PEI 磨砂面
  const img = ctx.getImageData(0, 0, PX, PX);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  const mmToPx = PX / TILE_MM;
  const minor = 10; // mm
  // 次刻度（每 10mm，清晰可见的淡灰条纹）
  ctx.strokeStyle = 'rgba(150,162,180,0.38)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = minor; x < TILE_MM; x += minor) {
    const px = Math.round(x * mmToPx) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, PX);
  }
  for (let y = minor; y < TILE_MM; y += minor) {
    const py = Math.round(y * mmToPx) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(PX, py);
  }
  ctx.stroke();

  // 主刻度（每 50mm = 平铺边缘，明显亮条纹）
  ctx.strokeStyle = 'rgba(205,215,232,0.7)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, PX, PX);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, Math.round(width / TILE_MM)), Math.max(1, Math.round(depth / TILE_MM)));
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
