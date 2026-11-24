import { GpuSimulator } from './GpuSimulator';
import { CpuSimulator } from './CpuSimulator';

export type AnySimulator = GpuSimulator | CpuSimulator;

let instance: AnySimulator | null = null;
let backend: 'webgpu' | 'cpu' = 'cpu';

export function getBackend(): 'webgpu' | 'cpu' {
  return backend;
}

/** 获取或创建模拟器单例(优先 WebGPU, 不可用回退 CPU); 每次调用重新绑定当前画布 */
export async function getSimulator(canvas: HTMLCanvasElement): Promise<AnySimulator> {
  if (instance) {
    instance.attach(canvas);
    return instance;
  }
  if (GpuSimulator.isSupported()) {
    try {
      const gpu = new GpuSimulator();
      await gpu.init(canvas);
      instance = gpu;
      backend = 'webgpu';
      return gpu;
    } catch (err) {
      console.warn('WebGPU 初始化失败, 回退 CPU:', err);
    }
  }
  const cpu = new CpuSimulator();
  await cpu.init(canvas);
  instance = cpu;
  backend = 'cpu';
  return cpu;
}

export function resetSimulator(): void {
  instance?.destroy();
  instance = null;
}

export function isGpu(sim: AnySimulator): sim is GpuSimulator {
  return sim instanceof GpuSimulator;
}
