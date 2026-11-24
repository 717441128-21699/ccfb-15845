import { Vec3, angleBetween, fromAltAz, scale, v3 } from './vec3';
import { refractiveIndex } from './ice';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** 棱镜最小偏向角: D_min = 2 asin(n sin(A/2)) − A */
export function minDeviation(apexAngleDeg: number, n: number): number {
  const a = apexAngleDeg * D2R;
  return (2 * Math.asin(n * Math.sin(a / 2)) - a) * R2D;
}

/** 22 度晕理论角半径(按给定波长的冰折射率) */
export function halo22Radius(lambdaNm: number): number {
  return minDeviation(60, refractiveIndex(lambdaNm));
}

/**
 * 矢量形式 Snell 折射。
 * @param incident 入射传播方向(指向界面)
 * @param normal   法线, 指向入射侧 (incident·normal < 0)
 * @param n1 入射侧折射率, n2 透射侧折射率
 * @returns 透射方向; 全反射时返回 null
 */
export function refract(incident: Vec3, normal: Vec3, n1: number, n2: number): Vec3 | null {
  const eta = n1 / n2;
  const cosi = -dot3(incident, normal);
  const sin2t = eta * eta * (1 - cosi * cosi);
  if (sin2t > 1) return null;
  const cost = Math.sqrt(1 - sin2t);
  return norm3(add3(scale(incident, eta), scale(normal, eta * cosi - cost)));
}

/** 未偏振 Fresnel 反射率 (cosi 为入射角余弦) */
export function fresnel(cosi: number, n1: number, n2: number): number {
  const c = Math.min(1, Math.abs(cosi));
  const sin2t = (n1 / n2) * (n1 / n2) * (1 - c * c);
  if (sin2t > 1) return 1;
  const cost = Math.sqrt(1 - sin2t);
  const rs = (n1 * c - n2 * cost) / (n1 * c + n2 * cost);
  const rp = (n1 * cost - n2 * c) / (n1 * cost + n2 * c);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * 水平片状晶 60° 棱镜的幻日方位角(确定性解析追踪)。
 *
 * 柱面法线水平、相邻面夹角 60°; 绕竖直轴旋转棱镜角 φ, 逐条矢量 Snell
 * 追踪得到出射方位角距 sep(φ)。光线在 sep 的驻点(导数为零)处聚集形成
 * 焦散——幻日。该驻点是 sep(φ) 的局部极小值。
 *
 * @returns 幻日相对太阳的水平方位角距(度); 全反射导致幻日消失时返回 null
 */
export function parhelionAzimuth(sunAltDeg: number, n: number): number | null {
  const sun = fromAltAz(sunAltDeg, 0);
  const incident = scale(sun, -1);

  const devAt = (phi: number): number => {
    const n1v = v3(Math.sin(phi), Math.cos(phi), 0);
    // 出射面为相邻柱面, 外法线相对入口面转 60°(外法线夹角 120°, 棱镜顶角 60°)
    const n2v = v3(Math.sin(phi + 60 * D2R), Math.cos(phi + 60 * D2R), 0);
    if (-dot3(incident, n1v) <= 0) return -1; // 第一面需朝外对着入射光
    const t = refract(incident, n1v, 1, n);
    if (!t) return -1;
    // 晶内光线朝第二面传播时与第二面外法线反向 (t·n2 < 0)
    if (dot3(t, n2v) >= 0) return -1;
    const out = refract(t, n2v, n, 1);
    if (!out) return -1;
    const az = Math.atan2(out.x, out.y) * R2D; // 出射方位, 有效路径在 ±180° 附近
    const sep = 180 - Math.abs(az); // 幻日离太阳(方位 180°)的水平角距
    return sep >= 0 && sep <= 90 ? sep : -1;
  };

  // 粗扫: 找 sep(φ) 的局部极小驻点(焦散)
  const STEPS = 4001;
  const lo = -85 * D2R;
  const hi = -5 * D2R;
  let bestPhi = 0;
  let bestSep = Infinity;
  let prev = -1;
  let prevPhi = lo;
  for (let i = 0; i < STEPS; i++) {
    const phi = lo + ((hi - lo) * i) / (STEPS - 1);
    const d = devAt(phi);
    if (d < 0) {
      prev = -1;
      continue;
    }
    if (prev >= 0 && d > prev) {
      // 导数由负转正 → prev 处为局部极小
      if (prev < bestSep) {
        bestSep = prev;
        bestPhi = prevPhi;
      }
    }
    prev = d;
    prevPhi = phi;
  }
  if (!isFinite(bestSep)) return null;

  // 黄金分割细化极小值
  const G = (Math.sqrt(5) - 1) / 2;
  let a = bestPhi - 1.5 * D2R;
  let b = bestPhi + 1.5 * D2R;
  let c = b - G * (b - a);
  let d = a + G * (b - a);
  for (let i = 0; i < 80; i++) {
    const dc = devAt(c);
    const dd = devAt(d);
    if (dc < 0 || dd < 0) break;
    if (dc < dd) b = d;
    else a = c;
    c = b - G * (b - a);
    d = a + G * (b - a);
  }
  const peak = devAt((a + b) / 2);
  return peak > 0 ? peak : bestSep;
}

/**
 * 环天顶弧临界太阳高度(度)。
 * 路径: 顶面入射 → 侧面出射 (90° 棱镜)。侧面全反射条件
 * n² − cos²h > 1, 即 sin h > sqrt(2 − n²)。
 */
export function czaCriticalAltitude(n: number): number {
  return Math.asin(Math.sqrt(Math.max(0, 2 - n * n))) * R2D;
}

/** 环地平弧临界太阳高度(度): 侧面入射 → 底面出射, 要求 sin h ≥ sqrt(n²−1) */
export function chaCriticalAltitude(n: number): number {
  return Math.asin(Math.sqrt(Math.max(0, n * n - 1))) * R2D;
}

/**
 * CZA 在太阳高度 h 下的出射高度角(主截面解析解)。
 * 顶面折射 sin r = cos h / n; 侧面出射 sin e = n cos r = sqrt(n² − cos²h),
 * 出射光线高度即 e。超过临界高度发生全反射, 返回 null。
 */
export function czaExitAltitude(sunAltDeg: number, n: number): number | null {
  const h = sunAltDeg * D2R;
  const sin2e = n * n - Math.cos(h) * Math.cos(h);
  if (sin2e > 1) return null;
  return Math.asin(Math.sqrt(Math.max(0, sin2e))) * R2D;
}

/** 两个方向的总角距(度) */
export function angularSeparation(a: Vec3, b: Vec3): number {
  return angleBetween(a, b);
}

// ---- 本文件内部使用的小型三维工具(避免与 vec3 模块循环依赖噪音) ----
function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function norm3(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
