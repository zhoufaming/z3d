# z3d · Bambu 3MF Studio

一个用于**修改拓竹（Bambu Lab）3MF 项目文件**的桌面编辑器。支持预览模型、修改形状大小与颜色、同时打开多个 3MF 进行组合、并导出能被 Bambu Studio 正常打开的 3MF 文件（保留全部拓竹私有元数据）。

界面参考 Bambu Studio 布局，使用绿色主题。

---

## 功能特性

- **多文件预览**：同时导入多个 3MF 文件，左侧对象树按来源文件分组展示
- **3D 预览**：Three.js WebGL 渲染，Z-up 坐标系（与切片器一致），按需渲染（静止时 GPU 零占用）
- **形状编辑**：移动 / 旋转 / 缩放，支持整体缩放联动与按轴尺寸修改
- **颜色编辑**：整体换色 + 按零件分色，映射到拓竹料槽 `filament_id`；料槽颜色可自由编辑、增删
- **新建基础形状**：无需导入文件，可直接创建立方体 / 圆柱体 / 球体 / 圆锥 / 棱锥 / 圆环，自动落板居中，可导出为 3MF
- **多文件组合**：导入的模型并入同一场景，自动排列避免重叠
- **保真导出**：以首个导入文档为模板重写几何与配置，其余 ZIP 条目原样保留 —— Bambu Studio 可正常打开
- **撤销 / 重做**：轻量快照（几何共享引用，仅存变换 / 名称 / 料槽），`Ctrl+Z` / `Ctrl+Shift+Z`
- **桌面套壳**：Electron 内置 HTTP 服务托管构建产物，提供原生「打开 / 追加 / 导出」菜单

---

## 技术架构

```
3MF (ZIP)
  ├─ 3D/3dmodel.model        主模型（build / object / components）
  ├─ 3D/Objects/object_N.model  拆分几何（mesh）
  └─ Metadata/
       ├─ model_settings.config     拓竹私有：料槽 / 对象设置
       └─ project_settings.config   拓竹私有：热床 / 打印机预设
```

| 层 | 技术 | 说明 |
|---|---|---|
| 解析层 | 字符级扫描 + `TypedArray` | 不依赖 DOMParser，百万面模型不吃内存，解析性能不受 DOM 影响 |
| 导出层 | `fflate` ZIP 重写 | 保留原始私有元数据，仅替换几何 / 配置条目 |
| 视图层 | Three.js | Z-up、OrbitControls、TransformControls、选中框、变换 gizmo |
| UI 层 | 原生 DOM + 浅色 Bambu 主题 | 对象树 / 属性面板 / 料槽 / 右侧工具栏 |
| 套壳层 | Electron (CJS 主进程) | 内置 HTTP 服务 + 原生菜单，零双份逻辑 |

**关键实现决策**

- 3MF 的 4×3 transform 是行主序行向量约定，与 Three.js 列主序之间自动转置
- 多文件组合以第一个文档为基底，追加对象并默认自动排列避免重叠
- 撤销重做用全量状态快照，几何共享引用以节省内存

---

## 快速开始

### 环境要求

- Node.js ≥ 18
- 操作系统：Windows / macOS / Linux（Electron 套壳跨平台）

### 安装依赖

```bash
cd bambu3mf-studio
npm install
```

### 开发模式（浏览器）

```bash
npm run dev
# 打开 http://localhost:5180/
```

### 构建生产包

```bash
npm run build          # 产物输出到 dist/
```

### 桌面应用（Electron）

```bash
npm run electron       # 先 build，再启动 Electron 套壳
# 或一步到位：
npm run electron:build
```

> 无 GPU / 远程桌面等环境中若 Electron 启动失败，可强制软件渲染：
> ```bash
> set BAMBU_ELECTRON_DISABLE_GPU=1   # Windows
> npm run electron
> ```

---

## 使用说明

1. **导入 / 新建**：
   - 点击左上角「导入 3MF」选择 `.3mf` 文件
   - 点击「新建模型」选择基础形状（立方体 / 圆柱体 / 球体 / 圆锥 / 棱锥 / 圆环），从零开始建模
   - 「追加合并」可继续叠加其它 3MF
2. **选中**：在左侧对象树单击对象；多零件对象可下钻到零件；支持显示 / 隐藏
3. **编辑**：
   - 顶部工具栏切换 **移动 / 旋转 / 缩放** 模式，场景中拖拽 gizmo
   - 右侧属性面板精确输入 **位置 / 旋转 / 尺寸 / 缩放**
   - 快捷键：落板、居中、复制（`Ctrl+D`）、自动排列、删除
4. **改色**：右侧属性面板「颜色 / 料槽」区选择料槽并改色；料槽与拓竹 `filament_id` 对应
5. **导出**：点击「导出 3MF」，下载的 `.3mf` 可直接用 Bambu Studio 打开

---

## npm 脚本

| 脚本 | 作用 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 构建生产包到 `dist/` |
| `npm run preview` | 预览生产构建 |
| `npm run sample` | 生成样例 3MF（`samples/`） |
| `npm run test` | 生成样例 + 运行端到端回归测试（约 90 项） |
| `npm run electron` | 启动 Electron 套壳（需先 build） |
| `npm run electron:build` | build + 启动 Electron 套壳 |

---

## 测试

```bash
npm test
```

`tools/test-roundtrip.mjs` 覆盖读 → 改 → 写 → 再读的多项断言：几何无损、transform 往返一致、料槽颜色保持、组合件零件偏移保持、三角面总数无损，以及新建基础形状导出回读等。

导出文件可用 `tools/verify-export.mjs` 单独回读校验：

```bash
node tools/verify-export.mjs path/to/exported.3mf
```

---

## 项目结构

```
bambu3mf-studio/
├─ index.html                 # UI 骨架（顶栏 / 对象树 / 视口 / 属性 / 状态栏）
├─ src/
│  ├─ main.js                 # 主控 App：工具栏 / 键盘 / 导入 / 编辑 / 导出
│  ├─ style.css               # Bambu 风格主题
│  ├─ core/                   # 解析 / 导出 / 历史 / 项目模型
│  │  ├─ threemf/             # archive / model-parser / bambu-config / reader / writer
│  │  ├─ fast-scan.js        # 高性能字符级 XML 扫描
│  │  ├─ project.js          # Project / SceneObject / ScenePart
│  │  └─ history.js          # 撤销 / 重做
│  ├─ viewer/                 # viewer.js（Three.js 渲染）/ plate.js（热床）
│  └─ ui/                     # tree / inspector / filaments / dom
├─ electron/
│  ├─ main.cjs                # CJS 主进程：HTTP 服务 + BrowserWindow + 原生菜单
│  └─ launch.cjs              # 启动器：处理 ELECTRON_RUN_AS_NODE 退化 + 安全标志
└─ tools/                     # make-sample / test-roundtrip / verify-export
```

---

## 常见问题

**Q：Electron 启动报 `app is not a function` / GPU process 崩溃？**
A：本机若被全局注入 `ELECTRON_RUN_AS_NODE=1`，会让 electron 退化成 node。本项目 `electron/launch.cjs` 已自动清除该变量；无 GPU 环境再设 `BAMBU_ELECTRON_DISABLE_GPU=1` 强制软件渲染。

**Q：导出文件在 Bambu Studio 打不开？**
A：本编辑器以首个导入文档为模板保真导出，理论上完全兼容。若遇异常，多半是源文件本身私有字段异常，可反馈具体文件。

**Q：导入超大模型会卡吗？**
A：解析层用字符级扫描 + TypedArray，不生成大量 DOM 节点；按需渲染只在场景变化时绘制。极大量级模型仍建议分文件处理。

---

## 路线图

- [ ] 装配体层级编辑与嵌套组合
- [ ] 切割 / 布尔运算
- [ ] 支撑与切片预览
- [ ] 安装包分发（`electron-builder`）
- [ ] 多语言（中英切换）

---

## License

内部工具，按需使用。
