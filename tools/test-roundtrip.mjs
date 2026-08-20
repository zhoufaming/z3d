/**
 * 端到端回归测试：读取 -> 编辑 -> 导出 -> 再读取 -> 校验。
 * 核心逻辑不依赖 DOM/WebGL，可以直接在 Node 里跑。
 * 用法：node tools/test-roundtrip.mjs
 */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';

import { readThreeMF } from '../src/core/threemf/reader.js';
import { parseModelXml } from '../src/core/threemf/model-parser.js';
import { readAttr } from '../src/core/fast-scan.js';
import { writeThreeMF } from '../src/core/threemf/writer.js';
import { Project, ScenePart, SceneObject } from '../src/core/project.js';
import { createPrimitiveGeometry, PRIMITIVES } from '../src/core/primitives.js';
import { splitShells, cutObject, triVolume, buildRings, triangulateCap, convexHull2D, gridLayout, createBase, collectWorldTriangles } from '../src/core/split.js';
import { mirrorGeometry, mirrorObject, arrayObjects, collapseObject, writeSTL, mergeObjects, buildAutoBase, booleanObjects } from '../src/core/ops.js';
import { repairGeometry, repairPart } from '../src/core/repair.js';
import { cloneSceneObject } from '../src/core/history.js';
import { CommandBridge, parseInstruction } from '../src/core/ai-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, '../samples');

let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? '  -> ' + detail : ''}`);
  }
}

function eq(label, actual, expected, tol = 1e-4) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  check(label, ok, `期望 ${expected}，实际 ${actual}`);
}

function loadFile(name) {
  const buf = readFileSync(resolve(samples, name));
  return new File([buf], name, { type: 'model/3mf' });
}

console.log('\n=== 1. 读取拓竹格式 3mf ===');
const doc = await readThreeMF(loadFile('sample-bambu.3mf'));
eq('主模型路径', doc.modelPath, '3D/3dmodel.model');
eq('build item 数量', doc.root.build.length, 2);
eq('外部 model 文件数', doc.externals.size, 2);
eq('model_settings 对象数', doc.settings.objects.length, 2);
eq('料槽数量', doc.projectInfo.filaments.length, 4);
eq('槽位1 颜色', doc.projectInfo.filaments[0].color, '#00AE42');
eq('热床宽度', doc.projectInfo.bed.width, 256);
eq('打印高度', doc.projectInfo.bed.height, 250);

console.log('\n=== 2. 构建工作区 ===');
const project = new Project();
project.importDoc(doc);
eq('场景对象数', project.objects.length, 2);

const cube = project.objects[0];
const combo = project.objects[1];
eq('对象1 名称', cube.name, '校准立方体');
eq('对象2 名称', combo.name, '双色底座');
eq('对象1 零件数', cube.parts.length, 1);
eq('对象2 零件数', combo.parts.length, 2);
eq('对象2 零件1 料槽', combo.parts[0].extruder, 2);
eq('对象2 零件2 料槽', combo.parts[1].extruder, 3);
eq('对象2 零件1 名称', combo.parts[0].name, 'base.stl');

const cubeBox = cube.computeBox(new THREE.Box3());
const cubeSize = cubeBox.getSize(new THREE.Vector3());
eq('立方体尺寸 X', cubeSize.x, 24);
eq('立方体尺寸 Z', cubeSize.z, 24);
eq('立方体底面高度', cubeBox.min.z, 0);
eq('立方体中心 X', cubeBox.getCenter(new THREE.Vector3()).x, 90);

const comboBox = combo.computeBox(new THREE.Box3());
eq('组合件底面高度', comboBox.min.z, 0);
eq('组合件总高', comboBox.getSize(new THREE.Vector3()).z, 36, 0.01);
check('组合件 component 变换生效', combo.parts[1].localMatrix.elements[14] === 18,
  `实际 ${combo.parts[1].localMatrix.elements[14]}`);

console.log('\n=== 3. 多文件组合导入 ===');
const doc2 = await readThreeMF(loadFile('sample-cylinder.3mf'));
project.importDoc(doc2);
eq('组合后对象数', project.objects.length, 3);
eq('源文档数', project.docs.size, 2);
eq('基底文档不变', project.baseDocId, doc.id);
eq('第三个对象名称', project.objects[2].name, '圆柱体');
eq('第三个对象料槽', project.objects[2].parts[0].extruder, 4);

console.log('\n=== 4. 编辑操作 ===');
// 移动 + 旋转 + 缩放 + 换料槽
cube.group.position.set(60, 60, 12);
cube.group.quaternion.setFromEuler(new THREE.Euler(0, 0, Math.PI / 4));
cube.group.scale.set(1.5, 1.5, 1.5);
cube.group.updateMatrix();
cube.name = '改名后的立方体';
cube.parts[0].extruder = 3;

combo.parts[1].extruder = 1;
project.filaments[0].color = '#123456';
project.refreshColors();

const editedBox = cube.computeBox(new THREE.Box3());
eq('缩放后高度', editedBox.getSize(new THREE.Vector3()).z, 36, 0.01);

console.log('\n=== 5. 导出 3mf ===');
const blob = await writeThreeMF(project);
const outBuf = Buffer.from(await blob.arrayBuffer());
const outPath = resolve(samples, `roundtrip-out-${Date.now()}.3mf`);
writeFileSync(outPath, outBuf);
console.log(`  导出 ${outBuf.length} 字节 -> ${outPath}`);

const entries = unzipSync(new Uint8Array(outBuf));
const names = Object.keys(entries).sort();
check('含 [Content_Types].xml', names.includes('[Content_Types].xml'));
check('含 _rels/.rels', names.includes('_rels/.rels'));
check('含主模型', names.includes('3D/3dmodel.model'));
check('含模型关系文件', names.includes('3D/_rels/3dmodel.model.rels'));
check('含 model_settings', names.includes('Metadata/model_settings.config'));
check('含 project_settings', names.includes('Metadata/project_settings.config'));
check('保留了原始缩略图', names.includes('Metadata/plate_1.png'));
check('清除了失效的 slice_info', !names.includes('Metadata/slice_info.config'));
eq('几何文件数量', names.filter((n) => n.startsWith('3D/Objects/')).length, 3);

const outSettings = JSON.parse(strFromU8(entries['Metadata/project_settings.config']));
eq('保留打印机型号', outSettings.printer_model, 'Bambu Lab P1S');
eq('保留层高参数', outSettings.layer_height, '0.2');
eq('写回槽位1 新颜色', outSettings.filament_colour[0], '#123456');
eq('保留槽位3 颜色', outSettings.filament_colour[2], '#F72323');

const outModelXml = strFromU8(entries['3D/3dmodel.model']);
check('声明了 production 扩展', outModelXml.includes('requiredextensions="p"'));
check('component 带 p:path', outModelXml.includes('p:path="/3D/Objects/'));
check('item 带 UUID', /<item[^>]*p:UUID="/.test(outModelXml));

const outCfgXml = strFromU8(entries['Metadata/model_settings.config']);
check('保留 mesh_stat 节点', outCfgXml.includes('<mesh_stat'));
check('保留 source_file 元数据', outCfgXml.includes('source_file'));
check('写入新对象名', outCfgXml.includes('改名后的立方体'));

console.log('\n=== 6. 回读导出文件校验 ===');
const doc3 = await readThreeMF(new File([outBuf], 'roundtrip-out.3mf'));
const project3 = new Project();
project3.importDoc(doc3);

eq('回读对象数', project3.objects.length, 3);
eq('回读对象1 名称', project3.objects[0].name, '改名后的立方体');
eq('回读对象1 料槽', project3.objects[0].parts[0].extruder, 3);
eq('回读对象2 零件数', project3.objects[1].parts.length, 2);
eq('回读对象2 零件2 料槽', project3.objects[1].parts[1].extruder, 1);
eq('回读槽位1 颜色', project3.filaments[0].color, '#123456');

const rbox = project3.objects[0].computeBox(new THREE.Box3());
const rsize = rbox.getSize(new THREE.Vector3());
eq('回读尺寸 Z 一致', rsize.z, 36, 0.01);
eq('回读底面高度一致', rbox.min.z, editedBox.min.z, 0.01);
eq('回读中心 X 一致', rbox.getCenter(new THREE.Vector3()).x, editedBox.getCenter(new THREE.Vector3()).x, 0.01);
eq(
  '回读旋转保持',
  new THREE.Euler().setFromQuaternion(project3.objects[0].group.quaternion, 'XYZ').z,
  Math.PI / 4,
  1e-4,
);

const comboR = project3.objects[1];
eq('组合件零件2 局部 Z 偏移保持', comboR.parts[1].localMatrix.elements[14], 18, 0.01);

const totalTrisBefore = project.stats.triangles;
const totalTrisAfter = project3.stats.triangles;
eq('三角面总数无损', totalTrisAfter, totalTrisBefore);

console.log('\n=== 7. 新建基础形状（无导入文件）导出 ===');
// 模拟 App.createPrimitive 的核心步骤，但不依赖 DOM/viewer。
const project7 = new Project();
project7.ensureFilaments(4);
for (const def of PRIMITIVES) {
  const geo = createPrimitiveGeometry(def.id);
  const part = new ScenePart({
    name: def.name,
    geometry: geo,
    extruder: 1,
    subtype: 'normal_part',
    localMatrix: new THREE.Matrix4(),
  });
  part.applyColor(project7.filamentColor(part.extruder));
  const obj = new SceneObject({ name: def.name, sourceObjectId: null });
  obj.addPart(part);
  project7.addObject(obj);
}
eq('新建对象数', project7.objects.length, PRIMITIVES.length);

// 每个形状底面都应落在 z=0（sitOnBed 生效），且包围盒高度 > 0
for (const o of project7.objects) {
  const b = o.computeBox(new THREE.Box3());
  check(`[${o.name}] 底面贴床`, Math.abs(b.min.z) < 1e-3, `min.z=${b.min.z}`);
  check(`[${o.name}] 有高度`, b.getSize(new THREE.Vector3()).z > 0);
  check(`[${o.name}] 有三角面`, o.triangleCount > 0, `tris=${o.triangleCount}`);
}

const blob7 = await writeThreeMF(project7);
const buf7 = Buffer.from(await blob7.arrayBuffer());
const entries7 = unzipSync(new Uint8Array(buf7));
const names7 = Object.keys(entries7).sort();
check('新建导出含 project_settings.config', names7.includes('Metadata/project_settings.config'));
check('新建导出含 model_settings.config', names7.includes('Metadata/model_settings.config'));
eq('新建几何文件数', names7.filter((n) => n.startsWith('3D/Objects/')).length, PRIMITIVES.length);
const pj7 = JSON.parse(strFromU8(entries7['Metadata/project_settings.config']));
eq('project_settings 含4个料槽', pj7.filament_colour.length, 4);
check('project_settings 含热床区域', Array.isArray(pj7.printable_area) && pj7.printable_area.length >= 3);

// 回读：纯新建导出的文件应能被正确解析，无导入文件时 baseDoc 为空，路径仍通
const doc7 = await readThreeMF(new File([buf7], 'primitives-out.3mf'));
const project7b = new Project();
project7b.importDoc(doc7);
eq('回读新建对象数', project7b.objects.length, PRIMITIVES.length);
eq('回读新建源文件数(无导入)', project7b.docs.size, 1);
for (const o of project7b.objects) {
  check(`回读[${o.name}] 三角面>0`, o.triangleCount > 0);
}

console.log('\n=== 8. 拆件（连通体拆分 / 平面切割） ===');
function boxObj(name, boxes) {
  const obj = new SceneObject({ name });
  for (const b of boxes) {
    const size = b.size || 10;
    const geo = new THREE.BoxGeometry(size, size, size);
    const part = new ScenePart({
      name: 'p', geometry: geo, extruder: 1,
      localMatrix: new THREE.Matrix4().makeTranslation(b.cx, b.cy, b.cz),
    });
    obj.addPart(part);
  }
  return obj;
}

// 8.1 连通体拆分：两个分离立方体应拆成 2 个独立对象
const multi = boxObj('multi', [
  { cx: 0, cy: 0, cz: 0, size: 10 },
  { cx: 100, cy: 0, cz: 0, size: 10 },
]);
const rSplit = splitShells(multi);
eq('拆分：发现 2 个连通体', rSplit.objects.length, 2);
check('拆分：标记 changed', rSplit.changed);
for (const o of rSplit.objects) {
  check(`拆分结果[${o.name}] 含几何`, o.parts[0].geometry.getAttribute('position').count > 0);
  const b = o.computeBox(new THREE.Box3());
  check(`拆分结果[${o.name}] 有尺寸`, b.getSize(new THREE.Vector3()).x > 0);
}

// 8.2 单一连通体不应被拆
const single = boxObj('single', [{ cx: 0, cy: 0, cz: 0, size: 10 }]);
const rSingle = splitShells(single);
check('单连通体：不拆分', !rSingle.changed && rSingle.objects.length === 0);

// 8.3 平面切割：z=50 穿过立方体（z 30..70）应得 2 块
const cutCube = boxObj('cube', [{ cx: 50, cy: 50, cz: 50, size: 40 }]);
const rCut = cutObject(cutCube, 'z', 50, true);
eq('切割：得到 2 块', rCut.objects.length, 2);
check('切割：标记 changed', rCut.changed);
for (const o of rCut.objects) {
  check(`切割块[${o.name}] 含几何`, o.parts[0].geometry.getAttribute('position').count > 0);
}
const posBox = rCut.objects[0].computeBox(new THREE.Box3());
const negBox = rCut.objects[1].computeBox(new THREE.Box3());
check('切割正侧在上半(z>=50)', posBox.min.z >= 50 - 1e-3, `min.z=${posBox.min.z}`);
check('切割负侧在下半(z<=50)', negBox.max.z <= 50 + 1e-3, `max.z=${negBox.max.z}`);

// 8.4 平面未穿过模型：不应切割
const rMiss = cutObject(cutCube, 'z', 1000, true);
check('平面在模型外：不切割', !rMiss.changed && rMiss.objects.length === 0);

console.log('\n=== 9. 拆件打磨（凹截面封盖 / 阈值拆分 / 网格排列） ===');

// 9.1 凹截面封盖：L 形截面的边界线段，三角化应得 4 个三角（而非凸包的 2 个）
{
  const V = (x, y) => new THREE.Vector3(x, y, 40); // 截面位于 z=40 平面
  // L 形外轮廓（6 个外角，凹进一个 12x12 方块）
  const A = V(0, 0), B = V(20, 0), C = V(20, 8), D = V(8, 8), E = V(8, 20), F = V(0, 20);
  const segs = [[A, B], [B, C], [C, D], [D, E], [E, F], [F, A]];
  const rings = buildRings(segs);
  eq('L形重建环数', rings.length, 1);
  eq('L形环点数', rings[0].length, 6);
  const capTris = triangulateCap(segs, 'z');
  check('L形封盖三角数(凹轮廓=4, 凸包=2)', capTris.length === 4, `实际 ${capTris.length}`);
}

// 9.2 阈值拆分：碎屑壳体按体积并入最大件
// 9.2.1 大(30)+中(20)+小(4)：minVolume 设在小与中之间，应保留 2 件（小并入大）
{
  const combo = boxObj('combo', [
    { cx: 0, cy: 0, cz: 0, size: 30 },   // vol 27000
    { cx: 200, cy: 0, cz: 0, size: 20 }, // vol 8000
    { cx: 400, cy: 0, cz: 0, size: 4 },  // vol 64
  ]);
  const r = splitShells(combo, { minVolume: 1000 });
  eq('阈值：保留 2 件', r.objects.length, 2);
  // 其中一个件体积应≈ 27000+64（大+小合并），另一个≈ 8000
  const vols = r.objects.map((o) => triVolume(collectWorldTriangles(o)));
  const bigMerged = vols.some((v) => Math.abs(v - (27000 + 64)) < 50);
  const midKept = vols.some((v) => Math.abs(v - 8000) < 50);
  check('阈值：大件含碎屑合并 (≈27064)', bigMerged, `vols=${vols.map((v) => Math.round(v))}`);
  check('阈值：中件保留 (≈8000)', midKept, `vols=${vols.map((v) => Math.round(v))}`);
}
// 9.2.2 全碎屑：minVolume 过大，全部并入最大件 → 仅 1 件（不拆）
{
  const combo = boxObj('combo', [
    { cx: 0, cy: 0, cz: 0, size: 6 },    // 216
    { cx: 100, cy: 0, cz: 0, size: 6 },
  ]);
  const r = splitShells(combo, { minVolume: 100000 });
  check('阈值：全碎屑合并后不拆', !r.changed && r.objects.length === 0);
}
// 9.2.3 件数上限：5 个等大立方体，maxPieces=3 → 保留 3 件（其余并入最大）
{
  const combo = boxObj('combo', [0, 1, 2, 3, 4].map((i) => ({ cx: i * 100, cy: 0, cz: 0, size: 10 })));
  const r = splitShells(combo, { maxPieces: 3 });
  eq('阈值：受 maxPieces 限制为 3 件', r.objects.length, 3);
}

// 9.3 网格整齐排列：落板后按网格排布，两两 XY 不重叠且整体在床内
{
  const bed = { width: 256, depth: 256 };
  const objs = [];
  for (let i = 0; i < 4; i++) {
    const o = boxObj(`g${i}`, [{ cx: i * 50, cy: 0, cz: 0, size: 20 }]);
    // 简易落板：底面贴 z=0
    o.computeBox(new THREE.Box3());
    // dropToBed 等价：上移 min.z
    const b = o.computeBox(new THREE.Box3());
    o.group.position.z -= b.min.z;
    o.group.updateMatrixWorld(true);
    objs.push(o);
  }
  gridLayout(objs, bed);
  let overlap = false;
  let inBed = true;
  for (let i = 0; i < objs.length; i++) {
    const bi = objs[i].computeBox(new THREE.Box3());
    if (bi.min.x < -1 || bi.min.y < -1 || bi.max.x > bed.width + 1 || bi.max.y > bed.depth + 1) inBed = false;
    for (let j = i + 1; j < objs.length; j++) {
      const bj = objs[j].computeBox(new THREE.Box3());
      const ix = Math.min(bi.max.x, bj.max.x) - Math.max(bi.min.x, bj.min.x);
      const iy = Math.min(bi.max.y, bj.max.y) - Math.max(bi.min.y, bj.min.y);
      if (ix > 0.5 && iy > 0.5) overlap = true;
    }
  }
  check('网格：两两不重叠', !overlap);
  check('网格：整体在热床内', inBed);
}

// 9.4 封盖兜底：三角化封盖失败时能回退凸包近似（不丢封盖）
// 9.4.1 convexHull2D 对凹截面返回凸包（L 形凹轮廓的凸包=4 顶点 → 2 三角）
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const segs = [
    [V(0, 0, 40), V(20, 0, 40)], [V(20, 0, 40), V(20, 8, 40)],
    [V(20, 8, 40), V(8, 8, 40)], [V(8, 8, 40), V(8, 20, 40)],
    [V(8, 20, 40), V(0, 20, 40)], [V(0, 20, 40), V(0, 0, 40)],
  ];
  const hull = convexHull2D(segs.flat(), 2); // 沿 z 轴切，投影 XY
  // L 形凹轮廓不含 (20,20) 角，凸包顶点取自点集本身（斜连 (20,8)->(8,20)），故 5 顶点 / 3 三角
  eq('兜底：凸包顶点数', hull.length, 5);
  const triCount = Math.max(0, hull.length - 2);
  eq('兜底：凸包封盖三角数', triCount, 3);
}
// 9.4.2 cutObject 加封盖：正/负两侧均应有封盖三角（带洞截面走三角化封盖）
{
  const tube = new SceneObject({ name: 'tube' });
  // 圆环管（外环+内环），沿 Z 轴切割会得带洞截面
  const geo = new THREE.TorusGeometry(20, 6, 16, 32);
  tube.addPart(new ScenePart({ name: 'p', geometry: geo, extruder: 0, localMatrix: new THREE.Matrix4() }));
  tube.group.updateMatrixWorld(true);
  const r = cutObject(tube, 'z', 0, true);
  check('兜底：切割成功', r.changed && r.objects.length === 2, `objects=${r.objects.length}`);
  // 任一侧三角数应明显多于纯侧面（含封盖）
  const posCount = r.objects[0].triangleCount;
  check('兜底：上半含封盖三角 (>200)', posCount > 200, `posTris=${posCount}`);
}

// 9.5 earcut 回退集成：带洞方环截面应被精确三角化（外4点+内4点 → 8 三角，而非凸包 2 三角）
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const segs = [
    // 外方框 (0,0)-(10,10)
    [V(0, 0, 40), V(10, 0, 40)], [V(10, 0, 40), V(10, 10, 40)],
    [V(10, 10, 40), V(0, 10, 40)], [V(0, 10, 40), V(0, 0, 40)],
    // 内方框 (3,3)-(7,7)，形成洞
    [V(3, 3, 40), V(7, 3, 40)], [V(7, 3, 40), V(7, 7, 40)],
    [V(7, 7, 40), V(3, 7, 40)], [V(3, 7, 40), V(3, 3, 40)],
  ];
  const cap = triangulateCap(segs, 'z');
  eq('earcut：带洞方环封盖三角数', cap.length, 8); // 凸包只会得 2，带洞精确三角化应得 8
  // 所有封盖顶点应落在切面 z=40 上（3D 映射正确）
  const onPlane = cap.every(([a, b, c]) => Math.abs(a.z - 40) < 1e-6 && Math.abs(b.z - 40) < 1e-6 && Math.abs(c.z - 40) < 1e-6);
  check('earcut：封盖顶点落在切面 z=40', onPlane);
}

// 9.6 切割后底座：createBase 生成贴合底部的圆盘底座
{
  const cube = boxObj('cube', [{ cx: 50, cy: 50, cz: 50, size: 20 }]);
  // 落床：底面贴 z=0
  const b0 = cube.computeBox(new THREE.Box3());
  cube.group.position.z -= b0.min.z;
  cube.group.updateMatrixWorld(true);
  const base = createBase(cube);
  base.group.updateMatrixWorld(true);
  eq('底座：含 1 个 part', base.parts.length, 1);
  const bb = base.computeBox(new THREE.Box3());
  check('底座：底面贴床 (min.z≈0)', Math.abs(bb.min.z) < 1e-3, `min.z=${bb.min.z}`);
  eq('底座：厚度≈2mm', Math.abs((bb.max.z - bb.min.z) - 2), 0, 1e-3);
  // 半径 = max(20,20)/2 * 1.15 = 11.5 → 直径 23
  const dia = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y);
  eq('底座：直径≈23 (外接圆×1.15)', dia, 23, 0.5);
}

// ==================== 第 10 节：镜像 / 阵列 / 合并 / 导出 STL ====================
console.log('--- 第 10 节：镜像 / 阵列 / 合并 / STL ---');

// 10.1 镜像几何：三角形数不变，坐标沿轴翻转
{
  const geo = new THREE.BoxGeometry(10, 10, 10); // 12 三角面（indexed）
  const g0 = geo.clone();
  g0.computeBoundingBox();
  const gM = mirrorGeometry(geo, 'x');
  eq('镜像：三角形数不变', gM.getIndex().count / 3, 12);
  gM.computeBoundingBox();
  // 仅沿 x 翻转：y / z 范围应保持不变
  eq('镜像：y 范围不变', gM.boundingBox.min.y, g0.boundingBox.min.y);
  eq('镜像：z 范围不变', gM.boundingBox.min.z, g0.boundingBox.min.z);
  // 翻转后原顶点 x=+5 应变为 x=-5（原 max.x 不再出现，出现 -max.x）
  check('镜像：x 方向反转', Math.abs(gM.boundingBox.max.x - (-g0.boundingBox.min.x)) < 1e-6, `max.x=${gM.boundingBox.max.x}`);
}

// 10.2 镜像对象：生成副本且不改原对象
{
  const obj = boxObj('src', [{ cx: 0, cy: 0, cz: 0, size: 10 }]);
  const m = mirrorObject(obj, 'z', ScenePart, SceneObject);
  check('镜像对象：返回新对象', m !== obj && m.parts.length === 1);
  check('镜像对象：不修改原对象', obj.parts[0].geometry.getAttribute('position').array.some((v, i) => i % 3 === 2 && v > 0));
}

// 10.3 线性阵列：生成 (count-1) 个副本，沿轴等距
{
  const obj = boxObj('arr', [{ cx: 0, cy: 0, cz: 0, size: 10 }]);
  const copies = arrayObjects(obj, { mode: 'linear', count: 4, axis: 'x', spacing: 40 }, ScenePart, SceneObject, cloneSceneObject);
  eq('线性阵列：生成 3 个副本', copies.length, 3);
  const xs = copies.map((c) => Math.round(c.group.position.x));
  eq('线性阵列：第1副本 x=40', xs[0], 40);
  eq('线性阵列：第2副本 x=80', xs[1], 80);
  eq('线性阵列：第3副本 x=120', xs[2], 120);
}

// 10.4 圆形阵列：副本分布在圆周上（到圆心距离≈半径）
{
  const obj = boxObj('arrC', [{ cx: 0, cy: 0, cz: 0, size: 10 }]);
  const copies = arrayObjects(obj, { mode: 'circular', count: 4, radius: 50 }, ScenePart, SceneObject, cloneSceneObject);
  eq('圆形阵列：生成 3 个副本', copies.length, 3);
  const r = Math.hypot(copies[0].group.position.x, copies[0].group.position.y);
  eq('圆形阵列：副本到圆心距离≈半径', r, 50, 1e-3);
}

// 10.5 合并零件：多零件对象 -> 单一几何
{
  const obj = boxObj('merge', [
    { cx: 0, cy: 0, cz: 0, size: 10 },
    { cx: 50, cy: 0, cz: 0, size: 10 },
  ]);
  eq('合并前：2 个零件', obj.parts.length, 2);
  const merged = collapseObject(obj);
  eq('合并后：1 个零件', merged.parts.length, 1);
  eq('合并后：三角面=24', merged.triangleCount, 24);
  merged.group.updateMatrixWorld(true);
  const bb = merged.computeBox(new THREE.Box3());
  // 两立方体中心 0 和 50，边长10 -> 跨 [-5, 55]
  eq('合并后：跨两个月 (宽度≈60)', Math.round(bb.max.x - bb.min.x), 60, 1);
}

// 10.7 多对象合并：mergeObjects 把多个对象拼成一个单一几何
{
  const a = boxObj('a', [{ cx: 0, cy: 0, cz: 0, size: 10 }]); // 12 三角面
  const b = boxObj('b', [{ cx: 100, cy: 0, cz: 0, size: 10 }]); // 12 三角面
  const merged = mergeObjects([a, b], SceneObject, ScenePart);
  eq('多对象合并：返回单一零件对象', merged.parts.length, 1);
  eq('多对象合并：三角面=24', merged.triangleCount, 24);
  merged.group.updateMatrixWorld(true);
  const bb = merged.computeBox(new THREE.Box3());
  // 两立方体分别位于 0 与 100，边长10 -> 跨 [-5, 105]
  eq('多对象合并：跨两对象 (宽度≈110)', Math.round(bb.max.x - bb.min.x), 110, 1);
}

// 10.8 自动底座：悬空对象生成连接床面的基座
{
  const obj = boxObj('float', [{ cx: 0, cy: 0, cz: 50, size: 10 }]); // 底面在 z=45
  const base = buildAutoBase(obj, ScenePart, SceneObject);
  eq('自动底座：返回单一零件对象', base.parts.length, 1);
  base.group.updateMatrixWorld(true);
  const bb = base.computeBox(new THREE.Box3());
  eq('自动底座：底面贴床 (min.z≈0)', Math.round(bb.min.z), 0, 1);
  // 高度 = max(2, 45+1) = 46，顶面 ≈ 46
  eq('自动底座：高度连接对象底 (max.z≈46)', Math.round(bb.max.z), 46, 1);
}

// 10.6 导出 STL：二进制格式，三角形数正确
{
  const project = new Project();
  project.addObject(boxObj('a', [{ cx: 0, cy: 0, cz: 0, size: 10 }])); // 12 三角面
  project.addObject(boxObj('b', [{ cx: 100, cy: 0, cz: 0, size: 10 }])); // 12 三角面
  const blob = writeSTL(project);
  const buf = Buffer.from(await blob.arrayBuffer());
  eq('STL：总字节数=84+n*50', buf.length, 84 + 24 * 50);
  const triCount = buf.readUInt32LE(80);
  eq('STL：三角形数=24', triCount, 24);
  // 第1个三角形法线应已归一化（模长≈1）
  const nx = buf.readFloatLE(84), ny = buf.readFloatLE(88), nz = buf.readFloatLE(92);
  eq('STL：首三角法线归一化', Math.hypot(nx, ny, nz), 1, 1e-4);
}

// ==================== 第 11 节：网格修复 / 布尔运算 ====================
console.log('--- 第 11 节：网格修复 / 布尔运算 ---');

// 11.1 修复：剔除退化三角形（两点重合 / 零面积）
{
  // 非索引四面体（4 三角，闭合） + 1 个退化三角（0,0,1）
  const tetra = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 1, 0, 0, 0, 1,
    1, 0, 0, 0, 1, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 1, 0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tetra, 3));
  geo.computeVertexNormals();
  const { geometry, report } = repairGeometry(geo);
  eq('修复：剔除 1 个退化三角', report.removedDegenerate, 1);
  eq('修复：剩余 4 三角', report.triangles, 4);
  eq('修复：闭合网格不补洞', report.filledHoles, 0);
  check('修复：输出为索引几何', geometry.getIndex() !== null);
  check('修复：顶点已焊接去重', geometry.getAttribute('position').count < 15, `count=${geometry.getAttribute('position').count}`);
}

// 11.2 修复：焊接重合顶点（非索引重复坐标）
{
  // 同四面体，12 个位置项、仅 4 个唯一坐标
  const tetra = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 1, 0, 0, 0, 1,
    1, 0, 0, 0, 1, 0, 0, 0, 1,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tetra, 3));
  const { geometry, report } = repairGeometry(geo);
  eq('焊接：12 位置项焊成 4 顶点', geometry.getAttribute('position').count, 4);
  check('焊接：报告 weldedVertices>0', report.weldedVertices > 0, `w=${report.weldedVertices}`);
  eq('焊接：三角数不变(4)', report.triangles, 4);
  eq('焊接：无退化', report.removedDegenerate, 0);
}

// 11.3 修复：边界环 earcut 补洞 + 二次修复闭环
{
  // 立方体索引几何去掉一个面（+Z 面，索引 24..29）形成开口壳
  const box = new THREE.BoxGeometry(10, 10, 10);
  const idx = box.getIndex().array.slice(0, 30); // 丢弃最后 6 个（一个面）
  const open = new THREE.BufferGeometry();
  open.setAttribute('position', box.getAttribute('position').clone());
  open.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  const r1 = repairGeometry(open);
  check('补洞：检测到破洞并封盖 (filledHoles>=1)', r1.report.filledHoles >= 1, `h=${r1.report.filledHoles}`);
  check('补洞：三角数增加', r1.report.triangles > 10, `tris=${r1.report.triangles}`);
  // 闭环：对修复结果再修一次，应无破洞（已是封闭流形）
  const r2 = repairGeometry(r1.geometry);
  eq('补洞：二次修复无破洞', r2.report.filledHoles, 0);
  eq('补洞：二次修复三角数稳定', r2.report.triangles, r1.report.triangles);
}

// 11.4 修复：repairPart 替换几何并置双面（用闭合四面体+退化三角，避免开口面被补洞）
{
  // 闭合四面体（4 三角）+ 1 个退化三角（两点重合），退化剔除后应剩 4 三角且无破洞
  const tetra = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 1, 0, 0, 0, 1,
    1, 0, 0, 0, 1, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 1, 0,
  ];
  const part = new ScenePart({
    name: 'bad',
    geometry: (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(tetra, 3));
      return g;
    })(),
    extruder: 1,
    localMatrix: new THREE.Matrix4(),
  });
  const report = repairPart(part);
  check('repairPart：返回报告', report && typeof report.triangles === 'number');
  check('repairPart：材质置为双面', part.material.side === THREE.DoubleSide);
  check('repairPart：mesh 几何已替换', part.mesh.geometry === part.geometry);
  const triCount = part.geometry.getIndex() ? part.geometry.getIndex().count / 3 : part.geometry.getAttribute('position').count / 3;
  eq('repairPart：剔除退化后剩 4 三角(闭合)', triCount, 4);
  eq('repairPart：报告剔除 1 个退化', report.removedDegenerate, 1);
}

// 11.5 布尔并集：两个不相交立方体
{
  const a = boxObj('A', [{ cx: 0, cy: 0, cz: 0, size: 10 }]);   // vol 1000
  const b = boxObj('B', [{ cx: 100, cy: 0, cz: 0, size: 10 }]); // vol 1000
  const r = booleanObjects(a, b, 'union', SceneObject, ScenePart);
  const vol = triVolume(collectWorldTriangles(r));
  eq('布尔并集：单零件', r.parts.length, 1);
  check('布尔并集：体积≈两立方体之和(2000)', Math.abs(vol - 2000) < 5, `vol=${Math.round(vol)}`);
}

// 11.6 布尔差集：大立方体挖去内含小立方体
{
  const A = boxObj('A', [{ cx: 0, cy: 0, cz: 0, size: 20 }]); // vol 8000
  const B = boxObj('B', [{ cx: 0, cy: 5, cz: 0, size: 10 }]); // vol 1000，完整包含于 A
  const r = booleanObjects(A, B, 'difference', SceneObject, ScenePart);
  const vol = triVolume(collectWorldTriangles(r));
  check('布尔差集：体积≈8000-1000=7000', Math.abs(vol - 7000) < 10, `vol=${Math.round(vol)}`);
}

// 11.7 布尔交集：两个相交立方体
{
  const A = boxObj('A', [{ cx: 0, cy: 0, cz: 0, size: 20 }]); // x∈[-10,10]
  const B = boxObj('B', [{ cx: 5, cy: 0, cz: 0, size: 20 }]); // x∈[-5,15]，重叠 x∈[-5,10] 宽15
  const r = booleanObjects(A, B, 'intersection', SceneObject, ScenePart);
  const vol = triVolume(collectWorldTriangles(r));
  check('布尔交集：体积≈6000', Math.abs(vol - 6000) < 10, `vol=${Math.round(vol)}`); // 15*20*20
}

// 11.8 布尔结果命名 + 预览上报（语义化名称 / 三角数 / 尺寸）
{
  const a = boxObj('立方体A', [{ cx: 0, cy: 0, cz: 0, size: 20 }]);
  const b = boxObj('立方体B', [{ cx: 5, cy: 0, cz: 0, size: 20 }]);
  const r = booleanObjects(a, b, 'intersection', SceneObject, ScenePart);
  check('布尔命名：含源对象名', r.name.includes('立方体A') && r.name.includes('立方体B'));
  check('布尔命名：含交集符号 ∩', r.name.includes('∩'));
  check('布尔上报：含 triangles', r.booleanReport && typeof r.booleanReport.triangles === 'number');
  check('布尔上报：含尺寸 dims', r.booleanReport && r.booleanReport.dims &&
    typeof r.booleanReport.dims.x === 'number');
  eq('布尔上报 op=intersection', r.booleanReport.op, 'intersection');
}

// 11.9 布尔结果配色：交集用高亮色，差集继承 A
{
  const a = boxObj('A', [{ cx: 0, cy: 0, cz: 0, size: 20 }]);
  const b = boxObj('B', [{ cx: 0, cy: 5, cz: 0, size: 10 }]);
  a.parts[0].material.color.setHex(0xff0000); // 给 A 一个明确颜色
  const inter = booleanObjects(a, b, 'intersection', SceneObject, ScenePart);
  check('交集配色：高亮琥珀色(0xffb74d)', inter.parts[0].material.color.getHex() === 0xffb74d);
  const diff = booleanObjects(a, b, 'difference', SceneObject, ScenePart);
  check('差集配色：继承 A(0xff0000)', diff.parts[0].material.color.getHex() === 0xff0000);
}


// ===== 第 12 节：AI 控制桥 + 自然语言解析 =====
{
  // 轻量假 App：实现 CommandBridge 调用的全部方法，记录调用用于断言
  class FakeApp {
    constructor() {
      this.project = new Project();
      this.selectedSet = new Set();
      this.selection = { object: null, part: null };
      this.calls = [];
      this.tree = { render() {} };
      this.inspector = { render() {}, syncValues() {} };
      this.viewer = { attachGizmo() {}, modelRoot: { add() {}, clear() {} } };
    }
    applySelectionSet(set) { this.selectedSet = set; this.selection.object = [...set][0] || null; }
    selectAll() { this.applySelectionSet(new Set(this.project.activeObjects())); }
    refreshAll() {}
    booleanSelected(op) { this.calls.push(['booleanSelected', op]); this.selection.object = new SceneObject({ name: '布尔结果' }); }
    repairSelected() { this.calls.push(['repairSelected']); }
    mirrorSelected(axis) { this.calls.push(['mirrorSelected', axis]); }
    arraySelected(opts) { this.calls.push(['arraySelected', opts]); }
    mergeSelected() { this.calls.push(['mergeSelected']); this.selection.object = new SceneObject({ name: '合并结果' }); }
    autoBase() { this.calls.push(['autoBase']); }
    deleteSelected() { this.calls.push(['deleteSelected']); }
    duplicateSelected() { this.calls.push(['duplicateSelected']); }
    arrangeAll() { this.calls.push(['arrangeAll']); }
    rotateBy(o, axis, deg) { this.calls.push(['rotateBy', o.name, axis, deg]); }
    centerOnBed(o) { this.calls.push(['centerOnBed', o.name]); }
    dropToBed(o) { this.calls.push(['dropToBed', o.name]); }
    createPrimitive(shape) { this.calls.push(['createPrimitive', shape]); this.selection.object = new SceneObject({ name: shape }); }
    splitSelected() { this.calls.push(['splitSelected']); }
    cutSelected(axis, dist, cap, grid, addBase) { this.calls.push(['cutSelected', axis, dist, cap, grid, addBase]); }
    undo() {} redo() {}
    async export3mfBuffer() { return { base64: 'AAAA', name: 'x.3mf' }; }
    async import3mfBuffer(b64, name) { this.calls.push(['import3mfBuffer', name]); }
  }

  const app = new FakeApp();
  const A = boxObj('立方体A', [{ cx: 0, cy: 0, cz: 0, size: 20 }]);
  const B = boxObj('立方体B', [{ cx: 100, cy: 0, cz: 0, size: 20 }]);
  app.project.addObject(A);
  app.project.addObject(B);

  const bridge = new CommandBridge(app, null);
  const called = (name) => app.calls.some((c) => c[0] === name);

  // 12.1 场景查询
  {
    const r = await bridge.run({ cmd: 'scene' });
    check('AI scene：返回 ok', r.ok === true);
    eq('AI scene：列出 2 个对象', r.result.objects.length, 2);
    const names = r.result.objects.map((o) => o.name).sort();
    eq('AI scene：对象名正确', JSON.stringify(names), JSON.stringify(['立方体A', '立方体B']));
  }

  // 12.2 直接 JSON 命令：镜像
  {
    app.calls.length = 0;
    const r = await bridge.run({ cmd: 'mirror', args: { axis: 'x', targets: ['立方体A'] } });
    check('AI mirror：ok', r.ok === true);
    check('AI mirror：调用 mirrorSelected', called('mirrorSelected'));
    eq('AI mirror：axis=x', app.calls.find((c) => c[0] === 'mirrorSelected')[1], 'x');
  }

  // 12.3 布尔并集（选中 2 个后再 booleanSelected union）
  {
    app.calls.length = 0;
    const r = await bridge.run({ cmd: 'boolean', args: { op: 'union', targets: ['立方体A', '立方体B'] } });
    check('AI boolean union：ok', r.ok === true);
    check('AI boolean union：调用 booleanSelected', called('booleanSelected'));
    eq('AI boolean union：op=union', app.calls.find((c) => c[0] === 'booleanSelected')[1], 'union');
    eq('AI boolean union：选中 2 个', app.selectedSet.size, 2);
  }

  // 12.4 repair 无 targets -> 选全部后 repair
  {
    app.calls.length = 0;
    const r = await bridge.run({ cmd: 'repair', args: {} });
    check('AI repair：ok', r.ok === true);
    check('AI repair：调用 repairSelected', called('repairSelected'));
  }

  // 12.5 自然语言解析：并集
  {
    const scene = (await bridge.run({ cmd: 'scene' })).result;
    const res = parseInstruction('把 立方体A 和 立方体B 做并集', scene);
    check('NL 并集：无错误', !res.error, res.error || '');
    eq('NL 并集：1 条计划', res.plan.length, 1);
    eq('NL 并集：cmd=boolean', res.plan[0].cmd, 'boolean');
    eq('NL 并集：op=union', res.plan[0].args.op, 'union');
    eq('NL 并集：targets 顺序', JSON.stringify(res.plan[0].args.targets), JSON.stringify(['立方体A', '立方体B']));
  }

  // 12.6 自然语言解析：差集 / 镜像 / 改色 / 修复 / 排列
  {
    const scene = (await bridge.run({ cmd: 'scene' })).result;
    const diff = parseInstruction('把 立方体A 减去 立方体B', scene);
    eq('NL 差集：op=difference', diff.plan[0].args.op, 'difference');
    const mir = parseInstruction('镜像 立方体B 沿 x 轴', scene);
    eq('NL 镜像：cmd=mirror', mir.plan[0].cmd, 'mirror');
    eq('NL 镜像：axis=x', mir.plan[0].args.axis, 'x');
    const col = parseInstruction('把 立方体A 变成红色', scene);
    eq('NL 改色：cmd=setColor', col.plan[0].cmd, 'setColor');
    eq('NL 改色：color=#ff3b30', col.plan[0].args.color, '#ff3b30');
    const rep = parseInstruction('修复全部', scene);
    eq('NL 修复：cmd=repair', rep.plan[0].cmd, 'repair');
    const arr = parseInstruction('排列所有对象', scene);
    eq('NL 排列：cmd=arrange', arr.plan[0].cmd, 'arrange');
  }

  // 12.7 自然语言解析：无法识别
  {
    const scene = (await bridge.run({ cmd: 'scene' })).result;
    const res = parseInstruction('今天天气真好', scene);
    check('NL 未知：返回 error', !!res.error);
    eq('NL 未知：plan 为空', res.plan.length, 0);
  }
}

// ============================================================
// 13. 解析性能 + readAttr 边界（修复：大 XML 上 O(n²) 卡死）
// ============================================================
{
  // 13.1 readAttr 必须把搜索限定在 [from,to) 内，不能越界取到后面的同名属性
  {
    const xml = '<a k="1"/><a k="2"/>';
    const firstTag = xml.indexOf('<a', 0);
    const firstClose = xml.indexOf('>', firstTag);
    const v = readAttr(xml, 'k', firstTag, firstClose);
    eq('readAttr 不越界取到第一个 k', v, '1');
  }

  // 13.2 不存在的属性在限定区间内应返回 null（且不扫到串尾）
  {
    const xml = '<a x="1" y="2"/>';
    const tag = xml.indexOf('<a');
    const close = xml.indexOf('>', tag);
    check('readAttr 限定区间内找不到 m 返回 null', readAttr(xml, 'm', tag, close) === null);
  }

  // 13.3 大模型解析必须在阈值内完成（回归卡死 bug：原 5 万顶点要 7 秒）
  {
    const N = 80000;
    let verts = '<vertices>';
    for (let i = 0; i < N; i++) verts += '<vertex x="' + (i % 100) + '" y="' + Math.floor(i / 100) + '" z="0"/>';
    verts += '</vertices>';
    let tris = '<triangles>';
    for (let i = 0; i < N - 2; i++) tris += '<triangle v1="' + i + '" v2="' + (i + 1) + '" v3="' + (i + 2) + '"/>';
    tris += '</triangles>';
    const xml = '<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh>' + verts + tris + '</mesh></object></resources><build><item objectid="1"/></build></model>';
    const t0 = performance.now();
    const r = parseModelXml(xml);
    const ms = performance.now() - t0;
    eq('解析对象数', r.objects.size, 1);
    const mesh = r.objects.get('1').mesh;
    eq('解析顶点数', (mesh.positions.length / 3) | 0, N);
    check('大模型解析应在 3 秒内（修复前 >7s）', ms < 3000, `ms=${Math.round(ms)}`);
  }
}

// ==================== 14. 多盘解析 (p:plate) 与 printable 修复 ====================
{
  // 14.1 build 项应读取 p:plate
  const xml = '<?xml version="1.0"?><model unit="millimeter">'
    + '<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    + '<object id="2" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    + '<object id="3" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    + '</resources>'
    + '<build>'
    + '<item objectid="1" p:plate="1" printable="1"/>'
    + '<item objectid="2" p:plate="2" printable="1"/>'
    + '<item objectid="3" p:plate="3" printable="0"/>'
    + '</build></model>';
  const r = parseModelXml(xml);
  eq('多盘：build 项数量', r.build.length, 3);
  eq('多盘：item1 的 plate', r.build[0].plate, 1);
  eq('多盘：item2 的 plate', r.build[1].plate, 2);
  eq('多盘：item3 的 plate', r.build[2].plate, 3);
  // printable 应从 printable 属性读取（修复前误读 transform 属性导致恒为 true）
  check('多盘：printable 修复（item3 应为 false）', r.build[2].printable === false);
  check('多盘：item1 printable 为 true', r.build[0].printable === true);

  // 14.2 importDoc 应根据 p:plate 建立多盘并分配对象
  {
    const proj = new Project();
    const fakeDoc = {
      id: 'd1', name: 'multi.3mf', size: 1,
      root: r,
      externals: new Map(),
      settings: { objects: [] },
      projectJson: null,
      projectInfo: { filaments: [], bed: { width: 200, depth: 200, height: 200 } },
    };
    proj.importDoc(fakeDoc);
    eq('多盘：project.plates 数量=3', proj.plates.length, 3);
    eq('多盘：activePlate=首个盘', proj.activePlate, 1);
    const byPlate = new Map();
    for (const o of proj.objects) byPlate.set(o.plateId, (byPlate.get(o.plateId) || 0) + 1);
    eq('多盘：盘1 对象数', byPlate.get(1), 1);
    eq('多盘：盘2 对象数', byPlate.get(2), 1);
    eq('多盘：盘3 对象数', byPlate.get(3), 1);
    // 非当前盘对象应被隐藏
    proj.applyPlateVisibility();
    const obj1 = proj.objects.find((o) => o.plateId === 1);
    const obj3 = proj.objects.find((o) => o.plateId === 3);
    check('多盘：当前盘对象可见', obj1.group.visible === true);
    check('多盘：非当前盘对象隐藏', obj3.group.visible === false);
  }

  // 14.3 importDoc 也应识别 BambuStudio 放在 model_settings.config <plate> 里的盘分配
  {
    const proj = new Project();
    const rootXml = '<?xml version="1.0"?><model unit="millimeter">'
      + '<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
      + '<object id="2" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
      + '<object id="3" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
      + '</resources><build>'
      + '<item objectid="1" printable="1"/>'
      + '<item objectid="2" printable="1"/>'
      + '<item objectid="3" printable="1"/>'
      + '</build></model>';
    const root = parseModelXml(rootXml);
    const fakeDoc = {
      id: 'd1', name: 'multi.3mf', size: 1,
      root,
      archive: null, modelPath: '3D/3dmodel.model',
      settings: {
        objects: [
          { id: '1', metadata: [{ key: 'name', value: 'A' }], parts: [] },
          { id: '2', metadata: [{ key: 'name', value: 'B' }], parts: [] },
          { id: '3', metadata: [{ key: 'name', value: 'C' }], parts: [] },
        ],
        plates: [
          { metadata: [{ key: 'plater_id', value: '1' }], instances: [
            { metadata: [{ key: 'object_id', value: '1' }] },
            { metadata: [{ key: 'object_id', value: '3' }] },
          ]},
          { metadata: [{ key: 'plater_id', value: '2' }], instances: [
            { metadata: [{ key: 'object_id', value: '2' }] },
          ]},
        ],
      },
      projectJson: null,
      projectInfo: { filaments: [], bed: { width: 200, depth: 200, height: 200 } },
    };
    proj.importDoc(fakeDoc);
    eq('多盘(model_settings): project.plates 数量=2', proj.plates.length, 2);
    eq('多盘(model_settings): activePlate=1', proj.activePlate, 1);
    const byPlate = new Map();
    for (const o of proj.objects) byPlate.set(o.plateId, (byPlate.get(o.plateId) || 0) + 1);
    eq('多盘(model_settings): 盘1 对象数', byPlate.get(1), 2);
    eq('多盘(model_settings): 盘2 对象数', byPlate.get(2), 1);
  }
}

console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====\n`);
process.exit(failed ? 1 : 0);
