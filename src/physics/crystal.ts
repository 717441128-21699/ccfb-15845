import { Vec3, add, cross, dot, normalize, scale, sub, v3 } from './vec3';

/**
 * 正六角冰晶 (六角柱), 本地坐标系:
 *   z 轴 = 柱轴(晶体学 c 轴), 底面位于 z = ±h/2
 *   横截面外接圆半径 r, 六个侧面法线水平、相邻夹角 60°
 *
 * 8 个半空间不等式 n·x ≤ d, 法线均朝外。
 */
export interface Face {
  normal: Vec3; // 本地系外法线
  d: number; // n·x ≤ d
  kind: 'basal' | 'prism';
}

export interface CrystalGeometry {
  faces: Face[];
  /** 包围球半径(用于入射点采样) */
  boundRadius: number;
  halfHeight: number;
  radius: number;
  /** 纵横比 = h / (2r) */
  aspect: number;
}

export function hexCrystal(radius: number, halfHeight: number): CrystalGeometry {
  const faces: Face[] = [];
  for (let i = 0; i < 6; i++) {
    const theta = (i * 60 * Math.PI) / 180;
    faces.push({
      normal: v3(Math.cos(theta), Math.sin(theta), 0),
      d: radius * Math.cos(30 * Math.PI / 180), // 正六边形内接圆(对边距一半)
      kind: 'prism',
    });
  }
  faces.push({ normal: v3(0, 0, 1), d: halfHeight, kind: 'basal' });
  faces.push({ normal: v3(0, 0, -1), d: halfHeight, kind: 'basal' });
  return {
    faces,
    boundRadius: Math.hypot(radius, halfHeight),
    halfHeight,
    radius,
    aspect: halfHeight / radius,
  };
}

export type CrystalClass = 'plate' | 'column' | 'random';
export type OrientationMode = CrystalClass;

export interface CrystalPopulation {
  /** 该类晶型在混合云中的占比 (0..1), 三类之和归一 */
  fraction: number;
  mode: OrientationMode;
  /** 柱轴与参考方向夹角的高斯摆动标准差(度): 片状→与竖直夹角; 柱状→与水平夹角 */
  tiltSigma: number;
  /** 纵横比 h/(2r): 片状 <0.5, 柱状 >1 */
  aspect: number;
}

export interface SimParams {
  sunAltDeg: number;
  rays: number;
  wavelengthBins: number;
  seed: number;
  populations: Record<CrystalClass, CrystalPopulation>;
  maxBounces: number;
}

/** 四元数 (x,y,z,w) 旋转 */
export type Quat = { x: number; y: number; z: number; w: number };

export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(angleRad / 2);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angleRad / 2) };
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v' = q v q*
  const u = v3(q.x, q.y, q.z);
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}

/** 局部系 -> 世界系的旋转基 (本地 z 轴映射到 worldAxis) */
export function localToWorldBasis(worldAxis: Vec3, spin: number): Quat {
  const target = normalize(worldAxis);
  const ref = v3(0, 0, 1);
  const d = dot(ref, target);
  let q: Quat;
  if (d > 0.999999) {
    q = { x: 0, y: 0, z: 0, w: 1 };
  } else if (d < -0.999999) {
    q = { x: 1, y: 0, z: 0, w: 0 };
  } else {
    const axis = normalize(cross(ref, target));
    q = quatFromAxisAngle(axis, Math.acos(d));
  }
  // 再绕本地 z 轴(现已是 target)自旋 spin
  const qs = quatFromAxisAngle(v3(0, 0, 1), spin);
  return quatMul(q, qs);
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 高斯摆动采样(Box–Muller), 返回柱轴世界方向 */
export function sampleAxis(mode: OrientationMode, tiltSigmaDeg: number, rng: Rng): Vec3 {
  const sigma = (tiltSigmaDeg * Math.PI) / 180;
  if (mode === 'random') {
    // 各向同性: 均匀单位球
    const z = 2 * rng() - 1;
    const a = 2 * Math.PI * rng();
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    return v3(s * Math.cos(a), s * Math.sin(a), z);
  }
  if (mode === 'plate') {
    // 片状: 柱轴平均竖直, 高斯小角摆动
    const tilt = gaussian(rng) * sigma;
    const az = 2 * Math.PI * rng();
    const st = Math.sin(tilt);
    return normalize(v3(st * Math.cos(az), st * Math.sin(az), Math.cos(tilt)));
  }
  // 柱状: 柱轴平均水平, 与水平面夹角高斯摆动, 水平方位均匀
  const tilt = gaussian(rng) * sigma;
  const az = 2 * Math.PI * rng();
  const ct = Math.cos(tilt);
  return v3(ct * Math.cos(az), ct * Math.sin(az), Math.sin(tilt));
}

export interface Rng {
  (): number;
}

/** 确定性 PCG32 随机数(CPU 与 WGSL 用同一递推, 便于对照) */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
    x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
    x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  };
}

export function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 在晶体对入射方向的投影轮廓内均匀采样入射点(拒绝采样)。
 * 入射方向 d(指向晶体), 在垂直 d 的平面上取包围球圆盘内随机点,
 * 与多面体求交; 命中即返回本地系入口点 p 及入口面索引。
 */
export function sampleEntryPoint(
  geom: CrystalGeometry,
  dLocal: Vec3,
  rng: Rng,
): { point: Vec3; faceIndex: number } | null {
  // 构造垂直于 d 的平面基
  const ref = Math.abs(dLocal.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
  const e1 = normalize(cross(dLocal, ref));
  const e2 = cross(dLocal, e1);
  const R = geom.boundRadius;
  for (let attempt = 0; attempt < 32; attempt++) {
    const rr = R * Math.sqrt(rng());
    const a = 2 * Math.PI * rng();
    const q = add(scale(e1, rr * Math.cos(a)), scale(e2, rr * Math.sin(a)));
    const hit = intersectConvex(geom, q, dLocal);
    if (hit) return { point: hit.entryPoint, faceIndex: hit.entryFace };
  }
  return null;
}

export interface TraceHit {
  entryPoint: Vec3;
  entryFace: number;
}

/** 凸多面体射线求交: 标准 slab 法, 返回入口(最近正 t)信息; 不相交返回 null */
export function intersectConvex(
  geom: CrystalGeometry,
  origin: Vec3,
  dir: Vec3,
): TraceHit | null {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let face = -1;
  for (let i = 0; i < geom.faces.length; i++) {
    const f = geom.faces[i];
    const denom = dot(f.normal, dir);
    const slack = f.d - dot(f.normal, origin);
    if (Math.abs(denom) < 1e-12) {
      if (slack < 0) return null; // 光线平行于面且在外侧
      continue;
    }
    const t = slack / denom;
    if (denom < 0) {
      // 光线朝向面内部运动 → 该面提供入口
      if (t > tEnter) {
        tEnter = t;
        face = i;
      }
    } else {
      // 光线朝面外侧运动 → 该面提供出口
      if (t < tExit) tExit = t;
    }
  }
  if (face < 0 || tEnter > tExit || tExit < 1e-9) return null;
  const p = add(origin, scale(dir, Math.max(0, tEnter)));
  return { entryPoint: p, entryFace: face };
}

/** 光线在多面体内部传播, 返回下一个相交面(出口候选)及 t。
 *  阈值取晶体包围半径的相对值, 避免扁片晶的毫米级传播距离被绝对 eps 滤掉。 */
export function nextInteriorHit(
  geom: CrystalGeometry,
  point: Vec3,
  dir: Vec3,
  skipFace: number,
): { face: number; t: number; point: Vec3 } | null {
  const eps = 1e-7 * Math.max(1, geom.boundRadius);
  let bestT = Infinity;
  let bestFace = -1;
  for (let i = 0; i < geom.faces.length; i++) {
    if (i === skipFace) continue;
    const f = geom.faces[i];
    const denom = dot(f.normal, dir);
    if (denom <= eps) continue; // 光线不朝该面外侧运动
    const t = (f.d - dot(f.normal, point)) / denom;
    if (t > eps && t < bestT) {
      bestT = t;
      bestFace = i;
    }
  }
  if (bestFace < 0) return null;
  return { face: bestFace, t: bestT, point: add(point, scale(dir, bestT)) };
}

export { sub };
