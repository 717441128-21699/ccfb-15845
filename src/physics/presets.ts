import { CrystalPopulation, SimParams } from './crystal';

/**
 * 几类典型卷云的冰晶组成(依据大气光学观测的常见配比整理的教学预设,
 * 具体数值为本工具设定, 非某一次实测)。
 *
 * 片状晶水平漂浮 → 22 度晕、幻日、环天顶弧;
 * 柱状晶水平横转 → 切弧、光柱相关;
 * 乱序晶 → 22/46 度完整晕环。
 */
export interface CirrusPreset {
  id: string;
  name: string;
  description: string;
  populations: SimParams['populations'];
}

function pop(
  fraction: number,
  mode: 'plate' | 'column' | 'random',
  tiltSigma: number,
  aspect: number,
): CrystalPopulation {
  return { fraction, mode, tiltSigma, aspect };
}

export const CIRRUS_PRESETS: CirrusPreset[] = [
  {
    id: 'fair-weather-cirrus',
    name: '晴天薄卷云(片状为主)',
    description:
      '缓慢下沉的扁平片状冰晶占七成以上, 水平定向良好、摆动小。最容易看到清晰的幻日、22 度晕和环天顶弧。',
    populations: {
      plate: pop(0.72, 'plate', 2, 0.18),
      column: pop(0.1, 'column', 6, 2.4),
      random: pop(0.18, 'random', 0, 1),
    },
  },
  {
    id: 'cirrostratus-veil',
    name: '卷层云天幕(混合定向)',
    description:
      '大范围均匀卷层云, 片状与柱状混合, 摆动幅度中等。22 度晕环完整, 常伴幻日环与上切弧。',
    populations: {
      plate: pop(0.45, 'plate', 8, 0.25),
      column: pop(0.25, 'column', 10, 2.0),
      random: pop(0.3, 'random', 0, 1),
    },
  },
  {
    id: 'cold-contrail',
    name: '高寒凝结尾迹(柱状为主)',
    description:
      '−40°C 以下高空新生柱状晶, 柱轴近水平并绕轴自转。切弧、22 度晕上下侧加强明显, 少见环天顶弧。',
    populations: {
      plate: pop(0.12, 'plate', 5, 0.3),
      column: pop(0.68, 'column', 4, 3.2),
      random: pop(0.2, 'random', 0, 1),
    },
  },
  {
    id: 'turbulent-cirrus',
    name: '湍流卷云(乱序晶)',
    description:
      '强风切变下冰晶朝向被充分打乱, 各向同性。只保留与朝向无关的完整晕环: 22 度晕与 46 度晕。',
    populations: {
      plate: pop(0.15, 'plate', 35, 0.4),
      column: pop(0.15, 'column', 35, 1.8),
      random: pop(0.7, 'random', 0, 1),
    },
  },
  {
    id: 'diamond-dust',
    name: '近冰雾钻石尘(理想定向)',
    description:
      '晴冷近地面冰雾, 大片状晶几乎完美水平。幻日极亮、环天顶弧色彩饱和, 是最"教科书"的组合。',
    populations: {
      plate: pop(0.85, 'plate', 0.8, 0.12),
      column: pop(0.05, 'column', 3, 2.8),
      random: pop(0.1, 'random', 0, 1),
    },
  },
];

export function defaultParams(): SimParams {
  const preset = CIRRUS_PRESETS[0];
  return {
    sunAltDeg: 20,
    rays: 2_000_000,
    wavelengthBins: 24,
    seed: 1234567,
    populations: structuredClone(preset.populations),
    maxBounces: 24,
  };
}
