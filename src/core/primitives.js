/**
 * 新建模型：基础 3D 形状生成器。
 *
 * 生成的几何统一采用「Z-up、底面贴床」约定：
 *  - 我们的场景坐标系与切片器一致（Z 为高方向），所以圆柱/圆锥/棱锥/圆环
 *    默认沿 Y 轴，需要 rotateX(+90°) 把高方向转到 Z；
 *  - 生成后统一把包围盒最低点平移到 z=0，使形状自然坐落在热床上，
 *    之后的 dropToBed/centerOnBed 还能再微调。
 *
 * 顶点数刻意控制在合理范围（几百~一千多），既能看清形状又不浪费性能。
 */
import * as THREE from 'three';

/** 把几何底面平移到 z=0 */
function sitOnBed(geo) {
  geo.computeBoundingBox();
  const minZ = geo.boundingBox.min.z;
  if (minZ !== 0) geo.translate(0, 0, -minZ);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return geo;
}

/** 让「高方向」从 Y 轴转为 Z 轴并贴床（圆柱/圆锥/棱锥/圆环通用） */
function standUp(geo) {
  geo.rotateX(Math.PI / 2);
  return sitOnBed(geo);
}

/** 基础形状清单。build 返回一个新的 BufferGeometry。 */
export const PRIMITIVES = [
  {
    id: 'cube',
    name: '立方体',
    build: () => sitOnBed(new THREE.BoxGeometry(20, 20, 20)),
  },
  {
    id: 'cylinder',
    name: '圆柱体',
    build: () => standUp(new THREE.CylinderGeometry(10, 10, 20, 48)),
  },
  {
    id: 'sphere',
    name: '球体',
    build: () => sitOnBed(new THREE.SphereGeometry(10, 32, 24)),
  },
  {
    id: 'cone',
    name: '圆锥',
    build: () => standUp(new THREE.ConeGeometry(10, 20, 48)),
  },
  {
    id: 'pyramid',
    name: '棱锥',
    // 4 段圆锥即正方锥；底面比圆锥略大，视觉更像「金字塔」
    build: () => standUp(new THREE.ConeGeometry(14, 20, 4)),
  },
  {
    id: 'torus',
    name: '圆环',
    build: () => standUp(new THREE.TorusGeometry(10, 3, 16, 48)),
  },
];

/** 按 id 生成基础形状几何，返回 BufferGeometry（已 sitOnBed）。找不到返回 null。 */
export function createPrimitiveGeometry(id) {
  const def = PRIMITIVES.find((p) => p.id === id);
  if (!def) return null;
  const geo = def.build();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export function primitiveName(id) {
  return PRIMITIVES.find((p) => p.id === id)?.name || id;
}
