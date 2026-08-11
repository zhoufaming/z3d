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
      })),
      filaments: project.filaments.map((f) => ({ ...f })),
      selection: this.app.selection.object,
    };
  }

  /** 在执行会改变状态的操作 **之前** 调用 */
  push() {
    this.undoStack.push(this.capture());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
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
      });
    }

    project.filaments = snap.filaments.map((f) => ({ ...f }));
    project.refreshColors();

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
    this.undoStack.length = 0;
    this.redoStack.length = 0;
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
