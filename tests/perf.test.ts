import { describe, expect, it } from 'vitest';
import { simulate, plateOnlyParams } from '../src/physics/tracer';

describe('性能基准 (CPU 追踪器)', () => {
  it('百万光线整球模拟可完成并输出天空能量', () => {
    const params = plateOnlyParams({ rays: 1_000_000 });
    const t0 = performance.now();
    const hist = simulate(params);
    const ms = performance.now() - t0;
    let energy = 0;
    for (let i = 0; i < hist.r.length; i++) energy += hist.r[i] + hist.g[i] + hist.b[i];
    // 仅记录耗时, 不设硬性 CI 门槛(机器差异大); WebGPU 路径在浏览器中验证 3 秒指标
    console.log(`CPU 100 万光线耗时: ${ms.toFixed(0)} ms (外推千万光线约 ${(ms * 10 / 1000).toFixed(1)} s)`);
    expect(hist.raysTraced).toBe(1_000_000);
    expect(energy).toBeGreaterThan(0);
  });
});
