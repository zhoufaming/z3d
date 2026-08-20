/**
 * AI 控制桥（Command Bridge）
 * ------------------------------------------------------------------
 * 把 App 现有的所有模型编辑操作封装成「可被 JSON 命令驱动」的高层接口，
 * 供外部 AI 代理 / 脚本自动操控软件修改模型。设计为可自定义开启（opt-in），
 * 不依赖任何云端服务：默认用内置的确定性自然语言解析器（parseInstruction），
 * 也可由外部 LLM 先把自然语言翻成命令 JSON 再下发。
 *
 * 设计要点：
 *  - 纯逻辑，只依赖传入的 `app` 实例（App 的方法已包含历史/刷新/提示）；
 *  - run() 返回结构化 `{ ok, cmd, result }` 或 `{ ok:false, error }`，便于机器读取；
 *  - 所有命令的「目标对象」都按名字 / 序号解析，调用 applySelectionSet 选中后再执行；
 *  - 文件 IO（导出/导入）走可选的 fsAdapter（由 main 进程经 preload 注入），
 *    无 adapter 时仍返回 base64，便于调用方自行落盘。
 */
import * as THREE from 'three';

const round = (n) => Math.round((n ?? 0) * 1000) / 1000;

/** 命令清单（用于 help / 发现） */
export const COMMAND_DOCS = {
  scene: '查询当前场景：对象列表（名称/尺寸/位置/三角面数）、热床、当前热床索引。',
  select: '选中对象。args: { targets: [名字或序号...] }',
  create: '新建基础形状。args: { shape: cube|cylinder|sphere|cone|pyramid|torus, name? }',
  delete: '删除选中对象。args: { targets? }',
  duplicate: '复制选中对象。args: { targets? }',
  boolean: '布尔运算。args: { op: union|difference|intersection, targets: [A, B] }（差集为 A−B）',
  repair: '网格修复（焊接/封洞/剔除退化）。args: { targets? }（缺省为当前热床全部）',
  mirror: '镜像。args: { axis: x|y|z, targets? }',
  array: '阵列。args: { count, axis, spacing?, targets? }',
  merge: '合并多个对象为单一几何。args: { targets: [...] }',
  base: '为对象生成底座。args: { targets? }（缺省为当前热床全部）',
  rotate: '旋转。args: { axis, degrees, targets? }',
  move: '移动（设置本地坐标）。args: { x?, y?, z?, targets? }',
  center: '居中到热床中心。args: { targets? }',
  drop: '落到热床（底面贴 z=0）。args: { targets? }',
  setColor: '改色。args: { color: "#rrggbb", targets }',
  split: '按连通体拆分。args: { grid?, addBase?, targets? }',
  cut: '平面切割。args: { axis, dist, cap?, grid?, addBase?, targets? }',
  arrange: '把所有对象重新摆到热床避免重叠。',
  export3mf: '导出当前工程为 3MF。args: { path? }（有 fsAdapter 时落盘，并返回 base64）',
  import3mf: '导入 3MF。args: { path | base64, name? }（需 fsAdapter 才能用 path）',
  undo: '撤销',
  redo: '重做',
  help: '返回本清单',
};

export class CommandBridge {
  /**
   * @param {object} app  App 实例
   * @param {object} [fsAdapter]  { writeFile(path, base64), readFile(path)->base64 }
   */
  constructor(app, fsAdapter = null) {
    this.app = app;
    this.fs = fsAdapter;
  }

  // ---------------------------------------------------------------- 查询
  cmdScene() {
    const proj = this.app.project;
    return {
      activePlate: proj.activePlate,
      plates: (proj.plates || []).map((p) => ({ id: p.id, name: p.name })),
      objects: proj.objects.map((o) => {
        const b = o.computeBox(new THREE.Box3());
        const size = b.getSize(new THREE.Vector3());
        return {
          id: o.id,
          name: o.name,
          plateId: o.plateId,
          visible: o.userVisible !== false,
          printable: o.printable,
          tris: o.triangleCount,
          position: [round(b.min.x), round(b.min.y), round(b.min.z)],
          size: [round(size.x), round(size.y), round(size.z)],
        };
      }),
    };
  }

  cmdHelp() {
    return COMMAND_DOCS;
  }

  // ---------------------------------------------------------------- 选择解析
  /** 按名字（子串）/ 序号解析对象，保持输入顺序 */
  _resolve(names) {
    const list = this.app.project.objects;
    const out = [];
    for (const n of names) {
      let o = null;
      if (typeof n === 'number') o = list.find((x) => x.id === n);
      else {
        const s = String(n);
        o = list.find((x) => x.name === s) || list.find((x) => x.name.includes(s));
      }
      if (o) out.push(o);
    }
    return out;
  }

  _select(names) {
    const arr = Array.isArray(names) ? names : [names];
    const objs = this._resolve(arr);
    if (!objs.length) throw new Error(`未找到对象：${JSON.stringify(names)}`);
    this.app.applySelectionSet(new Set(objs));
    return objs;
  }

  cmdSelect(args) {
    const objs = this._select(args.targets);
    return { selected: objs.map((o) => o.name) };
  }

  // ---------------------------------------------------------------- 基础编辑
  cmdCreate(args) {
    const shape = args.shape;
    if (!shape) throw new Error('create 需要 shape');
    this.app.createPrimitive(shape);
    const obj = this.app.selection?.object;
    if (args.name && obj) {
      obj.name = args.name;
      if (this.app.tree) this.app.tree.render();
    }
    return { created: obj?.name, id: obj?.id };
  }

  cmdDelete(args) {
    const objs = this._select(args.targets);
    this.app.deleteSelected();
    return { deleted: objs.map((o) => o.name) };
  }

  cmdDuplicate(args) {
    const objs = this._select(args.targets);
    this.app.duplicateSelected();
    return { duplicated: objs.map((o) => o.name) };
  }

  // ---------------------------------------------------------------- 复合运算
  cmdBoolean(args) {
    const op = args.op;
    if (!['union', 'difference', 'intersection'].includes(op)) {
      throw new Error('boolean.op 必须是 union/difference/intersection');
    }
    const objs = this._select(args.targets);
    if (objs.length !== 2) throw new Error('boolean 需要恰好 2 个对象（targets 给 2 个）');
    this.app.booleanSelected(op);
    return { result: this.app.selection?.object?.name };
  }

  cmdRepair(args) {
    if (args.targets) this._select(args.targets);
    else this.app.selectAll();
    this.app.repairSelected();
    return { repaired: (args.targets || this.app.project.activeObjects().map((o) => o.name)) };
  }

  cmdMirror(args) {
    const objs = this._select(args.targets);
    this.app.mirrorSelected(args.axis || 'x');
    return { mirrored: objs.map((o) => o.name), axis: args.axis || 'x' };
  }

  cmdArray(args) {
    const objs = this._select(args.targets);
    this.app.arraySelected({
      count: args.count || 2,
      axis: args.axis || 'x',
      spacing: args.spacing,
    });
    return { templated: objs.map((o) => o.name) };
  }

  cmdMerge(args) {
    const objs = this._select(args.targets);
    if (objs.length < 2) throw new Error('merge 需要至少 2 个对象');
    this.app.mergeSelected();
    return { merged: objs.map((o) => o.name), result: this.app.selection?.object?.name };
  }

  cmdBase(args) {
    if (args.targets) this._select(args.targets);
    else this.app.selectAll();
    this.app.autoBase();
    return { based: (args.targets || this.app.project.activeObjects().map((o) => o.name)) };
  }

  // ---------------------------------------------------------------- 变换
  cmdRotate(args) {
    const objs = this._select(args.targets);
    for (const o of objs) this.app.rotateBy(o, args.axis || 'z', args.degrees ?? 90);
    return { rotated: objs.map((o) => o.name), axis: args.axis || 'z', degrees: args.degrees ?? 90 };
  }

  cmdMove(args) {
    const objs = this._select(args.targets);
    for (const o of objs) {
      if (args.x != null) o.group.position.x = args.x;
      if (args.y != null) o.group.position.y = args.y;
      if (args.z != null) o.group.position.z = args.z;
      o.group.updateMatrixWorld(true);
    }
    this.app.refreshAll();
    return { moved: objs.map((o) => o.name), to: { x: args.x, y: args.y, z: args.z } };
  }

  cmdCenter(args) {
    const objs = this._select(args.targets);
    for (const o of objs) this.app.centerOnBed(o);
    return { centered: objs.map((o) => o.name) };
  }

  cmdDrop(args) {
    const objs = this._select(args.targets);
    for (const o of objs) this.app.dropToBed(o);
    return { dropped: objs.map((o) => o.name) };
  }

  cmdSetColor(args) {
    if (!args.color) throw new Error('setColor 需要 color (#rrggbb)');
    const objs = this._select(args.targets);
    for (const o of objs) for (const p of o.parts) p.applyColor(args.color);
    this.app.refreshAll();
    return { colored: objs.map((o) => o.name), color: args.color };
  }

  // ---------------------------------------------------------------- 拆件
  cmdSplit(args) {
    const objs = this._select(args.targets);
    this.app.splitSelected(args.grid ?? false, args.addBase ?? false, {});
    return { split: objs.map((o) => o.name) };
  }

  cmdCut(args) {
    const objs = this._select(args.targets);
    this.app.cutSelected(
      args.axis || 'z',
      args.dist ?? 0,
      args.cap ?? true,
      args.grid ?? false,
      args.addBase ?? false,
    );
    return { cut: objs.map((o) => o.name) };
  }

  // ---------------------------------------------------------------- 整理 / 历史
  cmdArrange() {
    this.app.arrangeAll();
    return { arranged: true };
  }

  cmdUndo() { this.app.undo(); return { undone: true }; }
  cmdRedo() { this.app.redo(); return { redone: true }; }

  // ---------------------------------------------------------------- 导入 / 导出
  async cmdExport3mf(args) {
    const { base64, name } = await this.app.export3mfBuffer();
    if (args.path && this.fs) {
      await this.fs.writeFile(args.path, base64);
      return { path: args.path, name, bytes: Math.round((base64.length * 3) / 4) };
    }
    return { name, base64, note: '未提供 fsAdapter 或 path，仅返回 base64' };
  }

  async cmdImport3mf(args) {
    let base64 = args.base64;
    if (!base64 && args.path && this.fs) base64 = await this.fs.readFile(args.path);
    if (!base64) throw new Error('import3mf 需要 base64 或（带 fsAdapter 的）path');
    const name = args.name || 'imported.3mf';
    await this.app.import3mfBuffer(base64, name);
    return { imported: name, objects: this.app.project.objects.length };
  }

  // ---------------------------------------------------------------- 调度
  async run(command) {
    try {
      const { cmd, args = {} } = command || {};
      const fn = cmd && this[`cmd${cmd.charAt(0).toUpperCase()}${cmd.slice(1)}`];
      if (typeof fn !== 'function') throw new Error(`未知命令：${cmd}`);
      const result = await fn.call(this, args);
      return { ok: true, cmd, result };
    } catch (err) {
      return { ok: false, cmd: command && command.cmd, error: String((err && err.message) || err) };
    }
  }

  /** 执行一个命令计划（数组）。逐条执行，任一条失败则收集错误并继续 */
  async runPlan(plan) {
    const out = [];
    for (const c of plan) out.push(await this.run(c));
    return out;
  }
}

// ==================================================================
// 确定性自然语言 → 命令计划 解析器（离线可用，无需联网 / API key）
// ==================================================================

function detectAxis(text) {
  if (/x轴|\bx\b|横|左右|水平|宽/.test(text)) return 'x';
  if (/y轴|\by\b|纵|前后|深/.test(text)) return 'y';
  if (/z轴|\bz\b|竖|上下|垂直|高度|立|高/.test(text)) return 'z';
  return 'z';
}
function detectCount(text) {
  const m = text.match(/(\d+)\s*(个|份|块|排|列)/);
  return m ? parseInt(m[1], 10) : 2;
}
function detectDegrees(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(度|°)/);
  return m ? parseFloat(m[1]) : 90;
}
const COLOR_MAP = {
  红: '#ff3b30', 绿: '#34c759', 蓝: '#0a84ff', 黄: '#ffcc00',
  橙: '#ff9500', 紫: '#af52de', 白: '#ffffff', 黑: '#1c1c1e', 灰: '#8e8e93',
  青: '#5ac8fa', 粉: '#ff2d55',
};
function detectColor(text) {
  for (const k of Object.keys(COLOR_MAP)) if (text.includes(k)) return COLOR_MAP[k];
  return null;
}
const SHAPE_MAP = {
  立方体: 'cube', 方块: 'cube', 长方: 'cube',
  圆柱: 'cylinder', 圆桶: 'cylinder',
  球体: 'sphere', 球: 'sphere',
  圆锥: 'cone', 锥: 'cone',
  棱锥: 'pyramid', 金字塔: 'pyramid',
  圆环: 'torus', 环: 'torus',
};
function detectShape(text) {
  for (const k of Object.keys(SHAPE_MAP)) if (text.includes(k)) return SHAPE_MAP[k];
  return null;
}
function detectTargets(text, scene) {
  const found = (scene.objects || []).filter((o) => text.includes(o.name)).map((o) => o.name);
  if (found.length) return found;
  if (/全部|所有|all|every|都/.test(text)) return (scene.objects || []).map((o) => o.name);
  return [];
}

/**
 * 把一句自然语言指令翻译成命令计划。
 * @param {string} text 指令文本
 * @param {object} scene cmdScene() 的返回（用于解析对象名）
 * @returns {{ plan: object[], error?: string }}
 */
export function parseInstruction(text, scene) {
  const t = (text || '').toLowerCase();
  const targets = detectTargets(text, scene);
  const plan = [];

  if (/并集|union|相加/.test(t) && targets.length >= 2) {
    plan.push({ cmd: 'boolean', args: { op: 'union', targets: [targets[0], targets[1]] } });
  } else if (/差集|减去|挖去|挖掉|difference|subtract|minus/.test(t) && targets.length >= 2) {
    plan.push({ cmd: 'boolean', args: { op: 'difference', targets: [targets[0], targets[1]] } });
  } else if (/交集|相交|intersect|共有|共同/.test(t) && targets.length >= 2) {
    plan.push({ cmd: 'boolean', args: { op: 'intersection', targets: [targets[0], targets[1]] } });
  } else if (/修复|repair|修整|补洞|焊接|封洞|重整/.test(t)) {
    plan.push({ cmd: 'repair', args: targets.length ? { targets } : {} });
  } else if (/镜像|mirror|对称|翻转/.test(t)) {
    plan.push({ cmd: 'mirror', args: { axis: detectAxis(text), targets: targets.length ? targets : undefined } });
  } else if (/阵列|array|排成|复制成|排布/.test(t)) {
    plan.push({ cmd: 'array', args: { count: detectCount(text), axis: detectAxis(text), targets: targets.length ? targets : undefined } });
  } else if (/合并|merge|组合|融合/.test(t) && targets.length >= 2) {
    plan.push({ cmd: 'merge', args: { targets } });
  } else if (/底座|基座|底板|base|支撑/.test(t)) {
    plan.push({ cmd: 'base', args: targets.length ? { targets } : {} });
  } else if (/旋转|rotate/.test(t) && targets.length) {
    plan.push({ cmd: 'rotate', args: { axis: detectAxis(text), degrees: detectDegrees(text), targets } });
  } else if (/删除|delete|移除|删掉/.test(t) && targets.length) {
    plan.push({ cmd: 'delete', args: { targets } });
  } else if (/新建|创建|create|加一个|生成一个/.test(t)) {
    const shape = detectShape(text);
    if (shape) plan.push({ cmd: 'create', args: { shape } });
    else return { plan: [], error: '未识别到形状（cube/cylinder/sphere/cone/pyramid/torus）' };
  } else if (/颜色|变成|涂成|color|染成|染/.test(t) && targets.length) {
    const c = detectColor(text);
    if (c) plan.push({ cmd: 'setColor', args: { color: c, targets } });
    else return { plan: [], error: '未识别到颜色' };
  } else if (/排列|整理|布局|arrange/.test(t)) {
    plan.push({ cmd: 'arrange', args: {} });
  } else {
    return { plan: [], error: '无法识别指令，请改用 JSON 命令或参考 help' };
  }
  return { plan };
}
