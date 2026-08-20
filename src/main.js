import './style.css';
import * as THREE from 'three';
import { Viewer, disposeTree } from './viewer/viewer.js';
import { Project, PRINTER_PRESETS, SceneObject, ScenePart } from './core/project.js';
import { History, cloneSceneObject } from './core/history.js';
import { readThreeMF } from './core/threemf/reader.js';
import { writeThreeMF } from './core/threemf/writer.js';
import { PRIMITIVES, createPrimitiveGeometry, primitiveName } from './core/primitives.js';
import { splitShells, cutObject, gridLayout, createBase } from './core/split.js';
import { mirrorObject, arrayObjects, collapseObject, writeSTL, mergeObjects, buildAutoBase, booleanObjects } from './core/ops.js';
import { repairPart } from './core/repair.js';
import { CommandBridge, parseInstruction, COMMAND_DOCS } from './core/ai-bridge.js';
import {
  loadLLMConfig, saveLLMConfig, callLLM, buildPlanMessages, extractPlanFromResponse,
} from './core/llm.js';
import { PORT_AI, DEFAULT_BED } from './core/constants.js';
import { ObjectTree } from './ui/tree.js';
import { Inspector } from './ui/inspector.js';
import { renderFilaments } from './ui/filaments.js';
import { el, toast, setStatus, setStatusMeta, humanBytes } from './ui/dom.js';

/** 帮助面板里展示的快捷键 / 鼠标操作清单（单一数据源，UI 由它生成） */
const HELP_SECTIONS = [
  { title: '文件', items: [
    { keys: ['Ctrl', 'O'], desc: '导入 3MF' },
    { keys: ['Ctrl', 'S'], desc: '导出 3MF' },
    { keys: ['Ctrl', 'D'], desc: '复制选中对象' },
  ] },
  { title: '撤销 / 重做', items: [
    { keys: ['Ctrl', 'Z'], desc: '撤销' },
    { keys: ['Ctrl', 'Shift', 'Z'], desc: '重做' },
    { keys: ['Ctrl', 'Y'], desc: '重做' },
  ] },
  { title: '变换工具', items: [
    { keys: ['W'], desc: '移动' },
    { keys: ['E'], desc: '旋转' },
    { keys: ['R'], desc: '缩放' },
  ] },
  { title: '视图', items: [
    { keys: ['F'], desc: '聚焦选中对象 / 全部' },
    { keys: ['滚轮'], desc: '缩放' },
    { keys: ['左键拖拽'], desc: '旋转视图' },
    { keys: ['右键拖拽'], desc: '平移视图' },
  ] },
  { title: '选择 / 编辑', items: [
    { keys: ['左键单击'], desc: '选中对象（多零件对象再单击下钻到零件）' },
    { keys: ['左键拖拽'], desc: '在空白处拖拽框选多个对象' },
    { keys: ['Shift', '左键'], desc: '加选 / 减选对象（多选后可一键合并）' },
    { keys: ['Shift', '拖拽'], desc: '框选时叠加到已有选择' },
    { keys: ['Ctrl', 'A'], desc: '全选当前热床对象' },
    { keys: ['右键'], desc: '弹出菜单：复制 / 删除 / 隐藏 / 单独显示 / 合并 / 布尔 / 修复 / 底座' },
    { keys: ['Del'], desc: '删除选中对象（支持多选）' },
    { keys: ['Esc'], desc: '取消选择 / 关闭弹窗与菜单' },
  ] },
  { title: '其它', items: [
    { keys: ['M'], desc: '进入 / 退出测量模式' },
    { keys: ['修复'], desc: '焊接重合顶点 / 封洞 / 剔除退化三角形' },
    { keys: ['剖面'], desc: '按轴 + 位置裁剪，隐藏切割面一侧' },
    { keys: ['布尔'], desc: '选中 2 个对象做并集 / 差集 / 交集' },
    { keys: ['底座'], desc: '为选中对象自动生成底座 / 支撑' },
    { keys: ['多热床'], desc: '左侧标签切换热床，右键可复制对象到其他热床' },
  ] },
];

class App {
  constructor() {
    this.project = new Project();
    this.viewer = new Viewer(document.getElementById('canvas3d'));
    // 窗口卸载（Electron 重载 / 切换）时释放 WebGL 上下文与渲染树，避免泄漏
    window.addEventListener('beforeunload', () => this.viewer?.dispose());
    // 统一「点击面板外部关闭」：所有面板共用一个 document 监听（见 _registerOutsideClick）
    this._outsideClickTargets = [];
    document.addEventListener('click', (e) => {
      for (const t of this._outsideClickTargets) {
        if (!t.panel.contains(e.target) && e.target !== t.btn && !(t.btn && t.btn.contains(e.target))) {
          t.panel.classList.add('hidden');
        }
      }
    });
    this.selection = { object: null, part: null };
    this.selectedSet = new Set(); // 多选集合（含主选择）
    this._clipPlane = null; // 当前剖面裁剪平面（THREE.Plane | null）
    this.history = new History(this);

    this.tree = new ObjectTree(document.getElementById('object-tree'), this);
    this.inspector = new Inspector(document.getElementById('inspector'), this);
    this.filamentHost = document.getElementById('filament-list');

    this._box = new THREE.Box3();
    this._tmp = new THREE.Vector3();

    // 测量工具：以世界坐标保存每一条测量线，浮层标签随相机更新
    this.measureGroup = new THREE.Group();
    this.measureGroup.name = 'measure';
    this.viewer.scene.add(this.measureGroup);
    this.measure = { active: false, pending: null, pendingMarker: null, items: [] };

    this.viewer.setBed(this.project.bed);
    this.viewer.onTransformStart = () => this.pushHistory();
    // 移动（translate）时约束：物体底面不得穿到热床（z<0）以下。
    // 拖动过程中实时拉回，松手（commit）再兜底一次，保证最终状态合规。
    this.viewer.onTransformChange = () => {
      const obj = this.selection.object;
      if (obj && this.viewer.transform.getMode() === 'translate') {
        obj.computeBox(this._box);
        if (this._box.min.z < 0) obj.group.position.z -= this._box.min.z;
      }
      this.inspector.syncValues();
      this.refreshSelectionBoxes();
    };
    this.viewer.onTransformCommit = () => {
      const obj = this.selection.object;
      if (obj && this.viewer.transform.getMode() === 'translate') {
        obj.computeBox(this._box);
        if (this._box.min.z < 0) obj.group.position.z -= this._box.min.z;
      }
      this.inspector.syncValues();
      this.refreshSelectionBoxes();
      this.viewer.markShadowsDirty();
      this.updateHud();
    };

    // 相机变化时同步刷新测量浮层标签位置
    this.viewer.controls.addEventListener('change', () => this.updateMeasureLabels());

    this.bindToolbar();
    this.bindViewport();
    this.bindKeyboard();
    this.bindAIPanel();
    this.tree.render();
    this.inspector.render();
    renderFilaments(this.filamentHost, this);
    this.renderPlates();
    this.updateHud();

    // AI 控制桥（opt-in）：默认不启动控制服务，仅当 UI 开启时才由主进程拉起本地服务。
    // 暴露 window.__bambuBridge 供主进程的控制服务经 executeJavaScript 调用。
    this.bridge = new CommandBridge(this, this._bambuFs());
    window.__bambuBridge = {
      run: (c) => this.bridge.run(c),
      runPlan: (p) => this.bridge.runPlan(p),
    };
    window.app = this;
  }

  /** 主进程经 preload 注入的 window.bambu.invoke；无则返回 null（导出/导入仅返回 base64） */
  _bambuFs() {
    if (typeof window === 'undefined' || !window.bambu || !window.bambu.invoke) return null;
    return {
      writeFile: (path, base64) => window.bambu.invoke('fs:writeFile', { path, base64 }),
      readFile: (path) => window.bambu.invoke('fs:readFile', { path }),
    };
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
    document.getElementById('btn-merge').onclick = () => this.mergeSelected();
    document.getElementById('btn-base').onclick = () => this.autoBase();
    document.getElementById('btn-repair').onclick = () => this.repairSelected();
    document.getElementById('btn-export-stl').onclick = () => this.exportSTL();

    // ---- 剖面 / 裁剪 ----
    const clipBtn = document.getElementById('btn-clip');
    const clipPanel = document.getElementById('clip-panel');
    clipBtn.onclick = (e) => {
      e.stopPropagation();
      clipPanel.classList.toggle('hidden');
    };
    const clipApply = () => {
      const axis = document.getElementById('clip-axis').value;
      const dist = parseFloat(document.getElementById('clip-pos').value) || 0;
      const on = document.getElementById('clip-on').checked;
      this.setClip(axis, dist, on);
    };
    document.getElementById('clip-axis').addEventListener('change', clipApply);
    document.getElementById('clip-pos').addEventListener('input', clipApply);
    document.getElementById('clip-on').addEventListener('change', clipApply);
    this._outsideClickTargets.push({ panel: clipPanel, btn: clipBtn });

    // ---- 布尔运算 ----
    const boolBtn = document.getElementById('btn-boolean');
    const boolPanel = document.getElementById('bool-panel');
    boolBtn.onclick = (e) => {
      e.stopPropagation();
      boolPanel.classList.toggle('hidden');
    };
    for (const b of boolPanel.querySelectorAll('button[data-op]')) {
      b.onclick = () => {
        this.booleanSelected(b.dataset.op);
        boolPanel.classList.add('hidden');
      };
    }
    this._outsideClickTargets.push({ panel: boolPanel, btn: boolBtn });
    document.getElementById('btn-arrange').onclick = () => this.arrangeAll();
    document.getElementById('btn-measure').onclick = () => this.toggleMeasure();
    document.getElementById('btn-clear-measure').onclick = () => this.clearMeasurements();

    // ---- 快捷键 / 帮助面板 ----
    const helpBody = document.getElementById('help-body');
    helpBody.innerHTML = HELP_SECTIONS.map((sec) =>
      `<div class="help-group"><h4>${sec.title}</h4>` +
      sec.items.map((it) =>
        `<div class="help-row"><span class="desc">${it.desc}</span>` +
        `<span class="keys">${it.keys.map((k) => `<span class="kbd">${k}</span>`).join('')}</span></div>`,
      ).join('') +
      `</div>`,
    ).join('');
    document.getElementById('btn-help').onclick = () => this.openHelp();
    document.getElementById('help-close').onclick = () => this.closeHelp();
    document.getElementById('help-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('help-modal')) this.closeHelp();
    });
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
          : { ...DEFAULT_BED };
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
    this._outsideClickTargets.push({ panel: newPanel, btn: newBtn });

    // ---- 镜像：X / Y / Z 轴 ----
    const mirrorBtn = document.getElementById('btn-mirror');
    const mirrorPanel = document.getElementById('mirror-panel');
    mirrorBtn.onclick = (e) => {
      e.stopPropagation();
      mirrorPanel.classList.toggle('hidden');
    };
    for (const b of mirrorPanel.querySelectorAll('button[data-axis]')) {
      b.onclick = () => {
        this.mirrorSelected(b.dataset.axis);
        mirrorPanel.classList.add('hidden');
      };
    }
    this._outsideClickTargets.push({ panel: mirrorPanel, btn: mirrorBtn });

    // ---- 阵列：线性 / 圆形 ----
    const arrayBtn = document.getElementById('btn-array');
    const arrayPanel = document.getElementById('array-panel');
    const arrayLinearOpts = document.getElementById('array-linear-opts');
    const arrayCircularOpts = document.getElementById('array-circular-opts');
    const syncArrayMode = () => {
      const circular = arrayPanel.querySelector('input[name="array-mode"]:checked').value === 'circular';
      arrayLinearOpts.classList.toggle('hidden', circular);
      arrayCircularOpts.classList.toggle('hidden', !circular);
    };
    for (const r of arrayPanel.querySelectorAll('input[name="array-mode"]')) {
      r.addEventListener('change', syncArrayMode);
    }
    arrayBtn.onclick = (e) => {
      e.stopPropagation();
      arrayPanel.classList.toggle('hidden');
    };
    document.getElementById('array-go').onclick = () => {
      const mode = arrayPanel.querySelector('input[name="array-mode"]:checked').value;
      const opts = {
        mode,
        count: Math.max(2, parseInt(document.getElementById('array-count').value, 10) || 2),
        axis: document.getElementById('array-axis').value,
        spacing: parseFloat(document.getElementById('array-spacing').value) || 30,
        radius: parseFloat(document.getElementById('array-radius').value) || 60,
      };
      this.arraySelected(opts);
      arrayPanel.classList.add('hidden');
    };
    this._outsideClickTargets.push({ panel: arrayPanel, btn: arrayBtn });

    // ---- 拆件：拆分 / 切割 ----
    const splitBtn = document.getElementById('btn-split');
    const splitPanel = document.getElementById('split-panel');
    const splitShellsOpts = document.getElementById('split-shells-opts');
    const splitPlaneOpts = document.getElementById('split-plane-opts');
    const splitAxis = document.getElementById('split-axis');
    const splitPos = document.getElementById('split-pos');
    const splitCap = document.getElementById('split-cap');
    const splitGrid = document.getElementById('split-grid');
    const splitBase = document.getElementById('split-base');
    const splitMinvol = document.getElementById('split-minvol');
    const splitMaxpieces = document.getElementById('split-maxpieces');

    const syncSplitPosDefault = () => {
      const obj = this.selection.object;
      if (!obj) return;
      obj.computeBox(this._box);
      const c = this._box.getCenter(new THREE.Vector3());
      const v = splitAxis.value === 'x' ? c.x : splitAxis.value === 'y' ? c.y : c.z;
      splitPos.value = Math.round(v * 10) / 10;
    };

    for (const r of splitPanel.querySelectorAll('input[name="split-mode"]')) {
      r.addEventListener('change', () => {
        const plane = splitPanel.querySelector('input[name="split-mode"]:checked').value === 'plane';
        splitPlaneOpts.classList.toggle('hidden', !plane);
        splitShellsOpts.classList.toggle('hidden', plane);
        if (plane) syncSplitPosDefault();
      });
    }
    splitAxis.addEventListener('change', syncSplitPosDefault);

    splitBtn.onclick = (e) => {
      e.stopPropagation();
      if (splitPanel.classList.contains('hidden')) syncSplitPosDefault();
      splitPanel.classList.toggle('hidden');
    };
    document.getElementById('split-go').onclick = () => {
      const mode = splitPanel.querySelector('input[name="split-mode"]:checked').value;
      const grid = splitGrid.checked;
      const addBase = splitBase.checked;
      if (mode === 'plane') {
        this.cutSelected(splitAxis.value, parseFloat(splitPos.value) || 0, splitCap.checked, grid, addBase);
      } else {
        this.splitSelected(grid, addBase, {
          minVolume: Math.max(0, parseFloat(splitMinvol.value) || 0),
          maxPieces: Math.max(1, parseInt(splitMaxpieces.value, 10) || 999),
        });
      }
      splitPanel.classList.add('hidden');
    };
    this._outsideClickTargets.push({ panel: splitPanel, btn: splitBtn });
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
    const viewport = document.getElementById('viewport');
    let downAt = null;
    let marquee = null; // { x0, y0, shift }

    const rel = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const showMarquee = (x, y, w, h) => {
      let box = document.getElementById('marquee-box');
      if (!box) {
        box = el('div', { id: 'marquee-box', class: 'marquee-box' });
        viewport.appendChild(box);
      }
      box.style.display = '';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
    };
    const hideMarquee = () => {
      const box = document.getElementById('marquee-box');
      if (box) box.style.display = 'none';
    };

    // 捕获阶段先于 OrbitControls 处理左键：
    // - 直接拖拽 → 旋转视图（交给 OrbitControls）
    // - Shift+拖拽空白处 → 矩形框选
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = rel(e);
      downAt = { x: p.x, y: p.y };
      if (this.viewer.transform.axis) return; // 命中 gizmo 手柄 → 交给 TransformControls
      if (!e.shiftKey) return; // 无 Shift → 交给 OrbitControls 旋转
      const meshes = [];
      for (const o of this.project.objects) {
        if (!o.group.visible) continue;
        for (const part of o.parts) meshes.push(part.mesh);
      }
      if (this.viewer.pick(e.clientX, e.clientY, meshes)) return; // Shift+命中模型 → 保持旋转
      this.viewer.controls.enableRotate = false; // Shift+空白处 → 进入框选
      marquee = { x0: p.x, y0: p.y };
      showMarquee(p.x, p.y, 0, 0);
    }, true);

    canvas.addEventListener('pointermove', (e) => {
      if (!marquee) return;
      const p = rel(e);
      showMarquee(
        Math.min(marquee.x0, p.x), Math.min(marquee.y0, p.y),
        Math.abs(p.x - marquee.x0), Math.abs(p.y - marquee.y0),
      );
    });

    const endMarquee = () => {
      hideMarquee();
      this.viewer.controls.enableRotate = true;
      marquee = null;
      downAt = null;
    };

    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !downAt) return;
      const p = rel(e);
      const moved = Math.hypot(p.x - downAt.x, p.y - downAt.y);
      downAt = null;
      if (marquee) {
        const was = marquee;
        const box = {
          left: Math.min(was.x0, p.x), top: Math.min(was.y0, p.y),
          right: Math.max(was.x0, p.x), bottom: Math.max(was.y0, p.y),
        };
        endMarquee();
        // 微小拖拽视为点击空白处
        if (box.right - box.left < 4 && box.bottom - box.top < 4) {
          this.select(null, null);
          return;
        }
        this.marqueeSelect(box, true);
        return;
      }
      // 相机拖动或 gizmo 拖动结束时不应改变选择
      if (moved > 4 || this.viewer.transform.dragging) return;
      // 测量模式下：点击模型表面取点，不触发选择
      if (this.measure.active) {
        this.measurePick(e.clientX, e.clientY);
        return;
      }
      this.pickAt(e.clientX, e.clientY, e.shiftKey);
    });

    // 安全兜底：如果鼠标移出窗口或窗口失焦，取消框选并恢复旋转
    window.addEventListener('pointercancel', endMarquee);
    window.addEventListener('blur', endMarquee);

    // 视口右键菜单
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.measure.active) return;
      const meshes = [];
      for (const o of this.project.activeObjects()) {
        if (!o.group.visible) continue;
        for (const p of o.parts) meshes.push(p.mesh);
      }
      const hit = this.viewer.pick(e.clientX, e.clientY, meshes);
      if (hit) {
        const partUid = hit.object.userData.partUid;
        const obj = this.project.activeObjects().find((o) => o.parts.some((p) => p.uid === partUid));
        if (obj) {
          if (!this.selectedSet.has(obj)) this.select(obj, null);
          this.showContextMenu(e.clientX, e.clientY, this.objectContextItems());
          return;
        }
      }
      this.select(null, null);
      this.showContextMenu(e.clientX, e.clientY, this.emptyContextItems());
    });

    // 左键点击其它处关闭右键菜单（右键 pointerdown 不关，避免刚弹出即被关）
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) this.hideContextMenu();
    });

    // ---- 拖拽导入 ----
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    // 用 enter/leave 计数器判断真正离开窗口（避免子元素间移动误判、避免拖到开发者工具/iframe 时残留遮罩）
    let dragDepth = 0;
    for (const type of ['dragenter', 'dragover']) {
      window.addEventListener(type, (e) => {
        stop(e);
        dragDepth++;
        dropzone.classList.remove('hidden');
        dropzone.classList.add('dragover');
      });
    }
    window.addEventListener('dragleave', (e) => {
      stop(e);
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && e.relatedTarget === null) {
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

  pickAt(x, y, additive = false) {
    const meshes = [];
    for (const o of this.project.activeObjects()) {
      if (!o.group.visible) continue;
      for (const p of o.parts) meshes.push(p.mesh);
    }
    const hit = this.viewer.pick(x, y, meshes);
    if (!hit) {
      if (!additive) this.select(null, null);
      return;
    }
    const partUid = hit.object.userData.partUid;
    for (const o of this.project.objects) {
      const part = o.parts.find((p) => p.uid === partUid);
      if (part) {
        if (additive) {
          this.selectToggle(o);
          return;
        }
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
        } else if (k === 'a') {
          e.preventDefault();
          this.selectAll();
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'w': this.setGizmoMode('translate'); break;
        case 'e': this.setGizmoMode('rotate'); break;
        case 'r': this.setGizmoMode('scale'); break;
        case 'f':
          if (this.selectedSet.size > 1) {
            const box = new THREE.Box3();
            for (const o of this.selectedSet) box.union(o.computeBox(new THREE.Box3()));
            this.viewer.frameAll(box);
          } else if (this.selection.object) {
            this.focusObject(this.selection.object);
          } else {
            this.viewer.frameAll(this.worldBox());
          }
          break;
        case 'delete':
        case 'backspace':
          this.deleteSelected();
          break;
        case 'escape':
          if (!document.getElementById('help-modal').classList.contains('hidden')) {
            this.closeHelp();
          } else if (document.getElementById('ctx-menu').style.display === 'block') {
            this.hideContextMenu();
          } else {
            this.select(null, null);
          }
          break;
        case 'm':
          this.toggleMeasure();
          break;
      }
    });
  }

  // ==================== AI 辅助面板（opt-in 控制桥） ====================
  async bindAIPanel() {
    const toggle = document.getElementById('ai-enable');
    if (!toggle) return; // 面板不存在则不绑定（如旧版 index.html）
    const statusEl = document.getElementById('ai-status');
    const portEl = document.getElementById('ai-port');
    const tokenEl = document.getElementById('ai-token');
    const input = document.getElementById('ai-input');
    const runBtn = document.getElementById('ai-run');
    const logEl = document.getElementById('ai-log');
    const clearBtn = document.getElementById('ai-clear');
    const samples = document.getElementById('ai-samples');
    const panel = document.getElementById('ai-panel');
    const closeBtn = document.getElementById('ai-close');

    // 大模型模式相关元素
    const modeRadios = panel.querySelectorAll('input[name="ai-mode"]');
    const cfgBtn = document.getElementById('ai-llm-cfg-btn');
    const cfgBox = document.getElementById('ai-llm-cfg');
    const cfgUrl = document.getElementById('ai-llm-url');
    const cfgKey = document.getElementById('ai-llm-key');
    const cfgModel = document.getElementById('ai-llm-model');
    const cfgTemp = document.getElementById('ai-llm-temp');
    const cfgSave = document.getElementById('ai-llm-save');
    const cfgTest = document.getElementById('ai-llm-test');
    const thinkEl = document.getElementById('ai-think');

    const log = (line, kind = 'info') => {
      const ts = new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.className = `ai-log-line ai-${kind}`;
      div.textContent = `[${ts}] ${line}`;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    };
    this._aiLog = log;

    // ---- 加载并应用大模型配置（异步，走 SQLite） ----
    const llmConfig = await loadLLMConfig();
    this.llmConfig = llmConfig;
    const applyConfigToUI = () => {
      cfgUrl.value = llmConfig.apiUrl || '';
      cfgKey.value = llmConfig.apiKey || '';
      cfgModel.value = llmConfig.model || '';
      cfgTemp.value = llmConfig.temperature ?? 0.2;
      // 同步模式 radio
      modeRadios.forEach((r) => { r.checked = (r.value === llmConfig.mode); });
      // 大模型模式下显示配置按钮
      cfgBtn.classList.toggle('hidden', llmConfig.mode !== 'llm');
    };
    applyConfigToUI();

    // ---- 模式切换 ----
    modeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        llmConfig.mode = r.value;
        saveLLMConfig(llmConfig);
        cfgBtn.classList.toggle('hidden', r.value !== 'llm');
        if (r.value === 'llm' && !llmConfig.apiUrl) {
          cfgBox.classList.remove('hidden');
          log('未配置大模型 API，请先填写配置', 'info');
        }
        if (r.value === 'local') cfgBox.classList.add('hidden');
        log(`模式切换：${r.value === 'llm' ? '大模型' : '本地解析'}`, 'info');
      });
    });

    // ---- 配置区显示/隐藏 ----
    cfgBtn && cfgBtn.addEventListener('click', () => cfgBox.classList.toggle('hidden'));

    // ---- 保存配置（异步，走 SQLite） ----
    cfgSave && cfgSave.addEventListener('click', async () => {
      llmConfig.apiUrl = cfgUrl.value.trim();
      llmConfig.apiKey = cfgKey.value.trim();
      llmConfig.model = cfgModel.value.trim();
      llmConfig.temperature = Math.max(0, Math.min(2, parseFloat(cfgTemp.value) || 0.2));
      await saveLLMConfig(llmConfig);
      log('大模型配置已保存到本地数据库', 'ok');
      cfgBox.classList.add('hidden');
    });

    // ---- 测试连接 ----
    cfgTest && cfgTest.addEventListener('click', async () => {
      const testCfg = {
        apiUrl: cfgUrl.value.trim(),
        apiKey: cfgKey.value.trim(),
        model: cfgModel.value.trim() || 'deepseek-chat',
        temperature: 0,
        timeoutMs: 20000,
      };
      if (!testCfg.apiUrl) { log('请先填写 API URL', 'err'); return; }
      log('测试连接中…', 'info');
      thinkEl.classList.remove('hidden');
      thinkEl.textContent = '';
      try {
        const full = await callLLM(testCfg, [
          { role: 'system', content: '你是测试助手。只回复一个字：ok' },
          { role: 'user', content: 'ping' },
        ], { onToken: (t) => { thinkEl.textContent += t; thinkEl.scrollTop = thinkEl.scrollHeight; } });
        log(`连接成功，模型返回：${(full || '').slice(0, 60)}`, 'ok');
      } catch (err) {
        log(`连接失败：${err && err.message}`, 'err');
      }
    });

    // 示例指令点击即填入输入框
    if (samples) {
      samples.querySelectorAll('[data-sample]').forEach((b) => {
        b.addEventListener('click', () => { input.value = b.dataset.sample; });
      });
    }

    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        // 生成一个一次性 token，外部 AI 须携带它才能下发命令
        const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, '0')).join('');
        const port = PORT_AI;
        statusEl.textContent = '已开启（本地控制服务）';
        statusEl.className = 'ai-on';
        portEl.textContent = String(port);
        tokenEl.textContent = token;
        panel && panel.classList.remove('hidden');
        if (window.bambu && window.bambu.invoke) {
          try {
            await window.bambu.invoke('ai:enable', { port, token });
            log(`AI 控制服务已启动：http://127.0.0.1:${port}  （token: ${token}）`, 'ok');
          } catch (err) {
            log(`启动控制服务失败：${err && err.message}`, 'err');
          }
        } else {
          log('无主进程通道（window.bambu），仅支持本面板内指令。', 'info');
        }
        if (this.llmConfig.mode === 'llm' && !this.llmConfig.apiUrl) {
          log('当前为大模型模式但未配置 API，请点「配置…」填写', 'info');
        }
      } else {
        statusEl.textContent = '已关闭';
        statusEl.className = 'ai-off';
        portEl.textContent = '—';
        tokenEl.textContent = '—';
        panel && panel.classList.add('hidden');
        if (window.bambu && window.bambu.invoke) {
          try { await window.bambu.invoke('ai:disable'); } catch (_) { /* noop */ }
        }
        log('AI 控制服务已关闭。', 'info');
      }
    });

    closeBtn && closeBtn.addEventListener('click', () => {
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
    });

    clearBtn && clearBtn.addEventListener('click', () => { logEl.innerHTML = ''; });

    runBtn && runBtn.addEventListener('click', () => this.aiRun(input.value, log));
    input && input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.aiRun(input.value, log);
    });
  }

  /** 在面板内执行一条指令：JSON 命令 / 本地自然语言解析 / 大模型翻译 */
  async aiRun(text, log) {
    text = (text || '').trim();
    if (!text) return;
    log(`指令: ${text}`);

    // JSON 命令 / 命令计划：直接执行（所有模式通用）
    if (text.startsWith('{') || text.startsWith('[')) {
      let plan;
      try {
        const parsed = JSON.parse(text);
        plan = Array.isArray(parsed) ? parsed : [parsed];
      } catch (err) {
        log(`JSON 解析失败：${err.message}`, 'err');
        return;
      }
      await this._runPlanWithLog(plan, log);
      return;
    }

    // 大模型模式
    if (this.llmConfig && this.llmConfig.mode === 'llm') {
      await this._aiRunLLM(text, log);
      return;
    }

    // 本地确定性解析
    const scene = await this.bridge.run({ cmd: 'scene' }).then((r) => r.result);
    const res = parseInstruction(text, scene);
    if (res.error) { log(res.error, 'err'); return; }
    await this._runPlanWithLog(res.plan, log);
  }

  /** 大模型模式：流式调用 LLM → 提取命令计划 → 逐条执行（每条即时刷新视图=实时预览） */
  async _aiRunLLM(text, log) {
    const cfg = this.llmConfig;
    if (!cfg.apiUrl) {
      log('未配置大模型 API URL，请点「配置…」填写', 'err');
      return;
    }
    const thinkEl = document.getElementById('ai-think');
    thinkEl.classList.remove('hidden');
    thinkEl.textContent = '';
    log(`调用大模型 ${cfg.model || ''}…`, 'info');

    const scene = await this.bridge.run({ cmd: 'scene' }).then((r) => r.result);
    const messages = buildPlanMessages(scene, COMMAND_DOCS, text);

    let full = '';
    try {
      full = await callLLM(cfg, messages, {
        onToken: (t) => {
          thinkEl.textContent += t;
          thinkEl.scrollTop = thinkEl.scrollHeight;
        },
      });
    } catch (err) {
      log(`大模型调用失败：${err && err.message}`, 'err');
      return;
    }

    log(`大模型返回 ${full.length} 字符，解析命令计划…`, 'info');
    const { plan, error } = extractPlanFromResponse(full);
    if (error) {
      log(`解析失败：${error}`, 'err');
      return;
    }
    if (!plan.length) {
      log('大模型返回空计划', 'err');
      return;
    }
    log(`解析到 ${plan.length} 条命令，开始执行…`, 'info');
    await this._runPlanWithLog(plan, log);
  }

  /** 逐条执行命令计划，每条结果写入日志；每条执行后视图即时刷新（实时预览） */
  async _runPlanWithLog(plan, log) {
    for (const cmd of plan) {
      const out = await this.bridge.run(cmd);
      if (out.ok) {
        log(`✓ ${out.cmd} → ${JSON.stringify(out.result)}`, 'ok');
      } else {
        log(`✗ ${out.cmd} 失败：${out.error}`, 'err');
      }
    }
  }

  // ==================== 帮助 / 快捷键 ====================
  openHelp() {
    document.getElementById('help-modal').classList.remove('hidden');
  }

  closeHelp() {
    document.getElementById('help-modal').classList.add('hidden');
  }

  // ==================== 加载 ====================
  async loadFiles(files, append = false) {
    setStatus(`正在解析 ${files.length} 个文件…`, 'busy');
    document.getElementById('dropzone').classList.add('hidden');

    // 超大文件提示：3MF 需整文件读入内存解压，数百 MB 时内存峰值较高
    const LARGE = 200 * 1024 * 1024;
    for (const file of files) {
      if (file.size > LARGE) {
        toast(
          `${file.name} 较大（约 ${(file.size / 1048576).toFixed(0)}MB），解析时可能占用较多内存，请耐心等待`,
          'warn',
          4000,
        );
      }
    }

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
      // append 且全部解析失败：状态没变，回滚刚压入的快照，否则下一次 undo 无效果
      if (append && this.history.undoStack.length) this.history.undoStack.pop();
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

    this.project.applyPlateVisibility();
    this.renderPlates();

    this.tree.render();
    renderFilaments(this.filamentHost, this);
    if (!append) {
      const box = this.worldBox();
      this.viewer.positionPlateUnder(box);
      this.viewer.frameAll(box);
    }
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
    this.selectedSet.clear();
    if (object) this.selectedSet.add(object);
    this._setPrimary(object, part);
  }

  _setPrimary(object, part) {
    this.selection = { object, part };
    this.viewer.attachGizmo(object ? object.group : null);
    this.refreshSelectionBoxes();
    this.tree.render();
    this.inspector.render();
    document.getElementById('btn-delete').disabled = !object;
    this.updateSelectionBadge();
  }

  /** Shift+点击：在已选集合中增删该对象，并把主选择切到它 */
  selectToggle(object) {
    if (this.selectedSet.has(object)) this.selectedSet.delete(object);
    else this.selectedSet.add(object);
    const primary = this.selectedSet.has(object)
      ? object
      : [...this.selectedSet][0] || null;
    this.selection = { object: primary, part: null };
    this.viewer.attachGizmo(primary ? primary.group : null);
    this.refreshSelectionBoxes();
    this.tree.render();
    this.inspector.render();
    document.getElementById('btn-delete').disabled = this.selectedSet.size === 0;
    this.updateSelectionBadge();
  }

  /** 用一个集合覆盖当前选择（主选择取集合首个元素） */
  applySelectionSet(set) {
    this.selectedSet = set;
    const primary = [...set][0] || null;
    this.selection = { object: primary, part: null };
    this.viewer.attachGizmo(primary ? primary.group : null);
    this.refreshSelectionBoxes();
    this.tree.render();
    this.inspector.render();
    document.getElementById('btn-delete').disabled = set.size === 0;
    this.updateSelectionBadge();
  }

  /** Ctrl+A：选中当前热床全部对象 */
  selectAll() {
    this.applySelectionSet(new Set(this.project.activeObjects()));
  }

  /** 矩形框选：box 为视口（相对 canvas）像素坐标 {left,top,right,bottom} */
  marqueeSelect(box, additive) {
    const next = additive ? new Set([...this.selectedSet]) : new Set();
    for (const o of this.project.activeObjects()) {
      if (!o.group.visible) continue;
      const b = o.computeBox(new THREE.Box3());
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, seen = 0;
      for (const [x, y, z] of [
        [b.min.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.min.z],
        [b.min.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.min.z],
        [b.min.x, b.min.y, b.max.z], [b.max.x, b.min.y, b.max.z],
        [b.min.x, b.max.y, b.max.z], [b.max.x, b.max.y, b.max.z],
      ]) {
        const s = this.viewer.worldToScreen(new THREE.Vector3(x, y, z));
        if (!s.visible) continue;
        minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
        seen++;
      }
      if (!seen) continue; // 包围盒整体落在相机背面，忽略
      if (box.left <= maxX && box.right >= minX && box.top <= maxY && box.bottom >= minY) {
        next.add(o);
      }
    }
    if (next.size === 0) {
      if (!additive) this.select(null, null);
      else this.refreshSelectionBoxes();
      return;
    }
    this.applySelectionSet(next);
  }

  // ==================== 右键菜单 ====================
  /** 弹出右键菜单：items = [{label, onclick, danger?, disabled?}] */
  showContextMenu(clientX, clientY, items) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    for (const it of items) {
      const row = el('div', {
        class: `ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`,
        text: it.label,
        onclick: (e) => {
          e.stopPropagation();
          if (it.disabled) return;
          this.hideContextMenu();
          it.onclick();
        },
      });
      menu.append(row);
    }
    // 注意必须显式 'block'：置 '' 会回落到 CSS 的 display:none，菜单永远弹不出来
    menu.style.display = 'block';
    // 避免溢出视口
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || items.length * 30;
    const x = Math.min(clientX, window.innerWidth - mw - 8);
    const y = Math.min(clientY, window.innerHeight - mh - 8);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  hideContextMenu() {
    const menu = document.getElementById('ctx-menu');
    if (menu) menu.style.display = 'none';
  }

  /** 对象右键菜单项（作用于当前选择） */
  objectContextItems() {
    const sel = [...this.selectedSet];
    const n = sel.length;
    const items = [
      { label: '复制', onclick: () => this.duplicateSelected() },
      { label: '删除', danger: true, onclick: () => this.deleteSelected() },
      { label: '隐藏', onclick: () => this.setSelectedVisible(false) },
      { label: '单独显示', onclick: () => this.isolateSelected() },
      { label: '合并选中', disabled: n < 2, onclick: () => this.mergeSelected() },
      { label: '生成底座', onclick: () => this.autoBase() },
      { label: '网格修复', onclick: () => this.repairSelected() },
    ];
    if (n >= 2) {
      items.push(
        { label: '布尔并集', onclick: () => this.booleanSelected('union') },
        { label: '布尔差集 (A−B)', onclick: () => this.booleanSelected('difference') },
        { label: '布尔交集', onclick: () => this.booleanSelected('intersection') },
      );
    }
    if (this.project.plates.length > 1 || n > 0) {
      items.push({ label: '复制到其他热床', onclick: () => this.copyToPlate() });
    }
    return items;
  }

  /** 空白处右键菜单项 */
  emptyContextItems() {
    return [
      { label: '全选', onclick: () => this.selectAll() },
      { label: '自动排列', onclick: () => this.arrangeAll() },
      { label: '网格修复全部', onclick: () => this.repairSelected() },
      { label: '新建热床', onclick: () => this.addPlate() },
    ];
  }

  /** 隐藏 / 显示选中对象（仅改用户显隐） */
  setSelectedVisible(visible) {
    for (const o of this.selectedSet) o.userVisible = visible;
    this.project.applyPlateVisibility();
    this.viewer.requestRender();
    this.tree.render();
  }

  /** 单独显示：隐藏其它，仅留选中 */
  isolateSelected() {
    const sel = this.selectedSet;
    for (const o of this.project.activeObjects()) o.userVisible = sel.has(o);
    this.project.applyPlateVisibility();
    this.viewer.requestRender();
    this.tree.render();
  }

  refreshSelectionBoxes() {
    const boxes = [];
    for (const o of this.selectedSet) {
      o.computeBox(this._box);
      boxes.push(this._box.clone());
    }
    this.viewer.showSelectionBoxes(boxes);
  }

  updateSelectionBadge() {
    const n = this.selectedSet.size;
    const badge = document.getElementById('sel-badge');
    if (!badge) return;
    badge.style.display = n > 1 ? '' : 'none';
    badge.textContent = `${n} 选中`;
  }

  focusObject(object) {
    this.viewer.frameAll(object.computeBox(new THREE.Box3()));
  }

  deleteSelected() {
    const objs = [...this.selectedSet];
    if (!objs.length) return;
    const n = objs.length;
    this.pushHistory();
    for (const o of objs) this.project.removeObject(o);
    this.selectedSet.clear();
    this.select(null, null);
    this.tree.render();
    this.updateHud();
    toast(`已删除 ${n} 个对象，Ctrl+Z 可撤销`, 'info');
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
      const objects = this.project.activeObjects()
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

  // ==================== 镜像 / 阵列 / 合并 ====================
  /** 沿 axis(x/y/z) 镜像选中对象，生成副本并落板居中 */
  mirrorSelected(axis) {
    const obj = this.selection.object;
    if (!obj) {
      toast('请先选中一个对象', 'err');
      return;
    }
    this.pushHistory();
    this._historyLock = true;
    try {
      const copy = mirrorObject(obj, axis, ScenePart, SceneObject);
      this.project.addObject(copy);
      this.viewer.modelRoot.add(copy.group);
      // 落板 + 居中（不额外 push 历史）
      copy.computeBox(this._box);
      const c = this._box.getCenter(new THREE.Vector3());
      copy.group.position.x += this.project.bed.width / 2 - c.x;
      copy.group.position.y += this.project.bed.depth / 2 - c.y;
      copy.group.position.z -= this._box.min.z;
      copy.group.updateMatrixWorld(true);
      this.select(copy, null);
    } finally {
      this._historyLock = false;
    }
    this.tree.render();
    this.updateHud();
    toast(`已沿 ${axis.toUpperCase()} 轴镜像`, 'ok');
  }

  /** 以选中对象为模板，生成线性 / 圆形阵列副本 */
  arraySelected(opts) {
    const obj = this.selection.object;
    if (!obj) {
      toast('请先选中一个对象', 'err');
      return;
    }
    this.pushHistory();
    this._historyLock = true;
    let copies = [];
    try {
      copies = arrayObjects(obj, opts, ScenePart, SceneObject, cloneSceneObject);
      for (const c of copies) {
        this.project.addObject(c);
        this.viewer.modelRoot.add(c.group);
      }
      if (copies.length) this.avoidOverlap(copies);
      this.select(copies[0] || obj, null);
    } finally {
      this._historyLock = false;
    }
    this.tree.render();
    this.updateHud();
    toast(`已生成 ${copies.length} 个阵列副本`, 'ok');
  }

  /**
   * 合并：
   *  - 选中多个对象（Shift 多选）→ 合并成一个单一几何对象
   *  - 选中单对象且含多个零件 → 合并其零件（与拆件对称）
   */
  async mergeSelected() {
    const objs = [...this.selectedSet];
    if (objs.length >= 2) {
      this.pushHistory();
      let merged;
      try {
        merged = await this._withBusy('合并对象', () => {
          const m = mergeObjects(objs, SceneObject, ScenePart);
          for (const o of objs) this.project.removeObject(o);
          this.selectedSet.clear();
          return m;
        });
      } catch (err) {
        this._opFailed(err, '合并对象', true);
        return;
      }
      this.project.addObject(merged);
      this.viewer.modelRoot.add(merged.group);
      this.select(merged, null);
      this.refreshAll();
      toast(`已合并 ${objs.length} 个对象为单一零件（${merged.triangleCount} 三角面）`, 'ok');
      return;
    }
    const obj = this.selection.object;
    if (!obj) {
      toast('请先选中对象（Shift 多选可合并多个）', 'err');
      return;
    }
    if (obj.parts.length < 2) {
      toast('该对象仅一个零件，无需合并', 'info', 2500);
      return;
    }
    this.pushHistory();
    let merged;
    try {
      merged = await this._withBusy('合并零件', () => {
        const m = collapseObject(obj);
        this.project.removeObject(obj);
        return m;
      });
    } catch (err) {
      this._opFailed(err, '合并零件', true);
      return;
    }
    this.project.addObject(merged);
    this.viewer.modelRoot.add(merged.group);
    this.select(merged, null);
    this.refreshAll();
    toast(`已合并为 ${merged.triangleCount} 三角面的单一零件`, 'ok');
  }

  /** 为选中（或所有）对象自动生成底座 / 支撑 */
  async autoBase() {
    const targets = [...this.selectedSet];
    const objs = targets.length ? targets : this.project.activeObjects().slice();
    if (!objs.length) {
      toast('没有可生成底座的对象', 'err');
      return;
    }
    this.pushHistory();
    let made;
    try {
      made = await this._withBusy('生成底座', () => {
        let n = 0;
        this._historyLock = true;
        try {
          for (const o of objs) {
            const base = buildAutoBase(o, ScenePart, SceneObject);
            this.project.addObject(base);
            this.viewer.modelRoot.add(base.group);
            n++;
          }
        } finally {
          this._historyLock = false;
        }
        return n;
      });
    } catch (err) {
      // 逐对象循环可能部分完成，保留快照让用户能撤销已生成的部分
      this._opFailed(err, '生成底座');
      this.refreshAll();
      return;
    }
    this.refreshAll();
    toast(`已为 ${made} 个对象生成底座${targets.length ? '' : '（当前全部）'}`, 'ok');
  }

  /** 显示/隐藏「处理中」遮罩（重型同步运算前，避免用户误以为崩溃） */
  _showBusy(on, label = '处理中') {
    if (!this._busyEl) {
      const el = document.createElement('div');
      el.id = 'busy-overlay';
      el.innerHTML = '<div class="busy-box"><div class="spinner"></div><span class="busy-label"></span></div>';
      document.body.appendChild(el);
      this._busyEl = el;
    }
    this._busyEl.querySelector('.busy-label').textContent = label;
    this._busyEl.classList.toggle('hidden', !on);
  }

  /** 让出一帧绘制遮罩后，再执行同步重型计算 */
  async _withBusy(label, work) {
    setStatus(`正在${label}…`, 'busy');
    this._showBusy(true, label);
    // 等两帧，确保遮罩先绘制出来再阻塞主线程。
    // 窗口最小化/后台时 rAF 停止调度，用 120ms 超时兜底，避免 AI 远程驱动时永久挂起。
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      new Promise((r) => setTimeout(r, 120)),
    ]);
    try {
      return work();
    } finally {
      this._showBusy(false);
      setStatus('就绪', 'ok');
    }
  }

  /**
   * 重型运算失败的统一反馈：toast 报错（而不是无声 unhandled rejection）。
   * rollback=true 时回滚刚压入的空快照（仅限「先计算、成功后才改状态」的全有或全无操作）。
   */
  _opFailed(err, label, rollback = false) {
    if (rollback) this.history.undoStack.pop();
    console.error(`[op] ${label}失败:`, err);
    toast(`${label}失败：${err?.message || err}`, 'err', 5000);
  }

  /** 网格修复：对选中对象（无选中则当前热床全部）做焊接 / 封洞 / 剔除退化 */
  async repairSelected() {
    const list = [...this.selectedSet];
    const objs = list.length ? list : this.project.activeObjects();
    if (!objs.length) {
      toast('没有可修复的对象', 'err');
      return;
    }
    this.pushHistory();
    let total;
    try {
      total = await this._withBusy('修复网格', () => {
        const t = { removedDegenerate: 0, weldedVertices: 0, filledHoles: 0 };
        this._historyLock = true;
        try {
          for (const o of objs) {
            for (const p of o.parts) {
              const rep = repairPart(p);
              t.removedDegenerate += rep.removedDegenerate;
              t.weldedVertices += rep.weldedVertices;
              t.filledHoles += rep.filledHoles;
            }
          }
        } finally {
          this._historyLock = false;
        }
        return t;
      });
    } catch (err) {
      // 部分零件可能已修复，保留快照让用户能撤销
      this._opFailed(err, '修复网格');
      this.syncClip();
      this.refreshAll();
      return;
    }
    this.syncClip();
    this.refreshAll();
    toast(
      `已修复 ${objs.length} 个对象：剔除退化 ${total.removedDegenerate} · 焊接 ${total.weldedVertices} · 封洞 ${total.filledHoles}`,
      'ok', 4500,
    );
  }

  /** 布尔运算：需恰好选中 2 个对象（selectedSet 中 A 在前、B 在后） */
  async booleanSelected(op) {
    const objs = [...this.selectedSet];
    if (objs.length !== 2) {
      toast('布尔运算需恰好选中 2 个对象（A 在前、B 在后，差集为 A−B）', 'err', 4500);
      return;
    }
    const [a, b] = objs;
    const label = op === 'union' ? '并集' : op === 'intersection' ? '交集' : '差集';
    this.pushHistory();
    let result;
    try {
      result = await this._withBusy(`布尔${label}`, () => {
        this._historyLock = true;
        try {
          const r = booleanObjects(a, b, op, SceneObject, ScenePart);
          this.project.removeObject(a);
          this.project.removeObject(b);
          this.selectedSet.clear();
          this.project.addObject(r);
          this.viewer.modelRoot.add(r.group);
          this.select(r, null);
          return r;
        } finally {
          this._historyLock = false;
        }
      });
    } catch (err) {
      this._opFailed(err, `布尔${label}`, true);
      return;
    }
    this.syncClip();
    this.refreshAll();
    const r = result.booleanReport || {};
    const dimStr = r.dims ? `（${r.dims.x}×${r.dims.y}×${r.dims.z} mm）` : '';
    toast(`已生成 ${result.name} · ${r.triangles ?? '?'} 三角面 ${dimStr}`, 'ok', 5000);
  }

  // ==================== 剖面 / 裁剪 ====================
  /** 设置剖面裁剪：axis(x/y/z) + 切割位置(mm)，on=false 关闭 */
  setClip(axis, dist, on) {
    if (!on) {
      this._clipPlane = null;
      this.viewer.setClipPlane(null);
      return;
    }
    const n = axis === 'x' ? new THREE.Vector3(-1, 0, 0)
      : axis === 'y' ? new THREE.Vector3(0, -1, 0)
        : new THREE.Vector3(0, 0, -1);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(
      axis === 'x' ? dist : 0,
      axis === 'y' ? dist : 0,
      axis === 'z' ? dist : 0,
    ));
    this._clipPlane = plane;
    this.viewer.setClipPlane(plane);
  }

  /** 重新把当前裁剪平面应用到场景（对象增删后调用，保证新对象也被裁剪） */
  syncClip() {
    if (this._clipPlane) this.viewer.setClipPlane(this._clipPlane);
  }

  // ==================== 多热床 ====================
  /** 切换到指定热床：隐藏其它热床对象并清空选择 */
  switchPlate(id) {
    this.project.activePlate = id;
    this.project.applyPlateVisibility();
    this.select(null, null);
    this.tree.render();
    this.renderPlates();
    const box = this.worldBox();
    this.viewer.positionPlateUnder(box);
    this.viewer.frameAll(box);
    this.updateHud();
    this.viewer.markShadowsDirty();
    this.viewer.requestRender();
  }

  /** 新建一个热床并切换过去 */
  addPlate() {
    this.pushHistory();
    const id = this.project.plates.length
      ? Math.max(...this.project.plates.map((p) => p.id)) + 1
      : 1;
    this.project.plates.push({ id, name: `热床 ${this.project.plates.length + 1}` });
    this.switchPlate(id);
    toast(`已新建「热床 ${this.project.plates.length}」`, 'ok');
  }

  /** 把选中对象复制一份到其它热床（若只有当前热床则先新建） */
  copyToPlate() {
    const objs = [...this.selectedSet];
    if (!objs.length) {
      toast('请先选中要复制的对象', 'err');
      return;
    }
    // 单次历史：快照取「建盘 + 复制」之前的状态，一次 undo 即可全部回退
    // （此前 addPlate 内部还会再 push 一次，需要 undo 两次才能完全回退）
    this.pushHistory();
    this._historyLock = true;
    let target;
    try {
      target = this.project.plates.find((p) => p.id !== this.project.activePlate);
      if (!target) {
        this.addPlate(); // _historyLock 生效，内部的 pushHistory 被跳过
        target = this.project.plates[this.project.plates.length - 1];
      }
      for (const o of objs) {
        const copy = cloneSceneObject(o, ScenePart, SceneObject);
        copy.plateId = target.id;
        this.project.addObject(copy);
        this.viewer.modelRoot.add(copy.group);
      }
    } finally {
      this._historyLock = false;
    }
    this.switchPlate(target.id);
    this.refreshAll();
    toast(`已复制 ${objs.length} 个对象到「${target.name}」`, 'ok');
  }

  /** 右侧热床标签栏 */
  renderPlates() {
    const bar = document.getElementById('plate-bar');
    if (!bar) return;
    bar.innerHTML = '';
    for (const p of this.project.plates) {
      const tab = el('button', {
        class: `plate-tab${p.id === this.project.activePlate ? ' active' : ''}`,
        text: p.name,
        title: `切换到${p.name}`,
        onclick: () => this.switchPlate(p.id),
      });
      bar.append(tab);
    }
    const add = el('button', { class: 'plate-add', text: '＋', title: '新建热床' });
    add.onclick = () => this.addPlate();
    bar.append(add);
  }

  /** 导出场景为二进制 STL */
  async exportSTL() {
    if (this.project.isEmpty) {
      toast('没有可导出的模型', 'err');
      return;
    }
    try {
      const blob = writeSTL(this.project);
      const base = this.project.docs.get(this.project.baseDocId);
      const stem = (base?.name || 'project').replace(/\.3mf$/i, '');
      downloadBlob(blob, `${stem}_edited.stl`);
      toast(`已导出 STL ${humanBytes(blob.size)}`, 'ok', 3500);
    } catch (err) {
      console.error(err);
      toast(`导出 STL 失败：${err.message}`, 'err', 6000);
    }
  }

  // ==================== 测量 ====================
  /** 切换测量模式：点选模型表面两点，得到直线距离与 ΔXYZ 分解 */
  toggleMeasure() {
    const btn = document.getElementById('btn-measure');
    this.measure.active = !this.measure.active;
    btn.classList.toggle('active', this.measure.active);
    this.viewer.canvas.style.cursor = this.measure.active ? 'crosshair' : '';
    if (!this.measure.active) this.cancelPending();
    toast(this.measure.active ? '测量模式：依次点击模型表面两点' : '已退出测量模式', 'info', 1800);
  }

  measurePick(x, y) {
    const meshes = [];
    for (const o of this.project.objects) {
      if (!o.group.visible) continue;
      for (const p of o.parts) meshes.push(p.mesh);
    }
    const hit = this.viewer.pick(x, y, meshes);
    if (!hit) {
      toast('请点击模型表面', 'info', 1400);
      return;
    }
    const pt = hit.point.clone();
    if (this.measure.pending) {
      const start = this.measure.pending;
      this.cancelPending();
      this.addMeasurement(start, pt);
    } else {
      this.measure.pending = pt;
      this.drawPending(pt);
    }
  }

  drawPending(pt) {
    this.cancelPending();
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1.8, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x2f80ff, depthTest: false }),
    );
    m.position.copy(pt);
    m.renderOrder = 1000;
    this.measureGroup.add(m);
    this.measure.pendingMarker = m;
    this.viewer.requestRender();
  }

  cancelPending() {
    if (this.measure.pendingMarker) {
      this.measureGroup.remove(this.measure.pendingMarker);
      disposeTree(this.measure.pendingMarker);
      this.measure.pendingMarker = null;
    }
    this.measure.pending = null;
    this.viewer.requestRender();
  }

  addMeasurement(a, b) {
    const group = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffcf3b, depthTest: false, transparent: true });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat);
    line.renderOrder = 999;
    group.add(line);
    for (const p of [a, b]) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffcf3b, depthTest: false }),
      );
      dot.position.copy(p);
      dot.renderOrder = 1000;
      group.add(dot);
    }
    this.measureGroup.add(group);

    const dist = a.distanceTo(b);
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), dz = Math.abs(b.z - a.z);
    const label = el('div', { class: 'measure-label' });
    label.innerHTML =
      `<span class="dist">${dist.toFixed(2)} mm</span>` +
      `<span class="sub">Δ ${dx.toFixed(1)} / ${dy.toFixed(1)} / ${dz.toFixed(1)}</span>`;
    document.getElementById('viewport').appendChild(label);

    const item = { a, b, group, label };
    this.measure.items.push(item);
    this.updateMeasureLabel(item);
    this.updateClearButton();
    this.viewer.requestRender();
    toast(`距离 ${dist.toFixed(2)} mm`, 'ok', 1600);
  }

  updateMeasureLabel(item) {
    const mid = item.a.clone().add(item.b).multiplyScalar(0.5);
    const s = this.viewer.worldToScreen(mid);
    if (s.visible) {
      item.label.style.display = '';
      item.label.style.left = `${s.x}px`;
      item.label.style.top = `${s.y}px`;
    } else {
      item.label.style.display = 'none';
    }
  }

  updateMeasureLabels() {
    for (const it of this.measure.items) this.updateMeasureLabel(it);
  }

  clearMeasurements() {
    for (const it of this.measure.items) {
      this.measureGroup.remove(it.group);
      disposeTree(it.group);
      it.label.remove();
    }
    this.measure.items = [];
    this.cancelPending();
    this.updateClearButton();
    this.viewer.requestRender();
  }

  updateClearButton() {
    document.getElementById('btn-clear-measure')
      .classList.toggle('hidden', this.measure.items.length === 0);
  }

  // ==================== 拆件（拆分 / 切割） ====================
  async splitSelected(grid, addBase, opts) {
    const obj = this.selection.object;
    if (!obj) {
      toast('请先选中一个对象', 'err');
      return;
    }
    const { objects, changed } = await this._withBusy('拆分连通体', () => splitShells(obj, opts));
    if (!changed) {
      toast('该对象是单一连通体，无需拆分', 'info', 2500);
      return;
    }
    this.pushHistory();
    this.applySplitResult(obj, objects, grid, addBase);
    toast(`已拆分为 ${objects.length} 个独立对象${addBase ? '（含底座）' : ''}`, 'ok');
  }

  async cutSelected(axis, dist, cap, grid, addBase) {
    const obj = this.selection.object;
    if (!obj) {
      toast('请先选中一个对象', 'err');
      return;
    }
    const { objects, changed } = await this._withBusy('平面切割', () => cutObject(obj, axis, dist, cap));
    if (!changed) {
      toast('切割平面未穿过模型，请调整位置', 'info', 2500);
      return;
    }
    this.pushHistory();
    this.applySplitResult(obj, objects, grid, addBase);
    toast(`已切割为 ${objects.length} 块${addBase ? '（含底座）' : ''}`, 'ok');
  }

  /**
   * 把若干对象按网格整齐排到热床（XY 行优先，列满换行，整体居中）。
   * 每个对象先 dropToBed 保证底面贴床，再交给纯函数 gridLayout 计算布局。
   */
  arrangeGrid(objects) {
    for (const o of objects) this.dropToBed(o);
    gridLayout(objects, this.project.bed);
  }

  /** 用新对象替换原对象：移除原对象（保留几何供撤销）、加入新对象、自动落板+排布；可选为每个新对象加底座 */
  applySplitResult(original, newObjects, grid, addBase) {
    // 移除原对象但不 dispose 几何：History 快照持有原对象引用，撤销时要恢复
    this.project.removeObject(original);
    if (this.selection.object === original) this.select(null, null);
    this._historyLock = true;
    try {
      for (const o of newObjects) {
        this.project.addObject(o);
        this.viewer.modelRoot.add(o.group);
        o.group.updateMatrixWorld(true);
      }
      const all = [...newObjects];
      if (addBase) {
        for (const o of newObjects) {
          const base = createBase(o);
          this.project.addObject(base);
          this.viewer.modelRoot.add(base.group);
          all.push(base);
        }
      }
      if (grid) {
        this.arrangeGrid(all);
      } else {
        for (const o of all) this.dropToBed(o);
        this.avoidOverlap(all);
      }
    } finally {
      this._historyLock = false;
    }
    this.select(newObjects[0] || null, null);
    this.refreshAll();
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
    this.refreshAll();
    toast('已撤销', 'info', 1400);
  }

  redo() {
    if (!this.history.redo()) {
      toast('没有可重做的操作', 'info', 1600);
      return;
    }
    this.refreshAll();
    toast('已重做', 'info', 1400);
  }

  updateHistoryButtons() {
    document.getElementById('btn-undo').disabled = !this.history.canUndo;
    document.getElementById('btn-redo').disabled = !this.history.canRedo;
  }

  /** 集合变化后统一刷新各面板 */
  refreshAll() {
    this.project.applyPlateVisibility();
    this.tree.render();
    this.renderPlates();
    this.inspector.render();
    renderFilaments(this.filamentHost, this);
    this.refreshSelectionBoxes();
    this.syncClip();
    this.updateHud();
    this.updateHistoryButtons();
    this.viewer.markShadowsDirty();
    this.viewer.requestRender();
    document
      .getElementById('dropzone')
      .classList.toggle('hidden', !this.project.isEmpty);
  }

  // ==================== 变换辅助 ====================
  onObjectTransformed(object) {
    this.refreshSelectionBoxes();
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
    for (const o of this.project.activeObjects()) box.union(o.computeBox(new THREE.Box3()));
    return box;
  }

  updateHud() {
    const s = this.project.stats;
    const hud = document.getElementById('hud-stats');
    const selN = this.selectedSet.size;
    hud.textContent = s.objects
      ? `${s.objects} 个对象 · ${s.parts} 个零件 · ${s.triangles.toLocaleString('en-US')} 三角面${selN > 1 ? ` · ${selN} 选中` : ''}`
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

  /** 导出为 base64（供 AI 桥 / 控制服务落盘，不弹对话框） */
  async export3mfBuffer() {
    if (this.project.isEmpty) throw new Error('没有可导出的模型');
    const blob = await writeThreeMF(this.project);
    const base = this.project.docs.get(this.project.baseDocId);
    const stem = (base?.name || 'project').replace(/\.3mf$/i, '');
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return { base64: btoa(binary), name: `${stem}_edited.3mf` };
  }

  /** 从 base64 导入 3MF（供 AI 桥使用） */
  async import3mfBuffer(base64, name = 'imported.3mf') {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([bytes], name);
    await this.loadFiles([file], !this.project.isEmpty);
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
