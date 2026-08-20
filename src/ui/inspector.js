/**
 * 右侧属性面板。
 *
 * 位置/尺寸按切片器习惯显示：位置取世界包围盒中心的 XY 与底面 Z，
 * 尺寸取世界包围盒边长——这比直接暴露 3MF 里的原始平移量直观得多。
 */
import * as THREE from 'three';
import { el, clear, numberInput, fmt } from './dom.js';

const RAD = 180 / Math.PI;

export class Inspector {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.inputs = null;
    this.uniformScale = true;
    this._box = new THREE.Box3();
    this._size = new THREE.Vector3();
    this._center = new THREE.Vector3();
  }

  render() {
    const root = clear(this.container);
    this.inputs = null;
    const { object, part } = this.app.selection;
    const selCount = this.app.selectedSet.size;

    if (selCount > 1) {
      root.append(this.sectionMulti(selCount));
      return;
    }

    if (!object) {
      root.append(
        el('div', { class: 'insp-empty' }, [
          '未选中对象',
          el('br'),
          '在视口中点击模型，或在左侧列表中选择',
        ]),
      );
      return;
    }

    root.append(this.sectionBasic(object));
    root.append(this.sectionTransform(object));
    root.append(this.sectionColor(object, part));
    root.append(this.sectionStats(object, part));
    this.syncValues();
  }

  // ---------- 基本信息 ----------
  sectionBasic(object) {
    const nameInput = el('input', {
      type: 'text',
      value: object.name,
      onchange: (e) => {
        this.app.pushHistory();
        object.name = e.target.value.trim() || object.name;
        this.app.tree.render();
      },
    });
    return el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-title' }, '对象'),
      el('div', { class: 'field' }, [el('label', { text: '名称' }), nameInput]),
      el('label', { class: 'chk' }, [
        el('input', {
          type: 'checkbox',
          checked: object.printable,
          onchange: (e) => {
            this.app.pushHistory();
            object.printable = e.target.checked;
            for (const p of object.parts) {
              p.material.opacity = object.printable ? 1 : 0.35;
              p.material.transparent = !object.printable;
              p.material.needsUpdate = true;
            }
            this.app.viewer.requestRender();
          },
        }),
        '参与打印',
      ]),
    ]);
  }

  // ---------- 多选摘要 ----------
  sectionMulti(count) {
    const app = this.app;
    let tris = 0;
    let parts = 0;
    for (const o of app.selectedSet) {
      tris += o.triangleCount;
      parts += o.parts.length;
    }
    return el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-title' }, `已选中 ${count} 个对象`),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: '零件数' }), el('span', { class: 'v', text: String(parts) })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: '三角面' }), el('span', { class: 'v', text: tris.toLocaleString('en-US') })]),
      el('div', { class: 'hint' }, '可一键合并为单一对象，或批量生成底座 / 删除。'),
      el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn', text: '合并', onclick: () => app.mergeSelected() }),
        el('button', { class: 'btn', text: '底座', onclick: () => app.autoBase() }),
        el('button', { class: 'btn danger', text: '删除', onclick: () => app.deleteSelected() }),
      ]),
    ]);
  }

  // ---------- 变换 ----------
  sectionTransform(object) {
    const g = object.group;
    const inputs = (this.inputs = {});

    const posRow = this.xyzRow(['pos'], (axis, v) => {
      // 输入的是包围盒中心/底面坐标，换算成 group 平移的增量
      this.measure(object);
      const cur = axis === 2 ? this._box.min.z : this._center.getComponent(axis);
      g.position.setComponent(axis, g.position.getComponent(axis) + (v - cur));
      this.afterTransform(object);
    }, inputs, 'pos');

    const rotRow = this.xyzRow(['rot'], (axis, v) => {
      const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
      const angles = [e.x, e.y, e.z];
      angles[axis] = v / RAD;
      g.quaternion.setFromEuler(new THREE.Euler(angles[0], angles[1], angles[2], 'XYZ'));
      this.afterTransform(object);
    }, inputs, 'rot');

    const sizeRow = this.xyzRow(['size'], (axis, v) => {
      this.measure(object);
      const cur = this._size.getComponent(axis);
      if (cur <= 1e-6 || v <= 0) return;
      const ratio = v / cur;
      if (this.uniformScale) g.scale.multiplyScalar(ratio);
      else g.scale.setComponent(axis, g.scale.getComponent(axis) * ratio);
      this.afterTransform(object);
    }, inputs, 'size');

    const scaleRow = this.xyzRow(['scale'], (axis, v) => {
      const ratio = v / 100;
      if (ratio <= 0) return;
      if (this.uniformScale) g.scale.set(ratio, ratio, ratio);
      else g.scale.setComponent(axis, ratio);
      this.afterTransform(object);
    }, inputs, 'scale');

    return el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-title' }, [
        '变换',
        el('span', { style: { fontWeight: '400', textTransform: 'none', letterSpacing: '0' } }, 'mm / ° / %'),
      ]),
      el('div', { class: 'field' }, [el('label', { text: '位置' }), posRow]),
      el('div', { class: 'field' }, [el('label', { text: '旋转' }), rotRow]),
      el('div', { class: 'field' }, [el('label', { text: '尺寸' }), sizeRow]),
      el('div', { class: 'field' }, [el('label', { text: '缩放' }), scaleRow]),
      el('label', { class: 'chk', style: { marginTop: '4px' } }, [
        el('input', {
          type: 'checkbox',
          checked: this.uniformScale,
          onchange: (e) => {
            this.uniformScale = e.target.checked;
          },
        }),
        '等比缩放',
      ]),
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'btn',
          text: '落板',
          title: '把模型底面贴到热床',
          onclick: () => this.app.dropToBed(object),
        }),
        el('button', {
          class: 'btn',
          text: '居中',
          onclick: () => this.app.centerOnBed(object),
        }),
        el('button', {
          class: 'btn',
          text: '重置',
          title: '清除旋转与缩放',
          onclick: () => {
            this.app.pushHistory();
            this.app._historyLock = true;
            try {
              g.quaternion.identity();
              g.scale.set(1, 1, 1);
              this.afterTransform(object);
              this.app.dropToBed(object);
            } finally {
              this.app._historyLock = false;
            }
          },
        }),
      ]),
      el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn', text: 'X 90°', onclick: () => this.app.rotateBy(object, 'x', 90) }),
        el('button', { class: 'btn', text: 'Y 90°', onclick: () => this.app.rotateBy(object, 'y', 90) }),
        el('button', { class: 'btn', text: 'Z 90°', onclick: () => this.app.rotateBy(object, 'z', 90) }),
      ]),
    ]);
  }

  xyzRow(_tag, onCommit, store, key) {
    const axes = ['X', 'Y', 'Z'];
    const fields = [];
    const wrap = el('div', { class: 'xyz', style: { flex: '1' } });
    axes.forEach((a, i) => {
      const input = numberInput(0, (v) => {
        this.app.pushHistory();
        onCommit(i, v);
      }, { digits: 2 });
      fields.push(input);
      wrap.append(
        el('div', { class: 'xyz-item' }, [
          el('span', { class: `axis axis-${a.toLowerCase()}`, text: a }),
          input,
        ]),
      );
    });
    store[key] = fields;
    return wrap;
  }

  // ---------- 颜色 / 料槽 ----------
  sectionColor(object, part) {
    const project = this.app.project;
    const targets = part ? [part] : object.parts;
    const current = targets.length === 1 ? targets[0].extruder : null;

    const grid = el('div', { class: 'extruder-grid' });
    project.filaments.forEach((f) => {
      grid.append(
        el(
          'button',
          {
            class: `ex-chip${current === f.index ? ' active' : ''}`,
            style: { background: f.color },
            title: `槽位 ${f.index} · ${f.type}`,
            onclick: () => {
              this.app.pushHistory();
              for (const t of targets) {
                t.extruder = f.index;
                t.applyColor(project.filamentColor(f.index));
              }
              this.app.viewer.requestRender();
              this.app.tree.render();
              this.render();
            },
          },
          el('span', { text: String(f.index) }),
        ),
      );
    });

    const hasPaint = object.parts.some((p) => p.triAttrs && p.triAttrs.size);

    return el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-title' }, part ? `零件颜色 · ${part.name}` : '颜色 / 料槽'),
      grid,
      el('div', { class: 'hint' },
        part
          ? '仅修改当前零件的槽位分配'
          : '整体分配：应用到该对象的全部零件。右键对象可展开逐零件设置。'),
      hasPaint
        ? el('div', { class: 'hint warn' }, '该对象含手工上色(MMU)数据，导出时会原样保留。')
        : null,
    ]);
  }

  // ---------- 统计 ----------
  sectionStats(object, part) {
    this.measure(object);
    const doc = this.app.project.docs.get(object.docId);
    const rows = [
      ['来源文件', doc?.name || '-'],
      ['零件数', String(object.parts.length)],
      ['三角面', object.triangleCount.toLocaleString('en-US')],
      ['包围盒', `${fmt(this._size.x, 1)} × ${fmt(this._size.y, 1)} × ${fmt(this._size.z, 1)}`],
    ];
    if (part) rows.push(['当前零件面数', part.triangleCount.toLocaleString('en-US')]);

    const outOfBed = this.app.isOutOfBed(object);
    return el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-title' }, '信息'),
      ...rows.map(([k, v]) =>
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })]),
      ),
      outOfBed ? el('div', { class: 'hint warn' }, '模型超出打印区域，切片时会被拒绝。') : null,
    ]);
  }

  measure(object) {
    object.computeBox(this._box);
    this._box.getSize(this._size);
    this._box.getCenter(this._center);
  }

  afterTransform(object) {
    object.group.updateMatrix();
    object.group.updateMatrixWorld(true);
    this.app.onObjectTransformed(object);
    this.syncValues();
  }

  /** 只刷新数值，不重建 DOM——拖动 gizmo 时每帧都会调用 */
  syncValues() {
    const { object } = this.app.selection;
    if (!object || !this.inputs) return;
    const g = object.group;
    this.measure(object);

    const active = document.activeElement;
    const set = (input, v, d = 2) => {
      if (input !== active) input.value = fmt(v, d);
    };

    set(this.inputs.pos[0], this._center.x);
    set(this.inputs.pos[1], this._center.y);
    set(this.inputs.pos[2], this._box.min.z);

    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
    set(this.inputs.rot[0], e.x * RAD);
    set(this.inputs.rot[1], e.y * RAD);
    set(this.inputs.rot[2], e.z * RAD);

    set(this.inputs.size[0], this._size.x);
    set(this.inputs.size[1], this._size.y);
    set(this.inputs.size[2], this._size.z);

    set(this.inputs.scale[0], g.scale.x * 100, 1);
    set(this.inputs.scale[1], g.scale.y * 100, 1);
    set(this.inputs.scale[2], g.scale.z * 100, 1);
  }
}
