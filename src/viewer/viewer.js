/**
 * Three.js 视口。
 *
 * 坐标系与切片器保持一致：Z 轴朝上，原点在热床左前角，单位毫米。
 * 这样 3MF 里的变换矩阵可以直接使用，不需要任何坐标转换。
 *
 * 渲染采用按需模式（on-demand）：只有场景真正变化时才绘制，
 * 静止时 GPU 占用为零，笔记本上不会无谓地烧电。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildPlate } from './plate.js';

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 阴影按需刷新：只在场景结构变化（载入/编辑/切换盘）时重算一次，
    // 旋转/平移相机时不重算，避免百万面模型每帧把阴影通道跑两遍导致卡顿。
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.background = makeGradientBackground();

    // Z-up
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 8000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(320, -360, 280);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.995;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 3000;
    this.controls.addEventListener('change', () => this.requestRender());

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.plate = null;
    this.setupLights();
    this.setupEnvironment();

    // 变换控制器
    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setSpace('world');
    this.transform.setTranslationSnap(null);
    this.transform.addEventListener('change', () => this.requestRender());
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (e.value) this.onTransformStart?.();
      else this.onTransformCommit?.();
    });
    this.transform.addEventListener('objectChange', () => this.onTransformChange?.());
    // r170 起 TransformControls 本身不是 Object3D，需要取它的 helper
    const gizmo = this.transform.getHelper ? this.transform.getHelper() : this.transform;
    this.scene.add(gizmo);
    this.transformHelper = gizmo;
    gizmo.visible = false;

    // 选中高亮外框（可同时显示多个对象）
    this.selectionGroup = new THREE.Group();
    this.scene.add(this.selectionGroup);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._needsRender = true;
    this._running = true;
    this.clipPlane = null; // THREE.Plane | null

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.animate();
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x5b6470, 1.05);
    hemi.position.set(0, 0, 400);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.55);
    key.position.set(260, -320, 520);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.5;
    const c = key.shadow.camera;
    c.near = 10;
    c.far = 2200;
    c.left = -420;
    c.right = 420;
    c.top = 420;
    c.bottom = -420;
    this.scene.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0xdce6ff, 0.42);
    fill.position.set(-320, 240, 220);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0, 420, -160);
    this.scene.add(rim);
  }

  setupEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  setBed(bed) {
    if (this.plate) {
      this.scene.remove(this.plate);
      disposeTree(this.plate);
    }
    this.plate = buildPlate(bed);
    this.scene.add(this.plate);

    const { width, depth } = bed;
    this.controls.target.set(width / 2, depth / 2, Math.min(60, bed.height / 4));
    // 阴影相机跟随热床尺寸，避免大机型漏阴影
    const r = Math.max(width, depth) * 0.9;
    const c = this.keyLight.shadow.camera;
    c.left = -r;
    c.right = r;
    c.top = r;
    c.bottom = -r;
    c.updateProjectionMatrix();
    this.keyLight.position.set(width / 2 + 260, depth / 2 - 340, 520);
    this.keyLight.target.position.set(width / 2, depth / 2, 0);
    this.keyLight.target.updateMatrixWorld();
    this.scene.add(this.keyLight.target);

    this.controls.update();
    this.markShadowsDirty();
    this.requestRender();
  }

  /**
   * 把热床移动到指定包围盒下方并跟随光源，用于多盘文件切换时
   * 让每个热床的对象都显示在自己的床上。
   */
  positionPlateUnder(box) {
    if (!this.plate || !box || box.isEmpty()) return;
    const { width, depth } = this.plate.userData.bed;
    const center = box.getCenter(new THREE.Vector3());
    const bx = center.x - width / 2;
    const by = center.y - depth / 2;
    this.plate.position.set(bx, by, 0);

    // 主光源跟随热床，保证阴影覆盖当前热床区域
    this.keyLight.position.set(bx + width / 2 + 260, by + depth / 2 - 340, 520);
    this.keyLight.target.position.set(bx + width / 2, by + depth / 2, 0);
    this.keyLight.target.updateMatrixWorld();

    this.markShadowsDirty();
    this.requestRender();
  }

  frameAll(box) {
    if (!box || box.isEmpty()) {
      const { width, depth, height } = this.plate?.userData.bed || { width: 256, depth: 256, height: 256 };
      this.camera.position.set(width * 1.35, -depth * 1.35, height * 1.1);
      this.controls.target.set(width / 2, depth / 2, Math.min(60, height / 4));
      this.controls.update();
      this.requestRender();
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 15);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.25;
    const dir = new THREE.Vector3(0.62, -0.72, 0.51).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  attachGizmo(object3d) {
    if (object3d) {
      this.transform.attach(object3d);
      this.transformHelper.visible = true;
    } else {
      this.transform.detach();
      this.transformHelper.visible = false;
    }
    this.requestRender();
  }

  setGizmoMode(mode) {
    this.transform.setMode(mode);
    this.requestRender();
  }

  /** 显示一组选中外框（每个对象一个）。boxes: THREE.Box3[] */
  showSelectionBoxes(boxes) {
    const pool = this.selectionGroup;
    while (pool.children.length > 0) {
      const h = pool.children.pop();
      h.geometry?.dispose();
      h.material?.dispose();
      pool.remove(h);
    }
    for (const b of boxes) {
      if (!b || b.isEmpty()) continue;
      const helper = new THREE.Box3Helper(b.clone(), 0x2f80ff);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      pool.add(helper);
    }
    this.requestRender();
  }

  /** 设置 / 清除剖面裁剪平面（THREE.Plane | null）。裁剪只作用于模型网格，不影响热床与选框 */
  setClipPlane(plane) {
    this.clipPlane = plane;
    this.renderer.localClippingEnabled = !!plane;
    const clips = plane ? [plane] : null;
    const count = clips ? clips.length : 0;
    // 仅当裁剪平面「数量」变化时材质才需重编译着色器；平面仅平移无需重编译
    const prevCount = this._clipCount ?? 0;
    if (count !== prevCount) {
      this.modelRoot.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.clippingPlanes = clips;
          o.material.clipShadows = true;
          o.material.needsUpdate = true;
        }
      });
    } else {
      this.modelRoot.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.clippingPlanes = clips;
          o.material.clipShadows = true;
        }
      });
    }
    this._clipCount = count;
    this.requestRender();
  }

  /** 屏幕坐标拾取，返回命中的 Mesh */
  pick(clientX, clientY, candidates) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(candidates, true);
    return hits.length ? hits[0] : null;
  }

  /** 把世界坐标投影到视口像素坐标（相对 canvas/视口左上角），用于 HTML 浮层定位 */
  worldToScreen(world) {
    const rect = this.canvas.getBoundingClientRect();
    const v = world.clone().project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height,
      visible: v.z > -1 && v.z < 1,
    };
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    this._needsRender = true;
  }

  /** 标记阴影贴图需要重算（场景几何/变换变化后调用，下一次渲染时执行一次） */
  markShadowsDirty() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  animate = () => {
    if (!this._running) return;
    requestAnimationFrame(this.animate);
    const damping = this.controls.update();
    if (this._needsRender || damping) {
      this._needsRender = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  dispose() {
    this._running = false;
    this.resizeObserver.disconnect();
    this.transform.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

function makeGradientBackground() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#20242c');
  g.addColorStop(0.55, '#2c313b');
  g.addColorStop(1, '#3a4150');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
}
