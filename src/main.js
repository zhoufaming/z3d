import './style.css';
import * as THREE from 'three';
import { Viewer } from './viewer/viewer.js';
import { Project, PRINTER_PRESETS, SceneObject, ScenePart } from './core/project.js';
import { History, cloneSceneObject } from './core/history.js';
import { readThreeMF } from './core/threemf/reader.js';
import { writeThreeMF } from './core/threemf/writer.js';
import { PRIMITIVES, createPrimitiveGeometry, primitiveName } from './core/primitives.js';
import { ObjectTree } from './ui/tree.js';
import { Inspector } from './ui/inspector.js';
import { renderFilaments } from './ui/filaments.js';
import { el, toast, setStatus, setStatusMeta, humanBytes } from './ui/dom.js';

class App {
  constructor() {
    this.project = new Project();
    this.viewer = new Viewer(document.getElementById('canvas3d'));
    this.selection = { object: null, part: null };
    this.history = new History(this);

    this.tree = new ObjectTree(document.getElementById('object-tree'), this);
    this.inspector = new Inspector(document.getElementById('inspector'), this);
    this.filamentHost = document.getElementById('filament-list');

    this._box = new THREE.Box3();
    this._tmp = new THREE.Vector3();

    this.viewer.setBed(this.project.bed);
    this.viewer.onTransformStart = () => this.pushHistory();
    this.viewer.onTransformChange = () => {
      this.inspector.syncValues();
      this.refreshSelectionBox();
    };
    this.viewer.onTransformCommit = () => {
      this.inspector.syncValues();
      this.updateHud();
    };

    this.bindToolbar();
    this.bindViewport();
    this.bindKeyboard();
    this.tree.render();
    this.inspector.render();
    renderFilaments(this.filamentHost, this);
    this.updateHud();
  }

  // ==================== 工具栏 ====================
  bindToolbar() {
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      if (files.length) await this.loadFiles(files, this._appendMode);
    });

    document.getElementById('btn-import').onclick = () => {
      this._appendMode = false;
      fileInput.click();
    };
    document.getElementById('btn-add').onclick = () => {
      this._appendMode = true;
      fileInput.click();
    };
    document.getElementById('btn-export').onclick = () => this.exportProject();
    document.getElementById('btn-delete').onclick = () => this.deleteSelected();
    document.getElementById('btn-duplicate').onclick = () => this.duplicateSelected();
    document.getElementById('btn-arrange').onclick = () => this.arrangeAll();
    document.getElementById('btn-undo').onclick = () => this.undo();
    document.getElementById('btn-redo').onclick = () => this.redo();
    document.getElementById('btn-drop').onclick = () => {
      if (this.selection.object) this.dropToBed(this.selection.object);
    };
    document.getElementById('btn-center').onclick = () => {
      if (this.selection.object) this.centerOnBed(this.selection.object);
    };

    const modeBox = document.getElementById('gizmo-mode');
    modeBox.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      this.setGizmoMode(btn.dataset.mode);
    });

    const sel = document.getElementById('plate-select');
    for (const p of PRINTER_PRESETS) {
      sel.append(el('option', { value: p.id }, p.name));
    }
    sel.value = 'auto';
    sel.onchange = () => {
      this.project.printerPreset = sel.value;
      const preset = PRINTER_PRESETS.find((p) => p.id === sel.value);
      if (sel.value === 'auto') {
        const base = this.project.docs.get(this.project.baseDocId);
        this.project.bed = base?.projectInfo?.bed
          ? { ...base.projectInfo.bed }
          : { width: 256, depth: 256, height: 256 };
      } else {
        this.project.bed = { width: preset.width, depth: preset.depth, height: preset.height };
      }
      this.viewer.setBed(this.project.bed);
      this.inspector.render();
    };

    // ---- 新建模型：弹出基础形状选择面板 ----
    const newBtn = document.getElementById('btn-new');
    const newPanel = document.getElementById('new-shape-panel');
    newPanel.append(...PRIMITIVES.map((p) => {
      const card = el('button', { class: 'shape-card', 'data-shape': p.id, title: `新建${p.name}` });
      card.innerHTML = `${primitivePreview(p.id)}<span>${p.name}</span>`;
      card.onclick = () => {
        this.createPrimitive(p.id);
        newPanel.classList.add('hidden');
      };
      return card;
    }));
    newBtn.onclick = (e) => {
      e.stopPropagation();
      newPanel.classList.toggle('hidden');
    };
    document.addEventListener('click', (e) => {
      if (!newPanel.contains(e.target) && e.target !== newBtn && !newBtn.contains(e.target)) {
        newPanel.classList.add('hidden');
      }
    });
  }

  setGizmoMode(mode) {
    this.viewer.setGizmoMode(mode);
    for (const b of document.querySelectorAll('#gizmo-mode button')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
  }

  // ==================== 视口交互 ====================
  bindViewport() {
    const canvas = this.viewer.canvas;
    const dropzone = document.getElementById('dropzone');
    let downAt = null;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downAt = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      // 相机拖动或 gizmo 拖动结束时不应改变选择
      if (moved > 4 || this.viewer.transform.dragging) return;
      this.pickAt(e.clientX, e.clientY);
    });

    // ---- 拖拽导入 ----
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const type of ['dragenter', 'dragover']) {
      window.addEventListener(type, (e) => {
        stop(e);
        dropzone.classList.remove('hidden');
        dropzone.classList.add('dragover');
      });
    }
    window.addEventListener('dragleave', (e) => {
      stop(e);
      if (e.clientX === 0 && e.clientY === 0) {
        dropzone.classList.remove('dragover');
        if (!this.project.isEmpty) dropzone.classList.add('hidden');
      }
    });
    window.addEventListener('drop', async (e) => {
      stop(e);
      dropzone.classList.remove('dragover');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.3mf$/i.test(f.name));
      if (!files.length) {
        if (!this.project.isEmpty) dropzone.classList.add('hidden');
        toast('请拖入 .3mf 文件', 'err');
        return;
      }
      await this.loadFiles(files, !this.project.isEmpty);
    });
    dropzone.addEventListener('click', () => {
      this._appendMode = !this.project.isEmpty;
      document.getElementById('file-input').click();
    });
  }

  pickAt(x, y) {
    const meshes = [];
    for (const o of this.project.objects) {
      if (!o.group.visible) continue;
      for (const p of o.parts) meshes.push(p.mesh);
    }
    const hit = this.viewer.pick(x, y, meshes);
    if (!hit) {
      this.select(null, null);
      return;
    }
    const partUid = hit.object.userData.partUid;
    for (const o of this.project.objects) {
      const part = o.parts.find((p) => p.uid === partUid);
      if (part) {
        // 单击选对象，已选中该对象时再点则下钻到具体零件
        const drill = this.selection.object === o && o.parts.length > 1;
        this.select(o, drill ? part : null);
        return;
      }
    }
  }

  bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'o') {
          e.preventDefault();
          this._appendMode = false;
          document.getElementById('file-input').click();
        } else if (k === 's') {
          e.preventDefault();
          this.exportProject();
        } else if (k === 'd') {
          e.preventDefault();
          this.duplicateSelected();
        } else if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo();
          else this.undo();
        } else if (k === 'y') {
          e.preventDefault();
          this.redo();
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'w': this.setGizmoMode('translate'); break;
        case 'e': this.setGizmoMode('rotate'); break;
        case 'r': this.setGizmoMode('scale'); break;
        case 'f':
          if (this.selection.object) this.focusObject(this.selection.object);
          else this.viewer.frameAll(this.worldBox());
          break;
        case 'delete':
        case 'backspace':
          this.deleteSelected();
          break;
        case 'escape':
          this.select(null, null);
          break;
      }
    });
  }

  // ==================== 加载 ====================
  async loadFiles(files, append = false) {
    setStatus(`正在解析 ${files.length} 个文件…`, 'busy');
    document.getElementById('dropzone').classList.add('hidden');

    if (append) {
      this.pushHistory();
    } else {
      this.select(null, null);
      this.project.clear();
      this.history.clear();
    }

    let ok = 0;
    const t0 = performance.now();
    for (const file of files) {
      try {
        const doc = await readThreeMF(file);
        const created = this.project.importDoc(doc);
        if (append || ok > 0) this.avoidOverlap(created);
        ok++;
      } catch (err) {
        console.error(err);
        toast(`${file.name} 解析失败：${err.message}`, 'err', 5000);
      }
    }

    if (!ok) {
      setStatus('解析失败', 'error');
      if (this.project.isEmpty) document.getElementById('dropzone').classList.remove('hidden');
      return;
    }

    // 场景内容变了，重建渲染树
    this.viewer.modelRoot.clear();
    for (const o of this.project.objects) this.viewer.modelRoot.add(o.group);

    if (this.project.printerPreset === 'auto') {
      const base = this.project.docs.get(this.project.baseDocId);
      if (base?.projectInfo?.bed) this.project.bed = { ...base.projectInfo.bed };
      this.viewer.setBed(this.project.bed);
    }

    this.tree.render();
    renderFilaments(this.filamentHost, this);
    if (!append) this.viewer.frameAll(this.worldBox());
    this.inspector.render();
    this.updateHud();
    this.updateHistoryButtons();

    const ms = Math.round(performance.now() - t0);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    setStatus(`已载入 ${ok} 个文件`, '');
    toast(`载入完成：${ok} 个文件 · ${humanBytes(bytes)} · ${ms}ms`, 'ok');
  }

  /**
   * 追加导入时避免和已有模型重叠：以热床中心为起点做螺旋搜索，
   * 找到第一个 XY 不碰撞的位置。比让用户手动挪省事得多。
   */
  avoidOverlap(newObjects) {
    const existing = this.project.objects.filter((o) => !newObjects.includes(o));
    if (!existing.length) return;
    const boxes = existing.map((o) => o.computeBox(new THREE.Box3()));
    for (const obj of newObjects) {
      this.placeWithoutOverlap(obj, boxes);
      boxes.push(obj.computeBox(new THREE.Box3()));
    }
  }

  avoidOverlapAgainst(obj, others) {
    this.placeWithoutOverlap(obj, others.map((o) => o.computeBox(new THREE.Box3())));
  }

  placeWithoutOverlap(obj, boxes) {
    const box = obj.computeBox(new THREE.Box3());
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const step = Math.max(size.x, size.y) + 8;
    const { width, depth } = this.project.bed;

    for (let ring = 0; ring <= 10; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // 只走当前环的外圈，内圈上一轮已经试过了
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const targetX = width / 2 + dx * step;
          const targetY = depth / 2 + dy * step;
          const shift = new THREE.Vector3(targetX - center.x, targetY - center.y, 0);
          const cand = box.clone().translate(shift);
          const inside =
            cand.min.x >= -1 && cand.min.y >= -1 &&
            cand.max.x <= width + 1 && cand.max.y <= depth + 1;
          if (!inside) continue;
          if (boxes.some((b) => intersectsXY(b, cand, 2))) continue;

          obj.group.position.x += shift.x;
          obj.group.position.y += shift.y;
          obj.group.updateMatrix();
          obj.group.updateMatrixWorld(true);
          return true;
        }
      }
    }
    return false;
  }

  // ==================== 选择 ====================
  select(object, part) {
    this.selection = { object, part };
    this.viewer.attachGizmo(object ? object.group : null);
    this.refreshSelectionBox();
    this.tree.render();
    this.inspector.render();
    document.getElementById('btn-delete').disabled = !object;
  }

  refreshSelectionBox() {
    const { object } = this.selection;
    if (!object) {
      this.viewer.showSelectionBox(null);
      return;
    }
    object.computeBox(this._box);
    this.viewer.showSelectionBox(this._box);
  }

  focusObject(object) {
    this.viewer.frameAll(object.computeBox(new THREE.Box3()));
  }

  deleteSelected() {
    const { object } = this.selection;
    if (!object) return;
    const name = object.name;
    this.pushHistory();
    this.select(null, null);
    this.project.removeObject(object);
    this.tree.render();
    this.updateHud();
    toast(`已删除「${name}」，Ctrl+Z 可撤销`, 'info');
    if (this.project.isEmpty) document.getElementById('dropzone').classList.remove('hidden');
  }

  duplicateSelected() {
    const { object } = this.selection;
    if (!object) {
      toast('请先选中一个对象', 'err');
      return;
    }
    this.pushHistory();
    this._historyLock = true;
    try {
      const copy = cloneSceneObject(object, ScenePart, SceneObject);
      this.project.addObject(copy);
      this.viewer.modelRoot.add(copy.group);
      this.avoidOverlap([copy]);
      this.select(copy, null);
    } finally {
      this._historyLock = false;
    }
    this.tree.render();
    this.updateHud();
    toast(`已复制「${object.name}」`, 'ok');
  }

  /** 新建一个基础 3D 形状对象并加入场景 */
  createPrimitive(shapeId) {
    const geo = createPrimitiveGeometry(shapeId);
    if (!geo) {
      toast(`未知形状：${shapeId}`, 'err');
      return;
    }
    if (this.project.isEmpty || this.project.filaments.length === 0) {
      this.project.ensureFilaments(4);
    }

    this.pushHistory();
    this._historyLock = true;
    try {
      const part = new ScenePart({
        name: primitiveName(shapeId),
        geometry: geo,
        extruder: 1,
        subtype: 'normal_part',
        localMatrix: new THREE.Matrix4(),
      });
      part.applyColor(this.project.filamentColor(part.extruder));

      const obj = new SceneObject({ name: primitiveName(shapeId), sourceObjectId: null });
      obj.addPart(part);

      this.project.addObject(obj);
      this.viewer.modelRoot.add(obj.group);
      // 落到热床并居中，形状自带 sitOnBed，这里再对齐到床中心
      this.dropToBed(obj);
      this.centerOnBed(obj);
      this.select(obj, null);
      this.refreshAll();
      toast(`已新建「${primitiveName(shapeId)}」`, 'ok');
    } finally {
      this._historyLock = false;
    }
  }

  /** 把所有对象按包围盒宽度从大到小重新摆到热床上，避免相互重叠 */
  arrangeAll() {
    if (this.project.isEmpty) return;
    this.pushHistory();
    this._historyLock = true;
    try {
      const objects = this.project.objects
        .slice()
        .sort((a, b) => {
          const sa = a.computeBox(new THREE.Box3()).getSize(new THREE.Vector3());
          const sb = b.computeBox(new THREE.Box3()).getSize(new THREE.Vector3());
          return sb.x * sb.y - sa.x * sa.y;
        });

      // 先全部挪到远处，再逐个用避让算法放回来
      for (const o of objects) {
        o.group.position.x += 100000;
        o.group.updateMatrix();
        o.group.updateMatrixWorld(true);
      }
      const placed = [];
      for (const o of objects) {
        o.group.position.x -= 100000;
        o.group.updateMatrix();
        o.group.updateMatrixWorld(true);
        this.centerOnBed(o);
        this.dropToBed(o);
        if (placed.length) this.avoidOverlapAgainst(o, placed);
        placed.push(o);
      }
    } finally {
      this._historyLock = false;
    }
    this.refreshAll();
    toast('已重新排列', 'ok');
  }

  // ==================== 历史 ====================
  pushHistory() {
    if (this._historyLock) return;
    this.history.push();
    this.updateHistoryButtons();
  }

  undo() {
    if (!this.history.undo()) {
      toast('没有可撤销的操作', 'info', 1600);
      return;
    }
    this.updateHistoryButtons();
    toast('已撤销', 'info', 1400);
  }

  redo() {
    if (!this.history.redo()) {
      toast('没有可重做的操作', 'info', 1600);
      return;
    }
    this.updateHistoryButtons();
    toast('已重做', 'info', 1400);
  }

  updateHistoryButtons() {
    document.getElementById('btn-undo').disabled = !this.history.canUndo;
    document.getElementById('btn-redo').disabled = !this.history.canRedo;
  }

  /** 集合变化后统一刷新各面板 */
  refreshAll() {
    this.tree.render();
    this.inspector.render();
    renderFilaments(this.filamentHost, this);
    this.refreshSelectionBox();
    this.updateHud();
    this.updateHistoryButtons();
    this.viewer.requestRender();
    document
      .getElementById('dropzone')
      .classList.toggle('hidden', !this.project.isEmpty);
  }

  // ==================== 变换辅助 ====================
  onObjectTransformed(object) {
    this.refreshSelectionBox();
    this.viewer.requestRender();
    this.updateHud();
  }

  dropToBed(object) {
    this.pushHistory();
    object.computeBox(this._box);
    object.group.position.z -= this._box.min.z;
    object.group.updateMatrix();
    object.group.updateMatrixWorld(true);
    this.onObjectTransformed(object);
    this.inspector.syncValues();
  }

  centerOnBed(object) {
    this.pushHistory();
    object.computeBox(this._box);
    this._box.getCenter(this._tmp);
    object.group.position.x += this.project.bed.width / 2 - this._tmp.x;
    object.group.position.y += this.project.bed.depth / 2 - this._tmp.y;
    object.group.updateMatrix();
    object.group.updateMatrixWorld(true);
    this.onObjectTransformed(object);
    this.inspector.syncValues();
  }

  rotateBy(object, axis, degrees) {
    this.pushHistory();
    this._historyLock = true;
    try {
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0),
        (degrees * Math.PI) / 180,
      );
      object.group.quaternion.premultiply(q);
      object.group.updateMatrix();
      object.group.updateMatrixWorld(true);
      this.dropToBed(object);
    } finally {
      this._historyLock = false;
    }
    this.inspector.render();
  }

  isOutOfBed(object) {
    const b = object.computeBox(new THREE.Box3());
    const { width, depth, height } = this.project.bed;
    return b.min.x < -0.5 || b.min.y < -0.5 || b.min.z < -0.5 ||
      b.max.x > width + 0.5 || b.max.y > depth + 0.5 || b.max.z > height + 0.5;
  }

  worldBox() {
    const box = new THREE.Box3();
    for (const o of this.project.objects) box.union(o.computeBox(new THREE.Box3()));
    return box;
  }

  updateHud() {
    const s = this.project.stats;
    const hud = document.getElementById('hud-stats');
    hud.textContent = s.objects
      ? `${s.objects} 个对象 · ${s.parts} 个零件 · ${s.triangles.toLocaleString('en-US')} 三角面`
      : '';
    setStatusMeta(
      s.objects
        ? `热床 ${this.project.bed.width}×${this.project.bed.depth}×${this.project.bed.height} mm · ${s.docs} 个源文件`
        : '',
    );
  }

  // ==================== 导出 ====================
  async exportProject() {
    if (this.project.isEmpty) {
      toast('没有可导出的模型', 'err');
      return;
    }
    const btn = document.getElementById('btn-export');
    btn.disabled = true;
    setStatus('正在打包 3MF…', 'busy');
    try {
      const t0 = performance.now();
      const blob = await writeThreeMF(this.project);
      const base = this.project.docs.get(this.project.baseDocId);
      const stem = (base?.name || 'project').replace(/\.3mf$/i, '');
      downloadBlob(blob, `${stem}_edited.3mf`);
      const ms = Math.round(performance.now() - t0);
      setStatus('导出完成', '');
      toast(`已导出 ${humanBytes(blob.size)} · ${ms}ms`, 'ok', 3500);
    } catch (err) {
      console.error(err);
      setStatus('导出失败', 'error');
      toast(`导出失败：${err.message}`, 'err', 6000);
    } finally {
      btn.disabled = false;
    }
  }
}

function intersectsXY(a, b, gap = 0) {
  return !(
    a.max.x + gap < b.min.x ||
    a.min.x - gap > b.max.x ||
    a.max.y + gap < b.min.y ||
    a.min.y - gap > b.max.y
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 基础形状的小预览图标（内联 SVG，2D 轮廓） */
function primitivePreview(id) {
  const C = 'currentColor';
  const map = {
    cube: `<svg viewBox="0 0 40 40"><g fill="none" stroke="${C}" stroke-width="1.6" stroke-linejoin="round"><path d="M20 6l11 6v16l-11 6-11-6V12z"/><path d="M20 6v20M9 12l11 6 11-6"/></g></svg>`,
    cylinder: `<svg viewBox="0 0 40 40"><g fill="none" stroke="${C}" stroke-width="1.6"><ellipse cx="20" cy="11" rx="9" ry="3.4"/><path d="M11 11v18M29 11v18"/><ellipse cx="20" cy="29" rx="9" ry="3.4"/></g></svg>`,
    sphere: `<svg viewBox="0 0 40 40"><g fill="none" stroke="${C}" stroke-width="1.6"><circle cx="20" cy="20" r="12"/><path d="M8 20h24M20 8c6 4 6 20 0 24M20 8c-6 4-6 20 0 24"/></g></svg>`,
    cone: `<svg viewBox="0 0 40 40"><g fill="none" stroke="${C}" stroke-width="1.6" stroke-linejoin="round"><path d="M20 8l10 21H10z"/><ellipse cx="20" cy="29" rx="10" ry="3.4"/></g></svg>`,
    pyramid: `<svg viewBox="0 0 40 40"><g fill="none" stroke="${C}" stroke-width="1.6" stroke-linejoin="round"><path d="M20 7l11 22H9z"/><path d="M9 29l11-8 11 8"/></g></svg>`,
    torus: `<svg viewBox="0 0 40 40"><g fill="none" stroke="${C}" stroke-width="1.6"><circle cx="20" cy="20" r="12"/><circle cx="20" cy="20" r="4.5"/></g></svg>`,
  };
  return map[id] || '';
}

window.app = new App();
