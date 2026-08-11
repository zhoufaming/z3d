/** 材料槽位面板：颜色即打印时的耗材颜色，导出会写回 project_settings.config */
import { el, clear, toast } from './dom.js';

const TYPES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'Support'];

export function renderFilaments(container, app) {
  const root = clear(container);
  const project = app.project;

  project.filaments.forEach((f, i) => {
    root.append(
      el('div', { class: 'filament' }, [
        el('span', { class: 'idx', text: String(i + 1) }),
        el('input', {
          type: 'color',
          value: f.color,
          // 取色器会连续触发 input，只在打开取色器的那一刻记录一次历史
          onpointerdown: () => app.pushHistory(),
          oninput: (e) => {
            f.color = e.target.value.toUpperCase();
            project.refreshColors();
            app.viewer.requestRender();
            app.tree.render();
            const hex = e.target.parentElement.querySelector('.hex');
            if (hex) hex.textContent = f.color;
          },
        }),
        el(
          'select',
          {
            class: 'ftype',
            onchange: (e) => {
              f.type = e.target.value;
            },
          },
          TYPES.map((t) => el('option', { value: t, selected: t === f.type }, t)),
        ),
        el('span', { class: 'hex', text: f.color }),
      ]),
    );
  });

  root.append(
    el('div', { class: 'row-actions', style: { marginTop: '8px' } }, [
      el('button', {
        class: 'btn',
        text: '+ 槽位',
        onclick: () => {
          project.ensureFilaments(project.filaments.length + 1);
          renderFilaments(container, app);
        },
      }),
      el('button', {
        class: 'btn',
        text: '− 槽位',
        disabled: project.filaments.length <= 1,
        onclick: () => {
          const last = project.filaments.length;
          const used = project.objects.some((o) => o.parts.some((p) => p.extruder === last));
          if (used) {
            toast(`槽位 ${last} 正在被模型使用，无法删除`, 'err');
            return;
          }
          project.filaments.pop();
          renderFilaments(container, app);
        },
      }),
    ]),
  );
}
