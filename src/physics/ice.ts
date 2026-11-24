import { clamp } from './vec3';

/**
 * 冰的折射率 (Cauchy 拟合, 拟合 Warren & Brandt 2008 可见光数据):
 *   n(λ) = A + B / λ²,  λ 单位 nm
 *   n(589.3nm) ≈ 1.3093, n(400nm) ≈ 1.3194, n(700nm) ≈ 1.3068
 */
export const ICE_CAUCHY_A = 1.30067;
export const ICE_CAUCHY_B = 2996.0;

export function refractiveIndex(lambdaNm: number): number {
  return ICE_CAUCHY_A + ICE_CAUCHY_B / (lambdaNm * lambdaNm);
}

export const LAMBDA_MIN = 380;
export const LAMBDA_MAX = 720;

interface GaussianLobe {
  mu: number;
  s1: number;
  s2: number;
}

const X_LOBES: Array<GaussianLobe & { a: number }> = [
  { a: 1.056, mu: 599.8, s1: 37.9, s2: 36.6 },
  { a: 0.362, mu: 442.0, s1: 16.0, s2: 26.7 },
  { a: -0.065, mu: 501.1, s1: 20.4, s2: 29.3 },
];
const Y_LOBES: Array<GaussianLobe & { a: number }> = [
  { a: 0.821, mu: 568.8, s1: 46.9, s2: 40.5 },
  { a: 0.286, mu: 530.9, s1: 16.3, s2: 31.1 },
];
const Z_LOBES: Array<GaussianLobe & { a: number }> = [
  { a: 1.217, mu: 437.0, s1: 11.8, s2: 36.0 },
  { a: 0.681, mu: 459.0, s1: 26.0, s2: 24.3 },
];

function g(x: number, l: GaussianLobe): number {
  const dx = x - l.mu;
  const s = dx < 0 ? l.s1 : l.s2;
  return Math.exp(-(dx * dx) / (2 * s * s));
}

/** 波长(nm) -> CIE XYZ 三刺激值 (Wyman 2013 分段高斯近似) */
export function wavelengthToXYZ(lambda: number): { x: number; y: number; z: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const l of X_LOBES) x += l.a * g(lambda, l);
  for (const l of Y_LOBES) y += l.a * g(lambda, l);
  for (const l of Z_LOBES) z += l.a * g(lambda, l);
  return { x: Math.max(0, x), y: Math.max(0, y), z: Math.max(0, z) };
}

/** CIE XYZ -> 线性 sRGB (未做 gamma, 渲染时统一 tonemap + gamma) */
export function xyzToLinearRGB(c: { x: number; y: number; z: number }): { r: number; g: number; b: number } {
  const r = 3.2406 * c.x - 1.5372 * c.y - 0.4986 * c.z;
  const g = -0.9689 * c.x + 1.8758 * c.y + 0.0415 * c.z;
  const b = 0.0557 * c.x - 0.204 * c.y + 1.057 * c.z;
  return { r: Math.max(0, r), g: Math.max(0, g), b: Math.max(0, b) };
}

export function wavelengthToRGB(lambda: number): { r: number; g: number; b: number } {
  return xyzToLinearRGB(wavelengthToXYZ(clamp(lambda, LAMBDA_MIN, LAMBDA_MAX)));
}
