import type { SimParams } from '../physics/crystal';
import { plateOnlyParams } from '../physics/tracer';
import { el } from './dom';
import { store } from '../state/store';

export interface HaloCatalogEntry {
  id: string;
  name: string;
  latin: string;
  crystal: string;
  path: string;
  condition: string;
  appearance: string;
  description: string;
  buildParams: (sunAlt: number) => SimParams;
}

const plate = (sunAlt: number, tilt = 1): SimParams =>
  plateOnlyParams({ rays: 2000000, sunAltDeg: sunAlt, populations: {
    plate: { fraction: 0.9, mode: 'plate', tiltSigma: tilt, aspect: 0.15 },
    column: { fraction: 0.05, mode: 'column', tiltSigma: 5, aspect: 2.5 },
    random: { fraction: 0.05, mode: 'random', tiltSigma: 0, aspect: 1 },
  }});

const random = (sunAlt: number): SimParams =>
  plateOnlyParams({ rays: 2000000, sunAltDeg: sunAlt, populations: {
    plate: { fraction: 0.1, mode: 'plate', tiltSigma: 30, aspect: 0.5 },
    column: { fraction: 0.1, mode: 'column', tiltSigma: 30, aspect: 1.5 },
    random: { fraction: 0.8, mode: 'random', tiltSigma: 0, aspect: 1 },
  }});

const column = (sunAlt: number): SimParams =>
  plateOnlyParams({ rays: 2000000, sunAltDeg: sunAlt, populations: {
    plate: { fraction: 0.1, mode: 'plate', tiltSigma: 5, aspect: 0.3 },
    column: { fraction: 0.8, mode: 'column', tiltSigma: 3, aspect: 3 },
    random: { fraction: 0.1, mode: 'random', tiltSigma: 0, aspect: 1 },
  }});

export const HALO_CATALOG: HaloCatalogEntry[] = [
  {
    id: 'halo22',
    name: '22 度晕',
    latin: '22° Halo',
    crystal: '随机取向六角晶',
    path: '侧面→侧面, 60° 棱镜两次折射',
    condition: '任意太阳高度, 卷层云',
    appearance: '距太阳 22° 的圆环, 内红外紫, 半径由冰的最小偏向角决定',
    description: '最常见的冰晕。阳光穿过随机取向冰晶的 60° 棱镜, 在最小偏向角 ~21.8° 处聚集形成亮环, 环内天空明显偏暗。',
    buildParams: (h) => random(h),
  },
  {
    id: 'parhelion',
    name: '幻日(假日)',
    latin: 'Parhelion / Sun Dog',
    crystal: '水平片状晶',
    path: '侧面→侧面, 60° 棱镜, 晶体水平定向',
    condition: '太阳高度 < 约 50°, 低太阳时最亮',
    appearance: '太阳同高度两侧的彩色亮斑, 角距随太阳高度从 22° 增大到 40°+',
    description: '片状晶水平漂浮时, 棱镜折射的焦散在太阳两侧形成亮斑。太阳越高角距越大、亮度越低, 接近全反射临界时消失。',
    buildParams: (h) => plate(Math.min(h, 40)),
  },
  {
    id: 'cza',
    name: '环天顶弧',
    latin: 'Circumzenithal Arc',
    crystal: '水平片状晶',
    path: '顶面→侧面, 90° 棱镜折射',
    condition: '太阳高度 < 32.3°, 约 22° 时最亮',
    appearance: '天顶附近的上凸彩色弧, 色彩极饱和(红在下紫在上), 俗称"天空的微笑"',
    description: '阳光从片状晶顶面进入、侧面射出, 经 90° 棱镜折射。太阳高于 32.3° 时侧面发生全反射, 弧消失——是本工具重点复现的临界现象。',
    buildParams: () => plate(20),
  },
  {
    id: 'cha',
    name: '环地平弧',
    latin: 'Circumhorizontal Arc',
    crystal: '水平片状晶',
    path: '侧面→底面, 90° 棱镜折射',
    condition: '太阳高度 > 57.7°',
    appearance: '地平线附近的水平彩色光带, 红在上紫在下',
    description: '与环天顶弧互为镜像路径: 阳光从侧面进入、底面射出。只有太阳很高时才满足折射条件, 因此在中高纬度罕见。',
    buildParams: () => plate(62),
  },
  {
    id: 'halo46',
    name: '46 度晕',
    latin: '46° Halo',
    crystal: '随机取向六角晶',
    path: '底面→侧面, 90° 棱镜两次折射',
    condition: '任意太阳高度, 比 22° 晕暗淡罕见',
    appearance: '距太阳 46° 的微弱大圆环, 最小偏向角约 45.7°',
    description: '光线在冰晶底面与侧面(90° 棱镜)之间折射形成。因 90° 棱镜的几何聚光效率低, 通常只在冰晶充沛时可见片段。',
    buildParams: (h) => random(h),
  },
  {
    id: 'tangent-upper',
    name: '上切弧',
    latin: 'Upper Tangent Arc',
    crystal: '水平柱状晶',
    path: '侧面→侧面, 柱轴水平横转',
    condition: '任意太阳高度, 形状随高度显著变化',
    appearance: '在 22° 晕上缘相切的 V 形/翼状光弧, 太阳低时尖锐、高时展宽',
    description: '柱状晶下落时柱轴保持水平并绕轴自转, 折射光在 22° 晕上方聚成切弧。其形状对太阳高度高度敏感, 是辨认柱状晶的标志。',
    buildParams: (h) => column(h),
  },
  {
    id: 'parhelic-circle',
    name: '幻日环',
    latin: 'Parhelic Circle',
    crystal: '水平片状/柱状晶',
    path: '柱面内反射为主',
    condition: '低太阳高度, 冰晶定向良好',
    appearance: '过太阳、与地平圈平行的白色水平光圈',
    description: '主要由冰晶竖直柱面的反射形成, 因反射与波长无关而呈白色。幻日就位于这条白圈上, 完整圆环较为罕见。',
    buildParams: (h) => plate(Math.min(h, 25), 0.8),
  },
  {
    id: 'pillar',
    name: '光柱',
    latin: 'Sun Pillar',
    crystal: '近水平片状晶(反射)',
    path: '底面镜面反射',
    condition: '太阳接近地平线(日出日落)',
    appearance: '太阳上方竖直延伸的白色/暖色光柱',
    description: '低角度阳光被大量略微倾斜的片状晶底面像镜子般反射, 垂直方向的取向散布把太阳的像拉成光柱。',
    buildParams: () => plate(5, 3),
  },
];

export function renderCatalogPage(root: HTMLElement): void {
  const intro = el('div', { class: 'calib-hint', css: 'margin-bottom:16px' }, [
    '图鉴收录 8 种常见冰晕, 每张卡片给出晶型、光路与出现条件。点击"模拟此现象"会自动设置对应冰晶参数并跳转到模拟页。',
  ]);
  const grid = el('div', { class: 'catalog-grid' });
  for (const entry of HALO_CATALOG) {
    const card = el('div', { class: 'halo-card' });
    card.append(el('h3', {}, [entry.name]));
    card.append(el('div', { class: 'latin' }, [entry.latin]));
    card.append(el('p', {}, [entry.description]));
    const meta = el('div', { class: 'meta' }, [
      el('span', {}, [document.createTextNode('晶型: '), el('b', {}, [entry.crystal])]),
      el('span', {}, [document.createTextNode('光路: '), el('b', {}, [entry.path])]),
      el('span', {}, [document.createTextNode('条件: '), el('b', {}, [entry.condition])]),
      el('span', {}, [document.createTextNode('外观: '), el('b', {}, [entry.appearance])]),
    ]);
    card.append(meta);
    const btn = el('button', { class: 'row' }, ['🔬 模拟此现象']);
    btn.addEventListener('click', () => {
      const sunAlt = store.get().params.sunAltDeg;
      const params = entry.buildParams(sunAlt);
      store.updateParams((p) => {
        p.populations = structuredClone(params.populations);
        p.rays = Math.max(p.rays, 1000000);
      });
      location.hash = '#/sim';
    });
    card.append(btn);
    grid.append(card);
  }
  root.append(intro, grid);
}
