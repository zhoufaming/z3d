/** 左侧对象树：按来源文件分组，展示对象与零件层级 */
import { el, clear } from './dom.js';

export class ObjectTree {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.expanded = new Set();
  }

  render() {
    const { project, selection } = this.app;
    const root = clear(this.container);

    if (project.objects.length === 0) {
      root.append(
        el('div', { class: 'tree-empty' }, [
          '还没有加载模型',
          el('br'),
          '点击左上角「导入 3MF」开始',
        ]),
      );
      document.getElementById('obj-count').textContent = '0';
      return;
    }

    document.getElementById('obj-count').textContent = String(project.objects.length);

    // 选中的多零件对象自动展开，让用户知道可以下钻到零件
    if (selection.object && selection.object.parts.length > 1) {
      this.expanded.add(selection.object.uid);
    }

    // 按来源文档分组，方便在多文件组合时分辨模型来自哪个文件
    const byDoc = new Map();
    for (const obj of project.objects) {
      if (!byDoc.has(obj.docId)) byDoc.set(obj.docId, []);
      byDoc.get(obj.docId).push(obj);
    }

    for (const [docId, objects] of byDoc) {
      const doc = project.docs.get(docId);
      if (byDoc.size > 1 || project.docs.size > 1) {
        root.append(el('div', { class: 'tree-doc', title: doc?.name }, doc?.name || docId));
      }

      for (const obj of objects) {
        const isSel = selection.object === obj;
        const expanded = this.expanded.has(obj.uid);
        const multiPart = obj.parts.length > 1;

        const row = el(
          'div',
          {
            class: `tree-row${isSel ? ' selected' : ''}`,
            title: obj.name,
            onclick: (e) => {
              if (e.target.classList.contains('eye')) return;
              this.app.select(obj, null);
            },
            ondblclick: () => this.app.focusObject(obj),
          },
          [
            el('span', {
              class: 'swatch',
              style: { background: project.filamentColor(obj.parts[0]?.extruder ?? 1) },
            }),
            el('span', { class: 'label', text: obj.name }),
            multiPart ? el('span', { class: 'badge', text: `${obj.parts.length}` }) : null,
            el('button', {
              class: 'eye',
              title: obj.group.visible ? '隐藏' : '显示',
              text: obj.group.visible ? '●' : '○',
              onclick: (e) => {
                e.stopPropagation();
                obj.group.visible = !obj.group.visible;
                this.app.viewer.requestRender();
                this.render();
              },
            }),
          ],
        );

        if (multiPart) {
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (expanded) this.expanded.delete(obj.uid);
            else this.expanded.add(obj.uid);
            this.render();
          });
        }
        root.append(row);

        if (multiPart && expanded) {
          for (const part of obj.parts) {
            root.append(
              el(
                'div',
                {
                  class: `tree-row part${selection.part === part ? ' selected' : ''}`,
                  title: part.name,
                  onclick: () => this.app.select(obj, part),
                },
                [
                  el('span', {
                    class: 'swatch',
                    style: { background: project.filamentColor(part.extruder) },
                  }),
                  el('span', { class: 'label', text: part.name }),
                  el('span', { class: 'badge', text: `T${part.extruder}` }),
                ],
              ),
            );
          }
        }
      }
    }
  }
}
