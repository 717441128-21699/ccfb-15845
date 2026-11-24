// 冰晕蒙特卡洛光线追踪计算着色器
// 与 src/physics/tracer.ts 使用完全相同的几何、Snell、Fresnel 与采样约定。

struct Params {
  sunAltRad : f32,
  rays      : u32,
  waveBins  : u32,
  seed      : u32,
  maxBounce : u32,
  altBins   : u32,
  azBins    : u32,
  pad0      : f32,   // 0=正常天空成像; 2=路径类型诊断(写入前 8 槽)
  // 三类晶型: fraction / tiltSigma(rad) / aspect, 顺序 plate, column, random
  // 每个 array<f32,3> 按 16 字节对齐, 起始 f32 索引 8 / 12 / 16
  frac      : array<f32, 3>,
  tilt      : array<f32, 3>,
  aspect    : array<f32, 3>,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read_write> outR : array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> outG : array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> outB : array<atomic<u32>>;

const PI : f32 = 3.141592653589793;
const LAMBDA_MIN : f32 = 380.0;
const LAMBDA_MAX : f32 = 720.0;
const ICE_A : f32 = 1.30067;
const ICE_B : f32 = 2996.0;
const RADIUS : f32 = 1.0;
const FACE_COUNT : u32 = 8u;

struct V3 { x : f32, y : f32, z : f32 };
struct Face { n : V3, d : f32, kind : u32 }; // kind 0=prism, 1=basal
struct Hit { face : u32, t : f32, p : V3 };
struct TraceResult { ok : u32, outDir : V3, entryKind : u32, exitKind : u32, refl : u32 };

fn vadd(a : V3, b : V3) -> V3 { return V3(a.x + b.x, a.y + b.y, a.z + b.z); }
fn vsub(a : V3, b : V3) -> V3 { return V3(a.x - b.x, a.y - b.y, a.z - b.z); }
fn vmul(a : V3, s : f32) -> V3 { return V3(a.x * s, a.y * s, a.z * s); }
fn vdot(a : V3, b : V3) -> f32 { return a.x * b.x + a.y * b.y + a.z * b.z; }
fn vcross(a : V3, b : V3) -> V3 {
  return V3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
fn vlen(a : V3) -> f32 { return sqrt(vdot(a, a)); }
fn vnorm(a : V3) -> V3 { let l = max(vlen(a), 1e-20); return vmul(a, 1.0 / l); }
fn clampf(x : f32, lo : f32, hi : f32) -> f32 { return max(lo, min(hi, x)); }

// ---- PCG32 随机数 (与 CPU makeRng 同递推) ----
struct Rng { state : u32 };
fn rngNext(r : ptr<function, Rng>) -> f32 {
  r.state = r.state + 0x9e3779b9u;
  var x : u32 = r.state;
  x = (x ^ (x >> 15u)) * 0x2c1b3c6du;
  x = (x ^ (x >> 12u)) * 0x297a2d39u;
  x = x ^ (x >> 15u);
  return f32(x) / 4294967296.0;
}
fn gaussian(r : ptr<function, Rng>) -> f32 {
  var u : f32 = rngNext(r);
  var v : f32 = rngNext(r);
  u = max(u, 1e-9);
  v = max(v, 1e-9);
  return sqrt(-2.0 * log(u)) * cos(2.0 * PI * v);
}

fn iceIndex(lambdaNm : f32) -> f32 {
  return ICE_A + ICE_B / (lambdaNm * lambdaNm);
}

// 六角晶的 8 个面 (外接圆半径 1, 半高 halfH)
fn faceAt(i : u32, halfH : f32) -> Face {
  if (i < 6u) {
    let theta = f32(i) * PI / 3.0;
    return Face(V3(cos(theta), sin(theta), 0.0), RADIUS * cos(PI / 6.0), 0u);
  }
  if (i == 6u) { return Face(V3(0.0, 0.0, 1.0), halfH, 1u); }
  return Face(V3(0.0, 0.0, -1.0), halfH, 1u);
}

// 六个柱面外法线(编译期常量, 热路径直接索引避免重复三角函数)
const PRISM_NORMALS : array<V3, 6> = array<V3, 6>(
  V3(1.0, 0.0, 0.0),
  V3(0.5, 0.86602540378, 0.0),
  V3(-0.5, 0.86602540378, 0.0),
  V3(-1.0, 0.0, 0.0),
  V3(-0.5, -0.86602540378, 0.0),
  V3(0.5, -0.86602540378, 0.0),
);
const PRISM_D : f32 = 0.8660254037844387;

// 矢量 Snell 折射; normal 指向入射侧 (incident·normal < 0); 全反射返回 ok=0
fn refractV(incident : V3, normal : V3, n1 : f32, n2 : f32) -> V3 {
  let eta : f32 = n1 / n2;
  let cosi : f32 = -vdot(incident, normal);
  let sin2t : f32 = eta * eta * (1.0 - cosi * cosi);
  if (sin2t > 1.0) { return V3(0.0, 0.0, 0.0); }
  let cost : f32 = sqrt(1.0 - sin2t);
  return vnorm(vadd(vmul(incident, eta), vmul(normal, eta * cosi - cost)));
}
fn refractOK(incident : V3, normal : V3, n1 : f32, n2 : f32) -> bool {
  let eta : f32 = n1 / n2;
  let cosi : f32 = -vdot(incident, normal);
  return eta * eta * (1.0 - cosi * cosi) <= 1.0;
}

fn fresnel(cosi : f32, n1 : f32, n2 : f32) -> f32 {
  let c : f32 = min(1.0, abs(cosi));
  let sin2t : f32 = (n1 / n2) * (n1 / n2) * (1.0 - c * c);
  if (sin2t > 1.0) { return 1.0; }
  let cost : f32 = sqrt(1.0 - sin2t);
  let rs : f32 = (n1 * c - n2 * cost) / (n1 * c + n2 * cost);
  let rp : f32 = (n1 * cost - n2 * c) / (n1 * cost + n2 * c);
  return 0.5 * (rs * rs + rp * rp);
}

// 四元数旋转
fn qrot(q : vec4<f32>, v : V3) -> V3 {
  let u : V3 = V3(q.x, q.y, q.z);
  let t : V3 = vmul(vcross(u, v), 2.0);
  return vnorm(vadd(vadd(v, vmul(t, q.w)), vcross(u, t)));
}

// 本地 z 轴映射到 worldAxis, 再绕本地 z 自旋 spin
fn basisQuat(axis : V3, spin : f32) -> vec4<f32> {
  let refVec : V3 = V3(0.0, 0.0, 1.0);
  let d : f32 = vdot(refVec, axis);
  var q : vec4<f32>;
  if (d > 0.999999) {
    q = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  } else if (d < -0.999999) {
    q = vec4<f32>(1.0, 0.0, 0.0, 0.0);
  } else {
    let ax : V3 = vnorm(vcross(refVec, axis));
    let ang : f32 = acos(clampf(d, -1.0, 1.0));
    let s : f32 = sin(ang / 2.0);
    q = vec4<f32>(ax.x * s, ax.y * s, ax.z * s, cos(ang / 2.0));
  }
  // 再乘绕 z 的自旋四元数
  let ss : f32 = sin(spin / 2.0);
  let qs : vec4<f32> = vec4<f32>(0.0, 0.0, ss, cos(spin / 2.0));
  return vec4<f32>(
    q.w * qs.x + q.x * qs.w + q.y * qs.z - q.z * qs.y,
    q.w * qs.y - q.x * qs.z + q.y * qs.w + q.z * qs.x,
    q.w * qs.z + q.x * qs.y - q.y * qs.x + q.z * qs.w,
    q.w * qs.w - q.x * qs.x - q.y * qs.y - q.z * qs.z,
  );
}

// 晶型柱轴世界方向采样
fn sampleAxis(mode : u32, tiltSigma : f32, r : ptr<function, Rng>) -> V3 {
  if (mode == 2u) {
    // random: 均匀单位球
    let z : f32 = 2.0 * rngNext(r) - 1.0;
    let a : f32 = 2.0 * PI * rngNext(r);
    let s : f32 = sqrt(max(0.0, 1.0 - z * z));
    return V3(s * cos(a), s * sin(a), z);
  }
  if (mode == 0u) {
    // plate: 柱轴平均竖直
    let tilt : f32 = gaussian(r) * tiltSigma;
    let az : f32 = 2.0 * PI * rngNext(r);
    let st : f32 = sin(tilt);
    return vnorm(V3(st * cos(az), st * sin(az), cos(tilt)));
  }
  // column: 柱轴平均水平
  let tilt : f32 = gaussian(r) * tiltSigma;
  let az : f32 = 2.0 * PI * rngNext(r);
  let ct : f32 = cos(tilt);
  return V3(ct * cos(az), ct * sin(az), sin(tilt));
}

// 面积重要性采样入射点: 按各面"投影面积 = 面积 × max(0,-n·d)"概率选面,
// 再在该面均匀取点。一次成功、无拒绝、无包围球求交, 对通量无偏。
fn sampleEntry(halfH : f32, d : V3, r : ptr<function, Rng>,
               pOut : ptr<function, V3>, faceOut : ptr<function, u32>) -> bool {
  let d0 : f32 = RADIUS * cos(PI / 6.0);      // 柱面 n·x 常数
  let rectArea : f32 = 2.0 * halfH * RADIUS;  // 单个矩形柱面面积
  let hexArea : f32 = 1.5 * sqrt(3.0) * RADIUS * RADIUS; // 底面六边形面积

  // 累积各面权重(柱面法线用预计算常量, 无三角函数)
  var w : array<f32, 8>;
  var total : f32 = 0.0;
  for (var i : u32 = 0u; i < 6u; i++) {
    let proj : f32 = max(0.0, -vdot(PRISM_NORMALS[i], d));
    w[i] = rectArea * proj;
    total = total + w[i];
  }
  w[6] = hexArea * max(0.0, -d.z); // 顶面 (法线 +z)
  w[7] = hexArea * max(0.0, d.z);  // 底面 (法线 -z)
  total = total + w[6] + w[7];
  if (total <= 1e-9) { return false; }

  let pick : f32 = rngNext(r) * total;
  var acc : f32 = 0.0;
  var chosen : u32 = 7u;
  for (var i : u32 = 0u; i < 8u; i++) {
    acc = acc + w[i];
    if (pick <= acc) { chosen = i; break; }
  }

  if (chosen < 6u) {
    // 柱面矩形: 中心 n·d0, 切向跨度 R, 竖直跨度 2 halfH
    let n : V3 = PRISM_NORMALS[chosen];
    let tang : V3 = V3(-n.y, n.x, 0.0);
    let s1 : f32 = rngNext(r) * 2.0 - 1.0;
    let s2 : f32 = rngNext(r) * 2.0 - 1.0;
    *pOut = vadd(vadd(vmul(n, d0), vmul(tang, s1 * RADIUS * 0.5)), V3(0.0, 0.0, s2 * halfH));
    *faceOut = chosen;
    return true;
  }

  // 底面: 在正六边形内均匀采样(拆成 6 个等边三角形, 等概率选一个)
  let tri : u32 = u32(rngNext(r) * 6.0);
  let a1 : f32 = f32(tri) * PI / 3.0;
  let a2 : f32 = a1 + PI / 3.0;
  // 三角形均匀采样
  var r1 : f32 = rngNext(r);
  var r2 : f32 = rngNext(r);
  if (r1 + r2 > 1.0) { r1 = 1.0 - r1; r2 = 1.0 - r2; }
  let v0 : V3 = V3(0.0, 0.0, 0.0);
  let v1 : V3 = V3(RADIUS * cos(a1), RADIUS * sin(a1), 0.0);
  let v2 : V3 = V3(RADIUS * cos(a2), RADIUS * sin(a2), 0.0);
  let pxy : V3 = vadd(v0, vadd(vmul(vsub(v1, v0), r1), vmul(vsub(v2, v0), r2)));
  let zSign : f32 = select(-1.0, 1.0, chosen == 6u);
  *pOut = V3(pxy.x, pxy.y, zSign * halfH);
  *faceOut = chosen;
  return true;
}

// 内部传播下一个相交面
fn nextHit(halfH : f32, point : V3, dir : V3) -> Hit {
  let eps : f32 = 1e-7;
  var bestT : f32 = 1e30;
  var bestFace : u32 = 99u;
  for (var i : u32 = 0u; i < 6u; i++) {
    let n : V3 = PRISM_NORMALS[i];
    let denom : f32 = vdot(n, dir);
    if (denom <= eps) { continue; }
    let t : f32 = (PRISM_D - vdot(n, point)) / denom;
    if (t > eps && t < bestT) { bestT = t; bestFace = i; }
  }
  // 两个底面
  let denomUp : f32 = dir.z;
  if (denomUp > eps) {
    let t : f32 = (halfH - point.z) / denomUp;
    if (t > eps && t < bestT) { bestT = t; bestFace = 6u; }
  }
  let denomDn : f32 = -dir.z;
  if (denomDn > eps) {
    let t : f32 = (halfH + point.z) / denomDn;
    if (t > eps && t < bestT) { bestT = t; bestFace = 7u; }
  }
  return Hit(bestFace, bestT, vadd(point, vmul(dir, bestT)));
}

// 单条光线完整追踪
fn traceRay(halfH : f32, incident : V3, n : f32, maxBounce : u32, r : ptr<function, Rng>) -> TraceResult {
  var point : V3;
  var entryFace : u32;
  if (!sampleEntry(halfH, incident, r, &point, &entryFace)) {
    return TraceResult(0u, V3(0,0,0), 0u, 0u, 0u);
  }
  let entryKind : u32 = faceAt(entryFace, halfH).kind;
  let n0 : V3 = faceAt(entryFace, halfH).n;
  var dir : V3 = refractV(incident, n0, 1.0, n);
  point = vadd(point, vmul(dir, 1e-6));
  var refl : u32 = 0u;
  for (var b : u32 = 0u; b < maxBounce; b++) {
    let hit : Hit = nextHit(halfH, point, dir);
    if (hit.face == 99u) { return TraceResult(0u, V3(0,0,0), entryKind, 0u, refl); }
    let f : Face = faceAt(hit.face, halfH);
    let cosi : f32 = clampf(abs(vdot(dir, f.n)), 0.0, 1.0);
    let F : f32 = fresnel(cosi, n, 1.0);
    let roll : f32 = rngNext(r);
    if (roll < F) {
      // 反射 d' = d − 2(d·n)n
      dir = vnorm(vsub(dir, vmul(f.n, 2.0 * vdot(dir, f.n))));
      point = vadd(hit.p, vmul(dir, 1e-6));
      refl++;
      continue;
    }
    // 折射出射: 法线取 −外法线(指向晶内入射侧)
    if (!refractOK(dir, vmul(f.n, -1.0), n, 1.0)) {
      dir = vnorm(vsub(dir, vmul(f.n, 2.0 * vdot(dir, f.n))));
      point = vadd(hit.p, vmul(dir, 1e-6));
      refl++;
      continue;
    }
    let out : V3 = refractV(dir, vmul(f.n, -1.0), n, 1.0);
    return TraceResult(1u, out, entryKind, f.kind, refl);
  }
  return TraceResult(0u, V3(0,0,0), entryKind, 0u, refl);
}

// 波长 -> 线性 sRGB (Wyman 分段高斯 XYZ + 矩阵)
struct RGB { r : f32, g : f32, b : f32 };
fn gauss(x : f32, mu : f32, s1 : f32, s2 : f32) -> f32 {
  let dx : f32 = x - mu;
  let s : f32 = select(s2, s1, dx < 0.0);
  return exp(-(dx * dx) / (2.0 * s * s));
}
fn wavelengthRGB(lambda : f32) -> RGB {
  var X : f32 = 1.056 * gauss(lambda, 599.8, 37.9, 36.6)
             + 0.362 * gauss(lambda, 442.0, 16.0, 26.7)
             - 0.065 * gauss(lambda, 501.1, 20.4, 29.3);
  var Y : f32 = 0.821 * gauss(lambda, 568.8, 46.9, 40.5)
             + 0.286 * gauss(lambda, 530.9, 16.3, 31.1);
  var Z : f32 = 1.217 * gauss(lambda, 437.0, 11.8, 36.0)
             + 0.681 * gauss(lambda, 459.0, 26.0, 24.3);
  X = max(0.0, X); Y = max(0.0, Y); Z = max(0.0, Z);
  return RGB(
    max(0.0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    max(0.0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    max(0.0, 0.0557 * X - 0.204 * Y + 1.057 * Z),
  );
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ray : u32 = gid.x;
  if (ray >= P.rays) { return; }
  var rng : Rng = Rng(P.seed + ray * 0x9e3779b9u);

  // 选晶型
  let pick : f32 = rngNext(&rng);
  var mode : u32 = 2u;
  var acc : f32 = 0.0;
  for (var k : u32 = 0u; k < 3u; k++) {
    acc = acc + P.frac[k];
    if (pick < acc) { mode = k; break; }
  }
  let tiltSigma : f32 = P.tilt[mode];
  let halfH : f32 = max(0.05, P.aspect[mode] * RADIUS);

  // 太阳方向与入射传播方向
  let sun : V3 = V3(0.0, cos(P.sunAltRad), sin(P.sunAltRad));
  let incidentW : V3 = vmul(sun, -1.0);

  let axis : V3 = sampleAxis(mode, tiltSigma, &rng);
  let spin : f32 = 2.0 * PI * rngNext(&rng);
  let q : vec4<f32> = basisQuat(axis, spin);
  let qInv : vec4<f32> = vec4<f32>(-q.x, -q.y, -q.z, q.w);
  let incidentL : V3 = qrot(qInv, incidentW);

  let bin : u32 = ray % P.waveBins;
  let lambda : f32 = LAMBDA_MIN + (f32(bin) + 0.5) / f32(P.waveBins) * (LAMBDA_MAX - LAMBDA_MIN);
  let n : f32 = iceIndex(lambda);

  let tr : TraceResult = traceRay(halfH, incidentL, n, P.maxBounce, &rng);
  // 诊断模式 pad0=2: 路径类型计数写入槽 0..7 (entry*2+exit, 有反射 +4); 失败写入槽 8
  if (P.pad0 == 2.0) {
    if (tr.ok == 0u) { atomicAdd(&outR[8], 1u); return; }
    var slot : u32 = tr.entryKind * 2u + tr.exitKind; // 0=pp 1=pb 2=bp(CZA) 3=bb
    if (tr.refl > 0u) { slot = slot + 4u; }
    atomicAdd(&outR[slot], 1u);
    return;
  }
  if (tr.ok == 0u) { return; }
  let outW : V3 = qrot(q, tr.outDir);
  if (outW.z <= 0.001) { return; }

  let alt : f32 = asin(clampf(outW.z, 0.0, 1.0)) * 180.0 / PI;
  var az : f32 = atan2(outW.x, outW.y) * 180.0 / PI;
  if (az < 0.0) { az = az + 360.0; }
  let ai : u32 = clamp(u32(alt / 90.0 * f32(P.altBins)), 0u, P.altBins - 1u);
  let aj : u32 = clamp(u32(az / 360.0 * f32(P.azBins)), 0u, P.azBins - 1u);
  let idx : u32 = ai * P.azBins + aj;

  let col : RGB = wavelengthRGB(lambda);
  let scaleW : f32 = 1.0 / f32(P.waveBins);
  // 量化为整数原子累加 (定点, Q = 1024)
  let Q : f32 = 1024.0 * scaleW;
  atomicAdd(&outR[idx], u32(col.r * Q));
  atomicAdd(&outG[idx], u32(col.g * Q));
  atomicAdd(&outB[idx], u32(col.b * Q));
}
