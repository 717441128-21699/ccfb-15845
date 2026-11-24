import { store } from '../state/store';
import { getSimulator } from '../gpu/simulator';
import type { RenderSettings } from '../gpu/GpuSimulator';
import { el, slider, toast, formatMs } from './dom';

export function renderComparePage(root: HTMLElement): void {
  const state = store.get();
  const layout = el('div', { class: 'layout' });
  const left = el('div', { class: 'panel' });
  const right = el('div', { class: 'panel' });

  left.append(el('h2', {}, ['照片比对', el('span', { class: 'tag' }, ['模拟叠加'])]));
  const canvas = el('canvas', {});
  const wrap = el('div', { class: 'canvas-wrap' }, [canvas]);
  left.append(wrap);

  const hint = el('div', { class: 'calib-hint' }, [
    '操作: ① 上传含太阳的天空照片 → ② 在图上点击太阳位置 → ③ 调整角距比例使模拟晕弧与照片重合。',
  ]);
  left.append(hint);

  const timingEl = el('div', { class: 'stat' }, [el('div', { class: 'k' }, ['上次模拟耗时']), el('div', { class: 'v' }, ['—'])]);
  left.append(el('div', { class: 'stat-grid' }, [timingEl]));

  // ---- 右侧 ----
  right.append(el('h2', {}, ['照片与标定']));
  const zone = el('div', { class: 'upload-zone' }, ['点击或拖拽照片到此处上传']);
  const fileInput = el('input', { type: 'file', accept: 'image/*', css: 'display:none' });
  right.append(zone, fileInput);

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
  });

  async function handleFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    const img = el('img', { src: url, alt: '上传照片' });
    zone.innerHTML = '';
    zone.append(img);
    const dataUrl = await fileToDataUrl(file);
    store.update((s) => { s.calibration.photoDataUrl = dataUrl; });
    await refreshOverlay();
    toast('照片已上传, 请点击图中太阳位置标定');
  }

  // 点击太阳标定
  wrap.addEventListener('click', (e) => {
    const rect = wrap.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    store.update((s) => {
      s.calibration.sunU = u;
      s.calibration.sunV = v;
    });
    void refreshOverlay();
  });

  right.append(slider('太阳位置 X', state.calibration.sunU, 0, 1, 0.005, '', (v) => {
    store.update((s) => { s.calibration.sunU = v; });
  }));
  right.append(slider('太阳位置 Y', state.calibration.sunV, 0, 1, 0.005, '', (v) => {
    store.update((s) => { s.calibration.sunV = v; });
  }));
  right.append(slider('角距比例 (px/度)', state.calibration.pxPerDeg, 1, 12, 0.1, '', (v) => {
    store.update((s) => { s.calibration.pxPerDeg = v; });
  }));
  right.append(slider('叠加强度', state.calibration.overlayAlpha, 0.1, 1, 0.05, '', (v) => {
    store.update((s) => { s.calibration.overlayAlpha = v; });
  }));

  const rerunBtn = el('button', { class: 'row' }, ['🔄 用当前冰晶参数重新模拟并叠加']);
  rerunBtn.addEventListener('click', () => void refreshOverlay(true));
  right.append(rerunBtn);

  const tip = el('div', { class: 'calib-hint', css: 'margin-top:14px' }, [
    '比对要点: 22° 晕是距太阳约 22° 的圆环; 幻日是太阳同高度两侧的亮斑; 环天顶弧在天顶附近、太阳高于 32° 时消失。调冰晶占比与摆动, 直到模拟弧与照片重合。',
  ]);
  right.append(tip);

  layout.append(left, right);
  root.append(layout);

  async function refreshOverlay(rerun = false): Promise<void> {
    try {
      const sim = await getSimulator(canvas);
      const s = store.get();
      if (s.calibration.photoDataUrl) {
        const img = await loadImage(s.calibration.photoDataUrl);
        await sim.uploadPhoto(img);
      }
      const settings: RenderSettings = {
        exposure: s.render.exposure,
        gamma: s.render.gamma,
        mode: 'overlay',
        sunU: s.calibration.sunU,
        sunV: s.calibration.sunV,
        pxPerDeg: s.calibration.pxPerDeg,
      };
      const t0 = performance.now();
      if (rerun || !(sim as unknown as { hasRun?: boolean }).hasRun) {
        await sim.runAndRender(s.params, settings);
        (sim as unknown as { hasRun?: boolean }).hasRun = true;
      } else {
        await sim.render(settings);
      }
      timingEl.querySelector('.v')!.textContent = formatMs(performance.now() - t0);
    } catch (err) {
      toast(`叠加失败: ${(err as Error).message}`);
    }
  }

  // 标定滑块变化时只重渲染
  let timer: ReturnType<typeof setTimeout> | undefined;
  store.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void refreshOverlay(), 150);
  });

  if (state.calibration.photoDataUrl) {
    const img = el('img', { src: state.calibration.photoDataUrl });
    zone.innerHTML = '';
    zone.append(img);
  }
  void refreshOverlay();
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
