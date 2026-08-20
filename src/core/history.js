/**
 * 撤销 / 重做。
 *
 * 采用全量状态快照而非命令模式：一个工作区通常只有几十个对象，
 * 快照里只存变换、名称和料槽这些轻量字段（几何一律共享引用），
 * 单次快照开销可以忽略，换来的是实现简单、绝不会出现状态漂移。
 */
import * as THREE from 'three';

export class History {
  constructor(app, limit = 60) {
    this.app = app;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  capture() {
    const project = this.app.project;
    return {
      objects: project.objects.slice(),
      states: project.objects.map((o) => ({
        obj: o,
        position: o.group.position.clone(),
        quaternion: o.group.quaternion.clone(),
        scale: o.group.scale.clone(),
        visible: o.group.visible,
        name: o.name,
        printable: o.printable,
        extruders: o.parts.map((p) => p.extruder),
        // 修复等操作会原地替换 part.geometry，撤销时需要回滚到旧几何引用
        geometries: o.parts.map((p) => p.geometry),
      })),
      filaments: project.filaments.map((f) => ({ ...f })),
      plates: project.plates.map((p) => ({ ...p })),
      activePlate: project.activePlate,
      bed: { ...project.bed },
      printerPreset: project.printerPreset,
      selection: this.app.selection.object,
    };
  }

  /** 收集当前场景 + 所有快照仍引用的几何（含 states 里保存的旧几何），用于丢弃旧快照时判断可否释放 */
  _aliveGeometries() {
    const set = new Set();
    const addObj = (o) => {
      for (const p of o.parts) set.add(p.geometry);
    };
    const addSnap = (snap) => {
      for (const o of snap.objects) addObj(o);
      for (const s of snap.states) for (const g of s.geometries) set.add(g);
    };
    for (const o of this.app.project.objects) addObj(o);
    for (const snap of this.undoStack) addSnap(snap);
    for (const snap of this.redoStack) addSnap(snap);
    return set;
  }

  /** 丢弃一个快照时，释放其中不再被任何场景/快照引用的几何与材质，避免 GPU 内存泄漏 */
  _disposeDropped(dropped) {
    const alive = this._aliveGeometries();
    // 材质按「对象存活」判定：对象可能共享几何但材质独立，对象死了材质就该释放
    const aliveObjects = new Set();
    for (const o of this.app.project.objects) aliveObjects.add(o);
    for (const snap of this.undoStack) for (const o of snap.objects) aliveObjects.add(o);
    for (const snap of this.redoStack) for (const o of snap.objects) aliveObjects.add(o);

    const disposeIfDead = (g) => {
      if (g && !alive.has(g)) g.dispose();
    };
    for (const o of dropped.objects) {
      const objAlive = aliveObjects.has(o);
      for (const p of o.parts) {
        disposeIfDead(p.geometry);
        if (!objAlive && p.material) p.material.dispose();
      }
    }
    for (const s of dropped.states) for (const g of s.geometries) disposeIfDead(g);
  }

  /** 在执行会改变状态的操作 **之前** 调用 */
  push() {
    this.undoStack.push(this.capture());
    if (this.undoStack.length > this.limit) {
      const dropped = this.undoStack.shift();
      this._disposeDropped(dropped);
    }
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return false;
    const current = this.capture();
    const snap = this.undoStack.pop();
    this.redoStack.push(current);
    this.restore(snap);
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    const current = this.capture();
    const snap = this.redoStack.pop();
    this.undoStack.push(current);
    this.restore(snap);
    return true;
  }

  restore(snap) {
    const project = this.app.project;
    project.objects = snap.objects.slice();

    for (const s of snap.states) {
      s.obj.group.position.copy(s.position);
      s.obj.group.quaternion.copy(s.quaternion);
      s.obj.group.scale.copy(s.scale);
      s.obj.group.visible = s.visible;
      s.obj.group.updateMatrix();
      s.obj.name = s.name;
      s.obj.printable = s.printable;
      s.obj.parts.forEach((p, i) => {
        if (s.extruders[i] != null) p.extruder = s.extruders[i];
        // 回滚修复操作替换过的几何（几何未变时写回同一引用，无副作用）
        if (s.geometries[i] && p.geometry !== s.geometries[i]) {
          p.geometry = s.geometries[i];
          if (p.mesh) p.mesh.geometry = p.geometry;
        }
        // 「参与打印」的半透明视觉与 printable 状态保持一致
        p.material.opacity = s.obj.printable ? 1 : 0.35;
        p.material.transparent = !s.obj.printable;
      });
    }

    project.filaments = snap.filaments.map((f) => ({ ...f }));
    project.refreshColors();

    // 多热床 / 打印机预设：回写并同步视图
    const bedChanged = !project.bed
      || project.bed.width !== snap.bed.width
      || project.bed.depth !== snap.bed.depth
      || project.bed.height !== snap.bed.height;
    project.plates = snap.plates.map((p) => ({ ...p }));
    project.activePlate = snap.activePlate;
    project.bed = { ...snap.bed };
    project.printerPreset = snap.printerPreset;
    if (bedChanged && this.app.viewer?.setBed) this.app.viewer.setBed(project.bed);
    if (this.app.renderPlates) this.app.renderPlates();

    // 重挂渲染树：删除/复制会改变对象集合
    this.app.viewer.modelRoot.clear();
    for (const o of project.objects) this.app.viewer.modelRoot.add(o.group);

    const stillThere = snap.selection && project.objects.includes(snap.selection);
    this.app.select(stillThere ? snap.selection : null, null);
    this.app.refreshAll();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    // 逐个弹出并释放：被删对象的几何只存在于快照里，直接清空会永久泄漏
    while (this.undoStack.length) this._disposeDropped(this.undoStack.pop());
    while (this.redoStack.length) this._disposeDropped(this.redoStack.pop());
  }
}

/** 深拷贝一个场景对象（几何共享，变换与材质独立） */
export function cloneSceneObject(source, ScenePart, SceneObject) {
  const copy = new SceneObject({
    docId: source.docId,
    name: `${source.name} 副本`,
    sourceObjectId: source.sourceObjectId,
    printable: source.printable,
    settingsObject: source.settingsObject,
    plateId: source.plateId,
  });
  copy.group.position.copy(source.group.position);
  copy.group.quaternion.copy(source.group.quaternion);
  copy.group.scale.copy(source.group.scale);
  copy.group.updateMatrix();

  for (const p of source.parts) {
    const part = new ScenePart({
      name: p.name,
      // 几何是只读的，多个副本共享同一份，避免复制大网格
      geometry: p.geometry,
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
