import './styles.css';
import { renderSimPage } from './ui/simPage';
import { renderParamsPage } from './ui/paramsPage';
import { renderComparePage } from './ui/comparePage';
import { renderCatalogPage } from './ui/catalogPage';
import { GpuSimulator } from './gpu/GpuSimulator';

const page = document.getElementById('page')!;
const tabs = document.getElementById('tabs')!;
const gpuStatus = document.getElementById('gpu-status')!;

const routes: Record<string, (root: HTMLElement) => void> = {
  '/sim': renderSimPage,
  '/params': renderParamsPage,
  '/compare': renderComparePage,
  '/catalog': renderCatalogPage,
};

function currentRoute(): string {
  const hash = location.hash.replace('#', '') || '/sim';
  return routes[hash] ? hash : '/sim';
}

function render(): void {
  const route = currentRoute();
  page.innerHTML = '';
  tabs.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', (a as HTMLAnchorElement).dataset.tab === route.slice(1));
  });
  routes[route](page);
}

window.addEventListener('hashchange', render);

async function detectGpu(): Promise<void> {
  if (!GpuSimulator.isSupported()) {
    gpuStatus.innerHTML = '<span style="color:var(--warm)">当前浏览器不支持 WebGPU, 已启用 CPU 回退(光线数受限)</span>';
    return;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    gpuStatus.innerHTML = '<span style="color:var(--good)">WebGPU 可用 · 计算着色器加速光线追踪</span>';
  } catch {
    gpuStatus.innerHTML = '<span style="color:var(--warm)">WebGPU 适配器不可用, 已启用 CPU 回退</span>';
  }
}

void detectGpu();
if (!location.hash) location.hash = '#/sim';
render();

// 暴露给控制台调试
declare global {
  interface Window { iceHaloVersion: string }
}
window.iceHaloVersion = '1.0.0';
