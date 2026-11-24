import { store } from '../state/store';
import { CIRRUS_PRESETS } from '../physics/presets';
import type { CrystalClass, CrystalPopulation } from '../physics/crystal';
import { el, slider, toast } from './dom';

const CLASS_LABEL: Record<CrystalClass, string> = {
  plate: '片状晶 (Plate)',
  column: '柱状晶 (Column)',
  random: '乱序晶 (Random)',
};
const CLASS_HINT: Record<CrystalClass, string> = {
  plate: '水平漂浮, 产生 22° 晕、幻日、环天顶弧',
  column: '水平横转, 产生切弧、22° 晕侧部',
  random: '各向同性, 产生完整 22°/46° 晕环',
};

export function renderParamsPage(root: HTMLElement): void {
  const state = store.get();
  const layout = el('div', { class: 'layout' });
  const left = el('div', { class: 'panel' });
  const right = el('div', { class: 'panel' });

  left.append(el('h2', {}, ['典型卷云冰晶组成(教学预设)']));
  const presetList = el('div', { class: 'preset-list' });
  for (const preset of CIRRUS_PRESETS) {
    const card = el('button', { class: `preset ${preset.id === state.activePresetId ? 'active' : ''}` });
    card.append(el('div', { class: 'name' }, [preset.name]));
    card.append(el('div', { class: 'desc' }, [preset.description]));
    card.addEventListener('click', () => {
      store.setPreset(preset.id);
      toast(`已载入: ${preset.name}`);
    });
    presetList.append(card);
  }
  left.append(presetList);

  right.append(el('h2', {}, ['晶型参数微调']));
  const totalEl = el('div', { class: 'calib-hint' }, ['三类占比会自动归一化处理']);
  right.append(totalEl);

  const classes: CrystalClass[] = ['plate', 'column', 'random'];
  for (const cls of classes) {
    const pop: CrystalPopulation = state.params.populations[cls];
    const row = el('div', { class: 'pop-row' });
    row.append(
      el('div', { class: 'head' }, [
        el('span', { class: 'cls' }, [CLASS_LABEL[cls]]),
      ]),
    );
    row.append(el('div', { css: 'font-size:11px;color:var(--fg-dim);margin-bottom:10px' }, [CLASS_HINT[cls]]));

    row.append(slider('占比', pop.fraction, 0, 1, 0.01, '', (v) => {
      store.setPopulation(cls, { fraction: v });
    }));
    row.append(slider('朝向摆动 σ', pop.tiltSigma, 0, 45, 0.5, '°', (v) => {
      store.setPopulation(cls, { tiltSigma: v });
    }));
    row.append(slider('纵横比 h/(2r)', pop.aspect, 0.05, 4, 0.05, '', (v) => {
      store.setPopulation(cls, { aspect: v });
    }));
    right.append(row);
  }

  const normalizeBtn = el('button', { class: 'row secondary' }, ['归一化三类占比']);
  normalizeBtn.addEventListener('click', () => {
    store.updateParams((p) => {
      const sum = classes.reduce((a, c) => a + p.populations[c].fraction, 0) || 1;
      for (const c of classes) p.populations[c].fraction = +(p.populations[c].fraction / sum).toFixed(3);
    });
    toast('占比已归一化');
  });
  right.append(normalizeBtn);

  layout.append(left, right);
  root.append(layout);

  // 预设选中态随状态更新
  store.subscribe((s) => {
    presetList.querySelectorAll('.preset').forEach((node, i) => {
      node.classList.toggle('active', CIRRUS_PRESETS[i].id === s.activePresetId);
    });
  });
}
