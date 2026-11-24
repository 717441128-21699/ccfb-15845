import { store } from '../state/store';
import { getSimulator, getBackend } from '../gpu/simulator';
import type { RenderSettings } from '../gpu/GpuSimulator';
import { el, slider, toast, formatMs, formatRays } from './dom';
import { halo22Radius, parhelionAzimuth, czaCriticalAltitude } from '../physics/analytic';
import { refractiveIndex } from '../physics/ice';
import { halo22Profile, peakPosition } from '../physics/tracer';

export function renderSimPage(root: HTMLElement): void {
  const state = store.get();
  const layout = el('div', { class: 'layout' });
  const left = el('div', { class: 'panel' });
  const right = el('div', { class: 'panel' });

  const canvas = el('canvas', {});
  const wrap = el('div', { class: 'canvas-wrap' }, [canvas]);
  left.append(el('h2', {}, ['天空半球模拟', el('span', { class: 'tag' }, ['天顶等距方位投影']) ]));
  left.append(wrap);

  // 计时与统计
  const statGrid = el('div', { class: 'stat-grid' });
  const statTime = el('div', { class: 'stat' }, [el('div', { class: 'k' }, ['模拟耗时']), el('div', { class: 'v' }, ['—'])]);
  const statRays = el('div', { class: 'stat' }, [el('div', { class: 'k' }, ['光线数量']), el('div', { class: 'v' }, [formatRays(state.params.rays)])]);
  const statBackend = el('div', { class: 'stat' }, [el('div', { class: 'k' }, ['计算后端']), el('div', { class: 'v' }, ['…'])]);
  const statEscape = el('div', { class: 'stat' }, [el('div', { class: 'k' }, ['理论 22° 晕半径']), el('div', { class: 'v' }, [`${halo22Radius(589.3).toFixed(2)}°`])]);
  statGrid.append(statTime, statRays, statBackend, statEscape);
  left.append(statGrid);

  // 物理校验面板
  const validation = el('div', { class: 'validation-list' });
  left.append(el('h2', { css: 'margin-top:18px' }, ['物理自检(CPU 基准)']));
  left.append(validation);

  // ---- 右侧控制 ----
  right.append(el('h2', {}, ['模拟参数']));
  const sunSlider = slider('太阳高度角', state.params.sunAltDeg, 0, 75, 0.5, '°', (v) => {
    store.updateParams((p) => { p.sunAltDeg = v; });
  });
  const raySlider = slider('光线数量', state.params.rays, 50000, 10000000, 50000, '', (v) => {
    store.updateParams((p) => { p.rays = v; });
  });
  const waveSlider = slider('波长分箱(色散)', state.params.wavelengthBins, 4, 48, 1, '', (v) => {
    store.updateParams((p) => { p.wavelengthBins = v; });
  });
  const exposureSlider = slider('曝光', state.render.exposure, 0.2, 5, 0.1, '', (v) => {
    store.update((s) => { s.render.exposure = v; });
  });
  const gammaSlider = slider('伽马', state.render.gamma, 1.2, 3.2, 0.05, '', (v) => {
    store.update((s) => { s.render.gamma = v; });
  });
  right.append(sunSlider, raySlider, waveSlider, exposureSlider, gammaSlider);

  const runBtn = el('button', { class: 'row' }, ['▶ 重新模拟']);
  const benchBtn = el('button', { class: 'secondary' }, ['⏱ 千万光线测速']);
  right.append(el('div', { class: 'btn-row' }, [runBtn, benchBtn]));

  const seedInput = el('input', { type: 'number', value: String(state.params.seed) });
  seedInput.addEventListener('change', () => store.updateParams((p) => { p.seed = Number(seedInput.value) >>> 0; }));
  const seedCtl = el('div', { class: 'control', css: 'margin-top:14px' }, [el('label', {}, ['随机种子']), seedInput]);
  right.append(seedCtl);

  layout.append(left, right);
  root.append(layout);

  let running = false;
  let lastKey = '';

  async function runSimulation(): Promise<void> {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner"></span> 追踪中…';
    try {
      const sim = await getSimulator(canvas);
      const s = store.get();
      const settings: RenderSettings = {
        exposure: s.render.exposure,
        gamma: s.render.gamma,
        mode: 'fisheye',
      };
      const timing = await sim.runAndRender(s.params, settings);
      statTime.querySelector('.v')!.textContent = formatMs(timing.computeMs);
      statRays.querySelector('.v')!.textContent = formatRays(s.params.rays);
      statBackend.querySelector('.v')!.textContent = getBackend() === 'webgpu' ? 'WebGPU' : 'CPU 回退';
      runValidation();
    } catch (err) {
      toast(`模拟失败: ${(err as Error).message}`);
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = '▶ 重新模拟';
    }
  }

  function runValidation(): void {
    validation.innerHTML = '';
    const s = store.get();
    const n = refractiveIndex(589.3);
    const checks: Array<{ label: string; run: () => string }> = [
      {
        label: '22° 晕: 模拟峰半径 vs 最小偏向角公式 (容差 0.3°)',
        run: () => {
          const { bins, binDeg } = halo22Profile(
            { ...s.params, rays: Math.min(s.params.rays, 200000) },
            0.15,
          );
          const sim = peakPosition(bins, binDeg, 18, 26);
          const theory = halo22Radius(550);
          const ok = Math.abs(sim - theory) < 0.3;
          return `${ok ? '✓ 通过' : '✗ 偏差'} 模拟 ${sim.toFixed(2)}° / 理论 ${theory.toFixed(2)}° (Δ ${Math.abs(sim - theory).toFixed(2)}°)`;
        },
      },
      {
        label: '幻日: 方位角距随太阳高度增大 (解析焦散)',
        run: () => {
          const d10 = parhelionAzimuth(10, n);
          const d30 = parhelionAzimuth(30, n);
          const ok = d10 !== null && d30 !== null && d30 > d10;
          return `${ok ? '✓ 通过' : '✗ 异常'} 10°→${d10?.toFixed(1)}°, 30°→${d30?.toFixed(1)}°`;
        },
      },
      {
        label: `环天顶弧临界高度 (应 ≈32.3°, 当前太阳 ${s.params.sunAltDeg}°)`,
        run: () => {
          const crit = czaCriticalAltitude(n);
          const visible = s.params.sunAltDeg < crit;
          return `临界 ${crit.toFixed(2)}° → 当前太阳高度下 CZA ${visible ? '可见' : '已消失(全反射)'}`;
        },
      },
    ];
    for (const c of checks) {
      const row = el('div', { class: 'check run' }, [el('span', { class: 'icon' }, ['…']), el('span', {}, [c.label])]);
      validation.append(row);
      // 异步让出主线程, 避免阻塞渲染
      setTimeout(() => {
        try {
          const text = c.run();
          row.classList.remove('run');
          row.classList.add(text.startsWith('✓') || text.includes('临界') ? 'pass' : 'fail');
          row.querySelector('.icon')!.textContent = text.startsWith('✓') ? '✓' : text.startsWith('✗') ? '✗' : 'ℹ';
          row.append(el('span', { class: 'num' }, [text.replace(/^[✓✗]\s*/, '')]));
        } catch (err) {
          row.classList.add('fail');
          row.querySelector('.icon')!.textContent = '✗';
          row.append(el('span', { class: 'num' }, [(err as Error).message]));
        }
      }, 30);
    }
  }

  runBtn.addEventListener('click', () => void runSimulation());
  benchBtn.addEventListener('click', async () => {
    benchBtn.disabled = true;
    const original = store.get().params.rays;
    store.updateParams((p) => { p.rays = 10000000; });
    toast('开始 1000 万光线测速…', 1500);
    await runSimulation();
    store.updateParams((p) => { p.rays = original; });
    benchBtn.disabled = false;
  });

  // 参数变化自动重跑(防抖)
  let timer: ReturnType<typeof setTimeout> | undefined;
  store.subscribe(() => {
    const s = store.get();
    const key = JSON.stringify([s.params, s.render.exposure, s.render.gamma]);
    if (key === lastKey) return;
    lastKey = key;
    clearTimeout(timer);
    if (!s.render.autoRun) return;
    timer = setTimeout(() => void runSimulation(), 180);
  });

  // 首次运行
  void runSimulation();
}
