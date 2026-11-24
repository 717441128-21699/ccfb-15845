import { Vec3, add, clamp, dot, fromAltAz, neg, normalize, scale, sub } from './vec3';
import {
  CrystalClass,
  CrystalGeometry,
  Quat,
  Rng,
  SimParams,
  hexCrystal,
  localToWorldBasis,
  makeRng,
  nextInteriorHit,
  quatRotate,
  sampleAxis,
  sampleEntryPoint,
} from './crystal';
import { LAMBDA_MAX, LAMBDA_MIN, refractiveIndex, wavelengthToRGB } from './ice';
import { fresnel, refract } from './analytic';

export const ALT_BINS = 360; // 0..90°, 每箱 0.25°
export const AZ_BINS = 1440; // 0..360°, 每箱 0.25°

export interface Histogram {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  altBins: number;
  azBins: number;
  raysTraced: number;
  raysEscaped: number;
}

export function makeHistogram(altBins = ALT_BINS, azBins = AZ_BINS): Histogram {
  const n = altBins * azBins;
  return {
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    altBins,
    azBins,
    raysTraced: 0,
    raysEscaped: 0,
  };
}

function cellIndex(h: Histogram, altDeg: number, azDeg: number): number {
  const ai = clamp(Math.floor((altDeg / 90) * h.altBins), 0, h.altBins - 1);
  let az = azDeg % 360;
  if (az < 0) az += 360;
  const aj = clamp(Math.floor((az / 360) * h.azBins), 0, h.azBins - 1);
  return ai * h.azBins + aj;
}

function addColor(h: Histogram, altDeg: number, azDeg: number, weight: number, lambda: number): void {
  const idx = cellIndex(h, altDeg, azDeg);
  const c = wavelengthToRGB(lambda);
  h.r[idx] += c.r * weight;
  h.g[idx] += c.g * weight;
  h.b[idx] += c.b * weight;
}

export interface TraceResult {
  outWorld: Vec3;
  weight: number;
  entryKind: 'basal' | 'prism';
  exitKind: 'basal' | 'prism';
  internalReflections: number;
}

/**
 * 单条光线在一颗六角晶内的完整追踪(本地系)。
 * 入口处的一次折射 + 最多 maxBounces 次界面交互(Fresnel 决定反射/折射),
 * 用俄罗斯轮盘赌在反射分支保持无偏且不指数分裂。
 */
export function traceRay(
  geom: CrystalGeometry,
  incidentLocal: Vec3,
  n: number,
  maxBounces: number,
  rng: Rng,
): TraceResult | null {
  const entry = sampleEntryPoint(geom, incidentLocal, rng);
  if (!entry) return null;
  const entryFace = entry.faceIndex;
  const entryKind = geom.faces[entryFace].kind;

  // 入口折射(空气→冰); 入口反射按常规近似忽略(其能量进入 22° 晕外的背景)
  const t0 = refract(incidentLocal, geom.faces[entryFace].normal, 1, n);
  if (!t0) return null;
  let dir = t0;
  // 入口点在浮点上可能略在界面外, 沿折射方向推进一点
  let point = add(entry.point, scale(t0, 1e-6));
  let weight = 1;
  let reflections = 0;

  for (let bounce = 0; bounce < maxBounces; bounce++) {
    // 不跳过任何面: 凸多面体 + 正距离阈值即可避免自相交,
    // 且反射后允许光线再次命中刚离开的面(数值上最稳健)
    const hit = nextInteriorHit(geom, point, dir, -1);
    if (!hit) return null;
    const face = geom.faces[hit.face];
    // 光线在晶内射向界面: dir 与外法线同向, 入射角余弦取 |dot|
    const cosi = clamp(Math.abs(dot(dir, face.normal)), 0, 1);
    const r = fresnel(cosi, n, 1);
    const roll = rng();
    if (roll < r) {
      // 反射分支: d' = d − 2(d·n)n
      const rn = sub(dir, scale(face.normal, 2 * dot(dir, face.normal)));
      dir = normalize(rn);
      point = add(hit.point, scale(dir, 1e-6));
      reflections++;
      continue;
    }
    // 折射出射(冰→空气); 折射函数要求法线指向入射侧, 故取 −外法线。
    // 若全反射则强制走反射。
    const out = refract(dir, neg(face.normal), n, 1);
    if (!out) {
      const rn = sub(dir, scale(face.normal, 2 * dot(dir, face.normal)));
      dir = normalize(rn);
      point = add(hit.point, scale(dir, 1e-6));
      reflections++;
      continue;
    }
    return {
      outWorld: out,
      weight,
      entryKind,
      exitKind: face.kind,
      internalReflections: reflections,
    };
  }
  return null;
}

function pickPopulation(params: SimParams, rng: Rng): CrystalClass {
  const x = rng();
  let acc = 0;
  for (const cls of ['plate', 'column', 'random'] as CrystalClass[]) {
    acc += params.populations[cls].fraction;
    if (x < acc) return cls;
  }
  return 'random';
}

const RADIUS = 1;

function geometryFor(cls: CrystalClass, params: SimParams): CrystalGeometry {
  const pop = params.populations[cls];
  // aspect = h / (2r) → halfHeight = aspect·r
  const halfHeight = Math.max(0.05, pop.aspect * RADIUS);
  return hexCrystal(RADIUS, halfHeight);
}

/**
 * 蒙特卡洛整球模拟。
 * 太阳方向固定, 每条光线: 选晶型 → 采样朝向 → 采样波长 → 本地系追踪 → 天空直方图累加。
 */
export function simulate(params: SimParams, histogram?: Histogram): Histogram {
  const hist = histogram ?? makeHistogram();
  const rng = makeRng(params.seed);
  const sun = fromAltAz(params.sunAltDeg, 0);
  const incidentWorld = scale(sun, -1);
  const bins = Math.max(1, params.wavelengthBins);

  for (let ray = 0; ray < params.rays; ray++) {
    const cls = pickPopulation(params, rng);
    const pop = params.populations[cls];
    const geom = geometryFor(cls, params);
    const axis = sampleAxis(pop.mode, pop.tiltSigma, rng);
    const spin = 2 * Math.PI * rng();
    const q: Quat = localToWorldBasis(axis, spin);
    // 世界→本地: 用逆旋转 = 共轭四元数
    const qInv: Quat = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const incidentLocal = quatRotate(qInv, incidentWorld);

    const bin = ray % bins;
    const lambda = LAMBDA_MIN + ((bin + 0.5) / bins) * (LAMBDA_MAX - LAMBDA_MIN);
    const n = refractiveIndex(lambda);

    const result = traceRay(geom, incidentLocal, n, params.maxBounces, rng);
    hist.raysTraced++;
    if (!result) continue;
    const outWorld = quatRotate(q, result.outWorld);
    if (outWorld.z <= 0.001) continue; // 只保留射向天空半球的光
    const alt = Math.asin(clamp(outWorld.z, 0, 1)) * (180 / Math.PI);
    const az = Math.atan2(outWorld.x, outWorld.y) * (180 / Math.PI);
    addColor(hist, alt, az, result.weight / bins, lambda);
    hist.raysEscaped++;
  }
  return hist;
}

/** 只追踪并按路径分类计数(用于 CZA 等结构检验), 不做颜色直方图 */
export interface PathCounts {
  total: number;
  basalToPrism: number; // 顶面入、侧面出: CZA / 46° 家族
  prismToPrism: number; // 侧面入、侧面出: 22° 晕 / 幻日
  prismToBasal: number; // 侧面入、底面出: 环地平弧
  basalToBasal: number;
}

/**
 * 22 度晕专用检验: 对每条"侧面入→侧面出、无内反射"的出射光,
 * 统计其与太阳方向的总角距直方图(直接对应晕环角半径, 与晶体取向无关)。
 * 返回 0..60° 的亮度剖面, 每箱 binDeg 度。
 */
export function halo22Profile(
  params: SimParams,
  binDeg = 0.1,
  maxDeg = 60,
): { bins: Float32Array; binDeg: number } {
  const nBins = Math.round(maxDeg / binDeg);
  const bins = new Float32Array(nBins);
  const rng = makeRng(params.seed ^ 0x13579bdf);
  const sun = fromAltAz(params.sunAltDeg, 0);
  const incidentWorld = scale(sun, -1); // 入射光传播方向
  const limit = Math.min(params.rays, 250000);
  for (let ray = 0; ray < limit; ray++) {
    const cls = pickPopulation(params, rng);
    const pop = params.populations[cls];
    const geom = geometryFor(cls, params);
    const axis = sampleAxis(pop.mode, pop.tiltSigma, rng);
    const spin = 2 * Math.PI * rng();
    const q = localToWorldBasis(axis, spin);
    const qInv: Quat = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const incidentLocal = quatRotate(qInv, incidentWorld);
    const result = traceRay(geom, incidentLocal, refractiveIndex(550), params.maxBounces, rng);
    if (!result) continue;
    if (result.entryKind !== 'prism' || result.exitKind !== 'prism') continue;
    if (result.internalReflections > 0) continue;
    const outWorld = quatRotate(q, result.outWorld);
    if (outWorld.z <= 0.001) continue;
    // 偏向角 = 入射传播方向与出射传播方向的夹角
    const cosSep = clamp(dot(incidentWorld, outWorld), -1, 1);
    const sep = (Math.acos(cosSep) * 180) / Math.PI;
    const idx = Math.floor(sep / binDeg);
    if (idx >= 0 && idx < nBins) bins[idx] += 1;
  }
  return { bins, binDeg };
}

/**
 * 幻日专用检验: 近水平片状晶, 统计每条"侧面入→侧面出、无内反射"出射光
 * 相对入射传播方向(方位 0°)的水平方位角距直方图。在给定搜索窗口内返回峰位(度)。
 */
export function parhelionProfile(
  params: SimParams,
  binDeg = 0.25,
  maxDeg = 90,
): { bins: Float32Array; binDeg: number } {
  const nBins = Math.round(maxDeg / binDeg);
  const bins = new Float32Array(nBins);
  const rng = makeRng(params.seed ^ 0x2468ace0);
  const sun = fromAltAz(params.sunAltDeg, 0);
  const incidentWorld = scale(sun, -1);
  const limit = Math.min(params.rays, 300000);
  for (let ray = 0; ray < limit; ray++) {
    const cls = pickPopulation(params, rng);
    const pop = params.populations[cls];
    const geom = geometryFor(cls, params);
    const axis = sampleAxis(pop.mode, pop.tiltSigma, rng);
    const spin = 2 * Math.PI * rng();
    const q = localToWorldBasis(axis, spin);
    const qInv: Quat = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const incidentLocal = quatRotate(qInv, incidentWorld);
    const result = traceRay(geom, incidentLocal, refractiveIndex(550), params.maxBounces, rng);
    if (!result) continue;
    if (result.entryKind !== 'prism' || result.exitKind !== 'prism') continue;
    if (result.internalReflections > 0) continue;
    const outWorld = quatRotate(q, result.outWorld);
    if (outWorld.z <= 0.001) continue;
    // 出射光相对入射传播方向的水平方位角距(取左右较小者)
    const az = Math.atan2(outWorld.x, outWorld.y) * (180 / Math.PI);
    let sep = Math.abs(az);
    sep = Math.min(sep, 360 - sep);
    const idx = Math.floor(sep / binDeg);
    if (idx >= 0 && idx < nBins) bins[idx] += 1;
  }
  return { bins, binDeg };
}

/** 一维剖面在 [minDeg,maxDeg] 窗口内的抛物线插值峰位(度) */
export function peakPosition(
  bins: Float32Array,
  binDeg: number,
  minDeg = 0,
  maxDeg = Infinity,
): number {
  const lo = Math.max(1, Math.floor(minDeg / binDeg));
  const hi = Math.min(bins.length - 2, Math.ceil(maxDeg / binDeg));
  let peak = lo;
  let peakV = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (bins[i] > peakV) {
      peakV = bins[i];
      peak = i;
    }
  }
  if (peakV <= 0) return peak * binDeg;
  const y0 = bins[peak - 1];
  const y1 = bins[peak];
  const y2 = bins[peak + 1];
  const denom = y0 - 2 * y1 + y2;
  const offset = Math.abs(denom) > 1e-12 ? 0.5 * (y0 - y2) / denom : 0;
  return (peak + clamp(offset, -1, 1)) * binDeg;
}

export function simulatePaths(params: SimParams, sampleLimit = 200000): PathCounts {
  const counts: PathCounts = {
    total: 0,
    basalToPrism: 0,
    prismToPrism: 0,
    prismToBasal: 0,
    basalToBasal: 0,
  };
  const rng = makeRng(params.seed ^ 0x55aa55aa);
  const sun = fromAltAz(params.sunAltDeg, 0);
  const incidentWorld = scale(sun, -1);
  const n = refractiveIndex(550);
  const limit = Math.min(params.rays, sampleLimit);
  for (let ray = 0; ray < limit; ray++) {
    const cls = pickPopulation(params, rng);
    const pop = params.populations[cls];
    const geom = geometryFor(cls, params);
    const axis = sampleAxis(pop.mode, pop.tiltSigma, rng);
    const spin = 2 * Math.PI * rng();
    const q = localToWorldBasis(axis, spin);
    const qInv: Quat = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const incidentLocal = quatRotate(qInv, incidentWorld);
    const result = traceRay(geom, incidentLocal, n, params.maxBounces, rng);
    counts.total++;
    if (!result) continue;
    if (result.entryKind === 'basal' && result.exitKind === 'prism') counts.basalToPrism++;
    else if (result.entryKind === 'prism' && result.exitKind === 'prism') counts.prismToPrism++;
    else if (result.entryKind === 'prism' && result.exitKind === 'basal') counts.prismToBasal++;
    else counts.basalToBasal++;
  }
  return counts;
}

/** 纯片状晶、近完美水平定向的便捷参数(物理校验用) */
export function plateOnlyParams(overrides: Partial<SimParams> = {}): SimParams {
  return {
    sunAltDeg: 20,
    rays: 100000,
    wavelengthBins: 24,
    seed: 42,
    maxBounces: 24,
    populations: {
      plate: { fraction: 1, mode: 'plate', tiltSigma: 0.5, aspect: 0.15 },
      column: { fraction: 0, mode: 'column', tiltSigma: 5, aspect: 2.5 },
      random: { fraction: 0, mode: 'random', tiltSigma: 0, aspect: 1 },
    },
    ...overrides,
  };
}

/** 直方图工具: 对所有方位角求和得到随高度角的径向亮度剖面 */
export function radialProfile(hist: Histogram): Float32Array {
  const profile = new Float32Array(hist.altBins);
  for (let i = 0; i < hist.altBins; i++) {
    let s = 0;
    const base = i * hist.azBins;
    for (let j = 0; j < hist.azBins; j++) s += hist.r[base + j] + hist.g[base + j] + hist.b[base + j];
    profile[i] = s;
  }
  return profile;
}

/** 抛物线插值求剖面峰的亚箱位置(返回高度角, 度) */
export function peakAltitude(profile: Float32Array): number {
  let peak = 0;
  let peakV = -Infinity;
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i] > peakV) {
      peakV = profile[i];
      peak = i;
    }
  }
  if (peak <= 0 || peak >= profile.length - 1) return (peak / profile.length) * 90;
  const y0 = profile[peak - 1];
  const y1 = profile[peak];
  const y2 = profile[peak + 1];
  const denom = y0 - 2 * y1 + y2;
  const offset = Math.abs(denom) > 1e-12 ? 0.5 * (y0 - y2) / denom : 0;
  return ((peak + clamp(offset, -1, 1)) / profile.length) * 90;
}

/** 全天空方位角亮度剖面(对所有高度求和), 用于定位幻日 */
export function azimuthProfile(hist: Histogram): Float32Array {
  const profile = new Float32Array(hist.azBins);
  for (let i = 0; i < hist.altBins; i++) {
    const base = i * hist.azBins;
    for (let j = 0; j < hist.azBins; j++) {
      profile[j] += hist.r[base + j] + hist.g[base + j] + hist.b[base + j];
    }
  }
  return profile;
}

/**
 * 从主模拟直方图的方位剖面提取幻日峰离太阳的角距(度)。
 * 太阳位于方位 180°, 在 [minSep,maxSep] 角距窗口内取左右两侧的共同亮峰。
 * 这与产品成像使用同一份模拟数据, 是端到端的物理校验。
 */
export function parhelionPeakFromHistogram(
  hist: Histogram,
  minSepDeg: number,
  maxSepDeg: number,
): number {
  const profile = azimuthProfile(hist);
  const binDeg = 360 / profile.length;
  let peak = -1;
  let peakV = -Infinity;
  for (let j = 0; j < profile.length; j++) {
    const az = j * binDeg;
    let sep = Math.abs(az - 180);
    sep = Math.min(sep, 360 - sep);
    if (sep < minSepDeg || sep > maxSepDeg) continue;
    if (profile[j] > peakV) {
      peakV = profile[j];
      peak = j;
    }
  }
  if (peak < 0) return NaN;
  const az = peak * binDeg;
  let sep = Math.abs(az - 180);
  return Math.min(sep, 360 - sep);
}

/** 方位剖面中幻日亮峰离太阳方位的角距(度)。
 *  本模拟太阳固定在方位 180°(光线沿 −y 入射); 排除太阳周围窗口后取最强峰。 */
export function nearestAzimuthPeak(
  profile: Float32Array,
  sunAzDeg = 180,
  excludeHalfWidthDeg = 8,
): number {
  const binDeg = 360 / profile.length;
  const excludeBins = Math.round(excludeHalfWidthDeg / binDeg);
  let peak = -1;
  let peakV = -Infinity;
  for (let j = 0; j < profile.length; j++) {
    const az = j * binDeg;
    let d = Math.abs(az - sunAzDeg);
    d = Math.min(d, 360 - d);
    if (d < excludeBins * binDeg) continue;
    if (profile[j] > peakV) {
      peakV = profile[j];
      peak = j;
    }
  }
  if (peak < 0) return 0;
  const az = peak * binDeg;
  let d = Math.abs(az - sunAzDeg);
  return Math.min(d, 360 - d);
}
