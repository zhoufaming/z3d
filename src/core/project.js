/**
 * 工作区数据模型：把多个 3mf 文档合并成一个可编辑场景。
 *
 * 每个导入的文档保留完整 Archive，导出时以「基底文档」为模板写回，
 * 其余文档只贡献几何与零件配置，从而最大程度保住拓竹私有元数据。
 */
import * as THREE from 'three';
import { flattenObject } from './threemf/reader.js';
import { metaValue, normalizeColor } from './threemf/bambu-config.js';

let uidSeq = 1;
const nextUid = () => `u${uidSeq++}`;

/** 拓竹常见机型热床尺寸 (mm) */
export const PRINTER_PRESETS = [
  { id: 'auto', name: '跟随文件', width: 256, depth: 256, height: 256 },
  { id: 'x1c', name: 'X1 / X1C / P1S (256)', width: 256, depth: 256, height: 256 },
  { id: 'p1p', name: 'P1P (256)', width: 256, depth: 256, height: 250 },
  { id: 'a1', name: 'A1 (256)', width: 256, depth: 256, height: 256 },
  { id: 'a1mini', name: 'A1 mini (180)', width: 180, depth: 180, height: 180 },
  { id: 'h2d', name: 'H2D (350×320)', width: 350, depth: 320, height: 325 },
];

const DEFAULT_FILAMENT_COLORS = [
  '#00AE42', '#FFFFFF', '#000000', '#F72323',
  '#0A2989', '#F5C211', '#8E44AD', '#E67E22',
  '#16A085', '#7F8C8D', '#C0392B', '#2980B9',
  '#27AE60', '#D35400', '#2C3E50', '#BDC3C7',
];

export class ScenePart {
  constructor(init) {
    this.uid = nextUid();
    this.name = init.name || 'part';
    this.geometry = init.geometry;
    this.extruder = init.extruder || 1;
    this.subtype = init.subtype || 'normal_part';
    /** MMU 逐面上色等我们不编辑但必须保留的三角形属性 */
    this.triAttrs = init.triAttrs || null;
    /** 该零件在对象内部的局部矩阵（来自 component transform） */
    this.localMatrix = init.localMatrix || new THREE.Matrix4();
    this.sourceObjectId = init.sourceObjectId;
    this.sourcePath = init.sourcePath || null;
    /** model_settings.config 中对应的 <part> 节点，导出时原样带走其余 metadata */
    this.settingsPart = init.settingsPart || null;
    this.visible = true;

    this.material = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.62,
      metalness: 0.04,
      flatShading: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.copy(this.localMatrix);
    this.mesh.userData.partUid = this.uid;
  }

  get triangleCount() {
    const idx = this.geometry.getIndex();
    return idx ? idx.count / 3 : this.geometry.getAttribute('position').count / 3;
  }

  applyColor(hex) {
    this.material.color.set(hex);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class SceneObject {
  constructor(init) {
    this.uid = nextUid();
    this.docId = init.docId;
    this.name = init.name || 'object';
    this.sourceObjectId = init.sourceObjectId;
    this.printable = init.printable !== false;
    /** 归属的热床 id；非当前热床的对象在视口隐藏 */
    this.plateId = init.plateId ?? 0;
    /** 眼睛图标控制的用户显隐（与热床显隐叠加生效） */
    this.userVisible = init.userVisible !== false;
    /** @type {ScenePart[]} */
    this.parts = [];
    /** model_settings.config 中对应的 <object> 节点 */
    this.settingsObject = init.settingsObject || null;

    this.group = new THREE.Group();
    this.group.userData.objectUid = this.uid;
  }

  addPart(part) {
    this.parts.push(part);
    this.group.add(part.mesh);
  }

  /** 世界包围盒，已应用 group 与 part 的所有变换 */
  computeBox(target = new THREE.Box3()) {
    target.makeEmpty();
    this.group.updateMatrixWorld(true);
    const tmp = new THREE.Box3();
    for (const p of this.parts) {
      if (!p.visible) continue;
      p.geometry.computeBoundingBox();
      tmp.copy(p.geometry.boundingBox).applyMatrix4(p.mesh.matrixWorld);
      target.union(tmp);
    }
    return target;
  }

  get triangleCount() {
    return this.parts.reduce((n, p) => n + p.triangleCount, 0);
  }

  dispose() {
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    this.group.removeFromParent();
  }
}

export class Project {
  constructor() {
    /** @type {Map<string, object>} docId -> doc（含 Archive） */
    this.docs = new Map();
    /** @type {SceneObject[]} */
    this.objects = [];
    /** @type {{index:number,color:string,type:string}[]} */
    this.filaments = [];
    this.bed = { width: 256, depth: 256, height: 256 };
    this.printerPreset = 'auto';
    /** 多热床：每个对象归属一个热床；视口只显示当前热床的对象 */
    this.plates = [{ id: 0, name: '热床 1' }];
    this.activePlate = 0;
    /** 第一个导入的文档作为导出模板 */
    this.baseDocId = null;
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners) fn(type, payload);
  }

  get isEmpty() {
    return this.objects.length === 0;
  }

  ensureFilaments(count) {
    while (this.filaments.length < count) {
      const i = this.filaments.length;
      this.filaments.push({
        index: i + 1,
        color: DEFAULT_FILAMENT_COLORS[i % DEFAULT_FILAMENT_COLORS.length],
        type: 'PLA',
      });
    }
  }

  filamentColor(extruder) {
    const f = this.filaments[extruder - 1];
    return f ? f.color : '#CCCCCC';
  }

  /**
   * 导入一个已解析的 doc，把它的所有 build item 转成场景对象。
   * @returns {SceneObject[]} 新增的对象
   */
  importDoc(doc) {
    const docId = `d${this.docs.size + 1}_${Date.now().toString(36)}`;
    doc.id = docId;
    this.docs.set(docId, doc);
    const firstDoc = !this.baseDocId;
    if (!this.baseDocId) {
      this.baseDocId = docId;
      // 第一个文档决定料槽与热床
      if (doc.projectInfo?.filaments?.length) {
        this.filaments = doc.projectInfo.filaments.map((f) => ({ ...f, color: normalizeColor(f.color) }));
      }
      if (doc.projectInfo?.bed && this.printerPreset === 'auto') {
        this.bed = { ...doc.projectInfo.bed };
      }
    }
    this.ensureFilaments(Math.max(4, this.filaments.length));

    const settingsObjects = doc.settings?.objects || [];
    const settingsPlates = doc.settings?.plates || [];
    const settingsById = new Map();
    for (const o of settingsObjects) settingsById.set(String(o.id), o);

    // 多盘映射：Bambu Studio 把盘信息放在 Metadata/model_settings.config 的 <plate> 里，
    // 每个 <model_instance object_id="N"> 的 object_id 直接对应 3dmodel.model 的 build item objectid
    const sourceToPlate = new Map();
    for (const plate of settingsPlates) {
      const plateId = Number(metaValue(plate.metadata, 'plater_id'));
      if (!Number.isFinite(plateId)) continue;
      for (const inst of plate.instances) {
        const objId = metaValue(inst.metadata, 'object_id');
        if (objId != null) sourceToPlate.set(String(objId), plateId);
      }
    }

    const created = [];
    const items = doc.root.build.length
      ? doc.root.build
      // 没有 build 节点的话，把所有含几何的 object 当作独立摆件
      : [...doc.root.objects.values()]
          .filter((o) => (o.mesh && o.mesh.indices.length) || o.components.length)
          .map((o) => ({ objectid: o.id, transform: null, printable: true }));

    // 首个文档时，根据 p:plate / model_settings.config 的 <plate> 还原多盘结构
    if (firstDoc) {
      const plateNums = new Set();
      for (const it of items) {
        if (Number.isFinite(it.plate)) plateNums.add(it.plate);
        const mapped = sourceToPlate.get(String(it.objectid));
        if (mapped != null) plateNums.add(mapped);
      }
      for (const plate of settingsPlates) {
        const pid = Number(metaValue(plate.metadata, 'plater_id'));
        if (Number.isFinite(pid)) plateNums.add(pid);
      }
      if (plateNums.size > 0) {
        const nums = [...plateNums].sort((a, b) => a - b);
        this.plates = nums.map((n) => ({ id: n, name: `热床 ${n}` }));
        this.activePlate = nums[0];
      }
    }

    for (const item of items) {
      const sourceId = String(item.objectid);
      const settingsObject = settingsById.get(sourceId) || null;
      const rootObj = doc.root.objects.get(sourceId);
      const displayName =
        (settingsObject && metaValue(settingsObject.metadata, 'name')) ||
        rootObj?.name ||
        `${doc.name.replace(/\.3mf$/i, '')}`;

      const sceneObj = new SceneObject({
        docId,
        name: displayName,
        sourceObjectId: item.objectid,
        printable: item.printable,
        settingsObject,
        plateId: Number.isFinite(item.plate)
          ? item.plate
          : (sourceToPlate.get(String(item.objectid)) ?? this.activePlate),
      });

      if (item.transform) {
        sceneObj.group.matrix.fromArray(item.transform);
        sceneObj.group.matrix.decompose(
          sceneObj.group.position,
          sceneObj.group.quaternion,
          sceneObj.group.scale,
        );
      }

      const flat = flattenObject(doc, item.objectid);
      for (const f of flat) {
        const settingsPart =
          settingsObject?.parts.find((p) => String(p.id) === String(f.componentId ?? f.objectId)) || null;
        const extruder =
          Number(settingsPart && metaValue(settingsPart.metadata, 'extruder')) ||
          Number(settingsObject && metaValue(settingsObject.metadata, 'extruder')) ||
          1;

        const geometry = buildGeometry(f.mesh);
        const localMatrix = new THREE.Matrix4();
        if (f.matrix) localMatrix.fromArray(f.matrix);

        const part = new ScenePart({
          name: (settingsPart && metaValue(settingsPart.metadata, 'name')) || `part ${f.objectId}`,
          geometry,
          extruder: Math.max(1, extruder),
          subtype: settingsPart?.subtype || 'normal_part',
          triAttrs: f.mesh.triAttrs,
          localMatrix,
          sourceObjectId: f.objectId,
          sourcePath: f.path,
          settingsPart,
        });
        this.ensureFilaments(part.extruder);
        part.applyColor(this.filamentColor(part.extruder));
        sceneObj.addPart(part);
      }

      if (sceneObj.parts.length === 0) continue;
      this.objects.push(sceneObj);
      created.push(sceneObj);
    }

    this.emit('docImported', { doc, created });
    return created;
  }

  /**
   * 移出场景但**不释放几何**：撤销栈还持有该对象的引用，
   * 而且副本之间共享 geometry，提前 dispose 会导致其它对象一起变空。
   * 真正的释放统一在 clear() 里做。
   */
  removeObject(obj) {
    const i = this.objects.indexOf(obj);
    if (i === -1) return;
    this.objects.splice(i, 1);
    obj.group.removeFromParent();
    this.emit('objectsChanged');
  }

  addObject(obj) {
    if (obj.plateId == null) obj.plateId = this.activePlate;
    this.objects.push(obj);
    this.emit('objectsChanged');
    return obj;
  }

  /** 当前热床上的对象（视口/选择/导出的操作范围） */
  activeObjects() {
    return this.objects.filter((o) => o.plateId === this.activePlate);
  }

  /** 按用户显隐 + 当前热床统一刷新所有对象的 group.visible */
  applyPlateVisibility() {
    for (const o of this.objects) {
      o.group.visible = o.userVisible !== false && o.plateId === this.activePlate;
    }
  }

  clear() {
    const seen = new Set();
    for (const o of this.objects) {
      for (const p of o.parts) {
        p.material.dispose();
        // 几何在副本之间共享，只能释放一次
        if (!seen.has(p.geometry)) {
          seen.add(p.geometry);
          p.geometry.dispose();
        }
      }
      o.group.removeFromParent();
    }
    this.objects.length = 0;
    this.docs.clear();
    this.baseDocId = null;
    this.filaments = [];
    this.emit('objectsChanged');
  }

  refreshColors() {
    for (const o of this.objects) {
      for (const p of o.parts) p.applyColor(this.filamentColor(p.extruder));
    }
  }

  get stats() {
    let tris = 0;
    let parts = 0;
    const list = this.activeObjects();
    for (const o of list) {
      tris += o.triangleCount;
      parts += o.parts.length;
    }
    return { objects: list.length, parts, triangles: tris, docs: this.docs.size };
  }
}

function buildGeometry(mesh) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  if (mesh.indices && mesh.indices.length) {
    const IndexArray = mesh.positions.length / 3 > 65535 ? Uint32Array : Uint16Array;
    geo.setIndex(new THREE.BufferAttribute(
      IndexArray === Uint32Array ? mesh.indices : Uint16Array.from(mesh.indices),
      1,
    ));
  }
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
