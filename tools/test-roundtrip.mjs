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
import { writeThreeMF } from '../src/core/threemf/writer.js';
import { Project, ScenePart, SceneObject } from '../src/core/project.js';
import { createPrimitiveGeometry, PRIMITIVES } from '../src/core/primitives.js';

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
const outPath = resolve(samples, 'roundtrip-out.3mf');
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

console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====\n`);
process.exit(failed ? 1 : 0);
