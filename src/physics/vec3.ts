export type Vec3 = { x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });

/** 方位角(从 +x 起算, 0..360) 与高度角(−90..90) -> 单位方向 */
export function fromAltAz(altDeg: number, azDeg: number): Vec3 {
  const alt = (altDeg * Math.PI) / 180;
  const az = (azDeg * Math.PI) / 180;
  const ca = Math.cos(alt);
  return { x: Math.sin(az) * ca, y: Math.cos(az) * ca, z: Math.sin(alt) };
}

export function toAltAz(d: Vec3): { alt: number; az: number } {
  const n = normalize(d);
  const alt = (Math.asin(clamp(n.z, -1, 1)) * 180) / Math.PI;
  let az = (Math.atan2(n.x, n.y) * 180) / Math.PI;
  if (az < 0) az += 360;
  return { alt, az };
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 两方向夹角(度) */
export function angleBetween(a: Vec3, b: Vec3): number {
  return (Math.acos(clamp(dot(normalize(a), normalize(b)), -1, 1)) * 180) / Math.PI;
}
