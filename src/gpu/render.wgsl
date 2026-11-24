// 天空直方图 -> 屏幕成像渲染着色器
// 两种模式: mode=0 天顶鱼眼(模拟页), mode=1 照片标定叠加(比对页)

struct RenderParams {
  width      : u32,
  height     : u32,
  altBins    : u32,
  azBins     : u32,
  exposure   : f32,
  mode       : u32,   // 0=鱼眼, 1=照片叠加
  sunU       : f32,   // 照片模式: 太阳在图中的归一化坐标
  sunV       : f32,
  pxPerDeg   : f32,   // 照片模式: 每度像素数(相对半高归一化)
  sunAltRad  : f32,
  gamma      : f32,
  pad0       : f32,
  pad1       : f32,
};

@group(0) @binding(0) var<uniform> P : RenderParams;
@group(0) @binding(1) var<storage, read> accR : array<u32>;
@group(0) @binding(2) var<storage, read> accG : array<u32>;
@group(0) @binding(3) var<storage, read> accB : array<u32>;
@group(0) @binding(4) var tex : texture_2d<f32>;
@group(0) @binding(5) var samp : sampler;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  // 全屏三角形
  var p : array<vec2<f32>, 3>;
  p[0] = vec2<f32>(-1.0, -3.0);
  p[1] = vec2<f32>(3.0, 1.0);
  p[2] = vec2<f32>(-1.0, 1.0);
  var out : VSOut;
  out.pos = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, (p[vi].y + 1.0) * 0.5);
  return out;
}

fn sampleSky(altDeg : f32, azDeg : f32) -> vec3<f32> {
  if (altDeg < 0.0) { return vec3<f32>(0.0); }
  let ai : u32 = clamp(u32(altDeg / 90.0 * f32(P.altBins)), 0u, P.altBins - 1u);
  var az : f32 = azDeg;
  if (az < 0.0) { az = az + 360.0; }
  let aj : u32 = clamp(u32(az / 360.0 * f32(P.azBins)), 0u, P.azBins - 1u);
  let idx : u32 = ai * P.azBins + aj;
  let q : f32 = 1024.0;
  return vec3<f32>(f32(accR[idx]), f32(accG[idx]), f32(accB[idx])) / q;
}

fn tonemap(c : vec3<f32>) -> vec3<f32> {
  let e : vec3<f32> = vec3<f32>(1.0) - exp(-c * P.exposure);
  return pow(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / P.gamma));
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let u : f32 = in.uv.x;
  let v : f32 = in.uv.y;

  if (P.mode == 0u) {
    // ---- 天顶等距方位鱼眼: 圆心屏幕中心, 半径 = 半高 ----
    let cx : f32 = 0.5;
    let cy : f32 = 0.5;
    let dx : f32 = (u - cx) * (f32(P.width) / f32(P.height));
    let dy : f32 = (v - cy);
    let r : f32 = sqrt(dx * dx + dy * dy);
    if (r > 1.0) {
      return vec4<f32>(0.015, 0.02, 0.035, 1.0); // 圆外深空背景
    }
    let zenithAng : f32 = r * 90.0;       // 离天顶角距
    let alt : f32 = 90.0 - zenithAng;
    // 方位: 屏幕上方为太阳方位(180°), 顺时针
    var az : f32 = 180.0 + atan2(dx, -dy) * 180.0 / 3.14159265;
    az = az % 360.0;
    let sky : vec3<f32> = sampleSky(alt, az);
    // 叠加参考网格的淡色
    let grid : f32 = gridLine(r, atan2(dx, -dy));
    var col : vec3<f32> = tonemap(sky) + vec3<f32>(0.08, 0.1, 0.14) * grid;
    return vec4<f32>(col, 1.0);
  }

  // ---- 照片叠加: 以太阳为中心的等距方位投影 ----
  let du : f32 = (u - P.sunU) * (f32(P.width) / f32(P.height));
  let dv : f32 = (v - P.sunV);
  let distDeg : f32 = sqrt(du * du + dv * dv) / max(P.pxPerDeg, 1e-4) * 0.5;
  if (distDeg > 90.0) { discard; }
  let bearing : f32 = atan2(du, -dv) * 180.0 / 3.14159265;
  // 由太阳高度与角距求该点高度/方位(球面几何)
  let h1 : f32 = P.sunAltRad;
  let dd : f32 = distDeg * 3.14159265 / 180.0;
  let sinAlt : f32 = sin(h1) * cos(dd) + cos(h1) * sin(dd) * cos(bearing + 3.14159265);
  let alt : f32 = asin(clamp(sinAlt, -1.0, 1.0)) * 180.0 / 3.14159265;
  var azRel : f32 = atan2(
    sin(bearing) * sin(dd) * cos(h1),
    cos(dd) - sin(h1) * sinAlt,
  ) * 180.0 / 3.14159265;
  let az : f32 = 180.0 + azRel;
  let sky : vec3<f32> = sampleSky(alt, az);
  let photo : vec4<f32> = textureSample(tex, samp, vec2<f32>(u, v));
  // 模拟层以加色混合叠在照片上
  let haloCol : vec3<f32> = tonemap(sky);
  return vec4<f32>(photo.rgb + haloCol * 0.9, 1.0);
}

fn gridLine(r : f32, theta : f32) -> f32 {
  // 天顶角 22/46/67.5/90 度环 + 十字方位线
  var g : f32 = 0.0;
  let rings : array<f32, 3> = array<f32>(22.0, 46.0, 67.5);
  for (var i : i32 = 0; i < 3; i++) {
    let rr : f32 = rings[i] / 90.0;
    if (abs(r - rr) < 0.003) { g = 1.0; }
  }
  let a : f32 = abs(sin(theta)) + abs(cos(theta));
  if (a > 1.414 - 0.006) { g = max(g, 0.6); }
  return g;
}
