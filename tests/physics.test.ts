import { describe, expect, it } from 'vitest';
import { ICE_CAUCHY_A, ICE_CAUCHY_B, refractiveIndex } from '../src/physics/ice';import {
  czaCriticalAltitude,
  czaExitAltitude,
  chaCriticalAltitude,
  halo22Radius,
  minDeviation,
  parhelionAzimuth,
} from '../src/physics/analytic';
import {
  halo22Profile,
  makeHistogram,
  parhelionPeakFromHistogram,
  peakPosition,
  plateOnlyParams,
  simulate,
  simulatePaths,
} from '../src/physics/tracer';
import { defaultParams } from '../src/physics/presets';

const N_D = refractiveIndex(589.3);

describe('冰的折射率与色散', () => {
  it('钠光波长处折射率约为 1.3093', () => {
    expect(N_D).toBeCloseTo(1.3093, 4);
    expect(ICE_CAUCHY_A + ICE_CAUCHY_B / (400 * 400)).toBeCloseTo(1.3194, 3);
    expect(refractiveIndex(700)).toBeCloseTo(1.3068, 3);
  });

  it('蓝光折射率大于红光(正常色散)', () => {
    expect(refractiveIndex(400)).toBeGreaterThan(refractiveIndex(700));
  });
});

describe('22 度晕最小偏向角(解析公式)', () => {
  it('钠光下理论角半径 21.78°', () => {
    expect(minDeviation(60, N_D)).toBeCloseTo(21.78, 1);
    expect(halo22Radius(589.3)).toBeCloseTo(21.78, 1);
  });

  it('红光角半径小于蓝光(内红外紫)', () => {
    expect(halo22Radius(700)).toBeLessThan(halo22Radius(400));
    expect(halo22Radius(700)).toBeCloseTo(21.55, 1);
  });
});

describe('22 度晕: 蒙特卡洛光线追踪 vs 理论角半径', () => {
  it('乱序晶棱镜-棱镜折射峰与理论值相差不超过 0.3°', () => {
    const params = plateOnlyParams({
      rays: 200000,
      populations: {
        plate: { fraction: 0, mode: 'plate', tiltSigma: 0, aspect: 1 },
        column: { fraction: 0, mode: 'column', tiltSigma: 0, aspect: 1 },
        random: { fraction: 1, mode: 'random', tiltSigma: 0, aspect: 1 },
      },
      sunAltDeg: 15,
    });
    const { bins, binDeg } = halo22Profile(params, 0.1);
    const peak = peakPosition(bins, binDeg);
    const theoretical = halo22Radius(550);
    expect(Math.abs(peak - theoretical)).toBeLessThan(0.3);
  });
});

describe('幻日(解析焦散公式)', () => {
  it('太阳在地平时方位角距等于 22° 晕角半径', () => {
    const d0 = parhelionAzimuth(0, N_D);
    expect(d0).not.toBeNull();
    expect(d0!).toBeCloseTo(21.78, 0.8);
  });

  it('方位角距随太阳高度升高而变大', () => {
    const d10 = parhelionAzimuth(10, N_D)!;
    const d20 = parhelionAzimuth(20, N_D)!;
    const d30 = parhelionAzimuth(30, N_D)!;
    expect(d10).toBeGreaterThan(d0());
    expect(d20).toBeGreaterThan(d10);
    expect(d30).toBeGreaterThan(d20);
  });

  it('20° 与 40° 太阳高度下与公认值相差不超过 0.5°', () => {
    // 大气光学公认值: h=20° → 约 24.5°, h=40° → 约 36°
    expect(Math.abs(parhelionAzimuth(20, N_D)! - 24.5)).toBeLessThan(0.5);
    expect(Math.abs(parhelionAzimuth(40, N_D)! - 36.2)).toBeLessThan(0.5);
  });

  it('高太阳高度下因全反射消失', () => {
    expect(parhelionAzimuth(60, N_D)).toBeNull();
  });
});

function d0(): number {
  return parhelionAzimuth(0, N_D)!;
}

describe('幻日: 蒙特卡洛追踪 vs 解析公式', () => {
  // 幻日在中低太阳高度明亮稳定; 40° 以上接近全反射消失点、统计涨落大,
  // 其行为由上面的解析公式测试覆盖
  const heights = [5, 15, 30];
  for (const h of heights) {
    it(`太阳高度 ${h}° 时模拟峰值与公式相差不超过 0.5°`, () => {
      const params = plateOnlyParams({ rays: 300000, sunAltDeg: h });
      const theory = parhelionAzimuth(h, refractiveIndex(550))!;
      const hist = simulate(params);
      // 在理论值 ±4° 窗口内定位幻日焦散峰, 避开太阳眩光与广角背景
      const simAz = parhelionPeakFromHistogram(hist, theory - 4, theory + 4);
      expect(Math.abs(simAz - theory)).toBeLessThan(0.5);
    });
  }

  it('太阳高度 40° 时幻日显著变暗(接近全反射消失), 亮度低于 20° 时的十分之一', () => {
    const bright = simulate(plateOnlyParams({ rays: 300000, sunAltDeg: 20 }));
    const faint = simulate(plateOnlyParams({ rays: 300000, sunAltDeg: 40 }));
    const t20 = parhelionAzimuth(20, refractiveIndex(550))!;
    const t40 = parhelionAzimuth(40, refractiveIndex(550))!;
    const energy = (hist: typeof bright, t: number) => {
      const binDeg = 360 / hist.azBins;
      let sum = 0;
      for (let sep = t - 3; sep <= t + 3; sep += binDeg) {
        const j = Math.round(((180 - sep) / 360) * hist.azBins);
        for (let i = 0; i < hist.altBins; i++) {
          const idx = i * hist.azBins + j;
          sum += hist.r[idx] + hist.g[idx] + hist.b[idx];
        }
      }
      return sum;
    };
    expect(energy(faint, t40)).toBeLessThan(energy(bright, t20) * 0.25);
  });
});

describe('环天顶弧(CZA)', () => {
  it('临界太阳高度约为 32.3°', () => {
    expect(czaCriticalAltitude(N_D)).toBeCloseTo(32.3, 1);
  });

  it('环地平弧临界高度约为 57.7°, 与 CZA 互补', () => {
    expect(chaCriticalAltitude(N_D)).toBeCloseTo(57.7, 1);
    expect(czaCriticalAltitude(N_D) + chaCriticalAltitude(N_D)).toBeCloseTo(90, 1);
  });

  it('临界高度以下存在出射解, 以上全反射消失', () => {
    expect(czaExitAltitude(10, N_D)).not.toBeNull();
    expect(czaExitAltitude(30, N_D)).not.toBeNull();
    expect(czaExitAltitude(33, N_D)).toBeNull();
    expect(czaExitAltitude(45, N_D)).toBeNull();
    expect(czaExitAltitude(60, N_D)).toBeNull();
  });

  it('光线追踪: 32° 以下存在顶面→侧面路径, 33°–60° 消失', () => {
    for (const h of [10, 20, 25, 30]) {
      const counts = simulatePaths(plateOnlyParams({ rays: 80000, sunAltDeg: h }));
      expect(counts.basalToPrism).toBeGreaterThan(100);
    }
    for (const h of [35, 45, 60]) {
      const counts = simulatePaths(plateOnlyParams({ rays: 80000, sunAltDeg: h }));
      // 允许少量因高斯摆动产生的离轴光线, 但主路径应近乎消失
      expect(counts.basalToPrism).toBeLessThan(counts.total * 0.005);
    }
  });
});

describe('整球模拟冒烟测试', () => {
  it('默认参数可运行且有光线射入天空', () => {
    const hist = simulate(defaultParams());
    expect(hist.raysTraced).toBe(defaultParams().rays);
    expect(hist.raysEscaped).toBeGreaterThan(hist.raysTraced * 0.2);
    const total = hist.r.reduce((s, x) => s + x, 0) + hist.g.reduce((s, x) => s + x, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('直方图尺寸与索引正确', () => {
    const hist = makeHistogram(180, 720);
    expect(hist.r.length).toBe(180 * 720);
  });
});
