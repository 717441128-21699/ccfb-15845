import type { SimParams } from '../physics/crystal';
import { Histogram, simulate, ALT_BINS, AZ_BINS } from '../physics/tracer';
import type { RenderSettings, SimTiming } from './GpuSimulator';

/**
 * 无 WebGPU 时的 CPU 回退: 复用物理追踪器, 用 Canvas 2D 绘制鱼眼/叠加。
 * 光线数上限较低, 仅保证功能可用与物理正确, 不追求 3 秒性能指标。
 */
export class CpuSimulator {
  readonly altBins = ALT_BINS;
  readonly azBins = AZ_BINS;
  private hist: Histogram | null = null;
  private photo: HTMLImageElement | HTMLCanvasElement | null = null;

  static isSupported(): boolean {
    return typeof document !== 'undefined';
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.attach(canvas);
  }

  private canvas: HTMLCanvasElement | null = null;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.classList.add('active-canvas');
  }

  async runAndRender(params: SimParams, settings: RenderSettings): Promise<SimTiming> {
    const t0 = performance.now();
    const capped = { ...params, rays: Math.min(params.rays, 300000) };
    this.hist = simulate(capped);
    const computeMs = performance.now() - t0;
    await this.render(settings);
    return { totalMs: performance.now() - t0, computeMs };
  }

  async render(settings: RenderSettings): Promise<void> {
    if (!this.hist || !this.canvas) return;
    const target = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(target.clientWidth * dpr);
    const h = Math.floor(target.clientHeight * dpr);
    if (target.width !== w) target.width = w;
    if (target.height !== h) target.height = h;
    const ctx = target.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = target.clientWidth;
    const ch = target.clientHeight;

    ctx.fillStyle = '#04060c';
    ctx.fillRect(0, 0, cw, ch);

    const { image } = this.buildImageData(w, h, settings, cw / ch);
    ctx.putImageData(image, 0, 0);

    if (settings.mode === 'fisheye') this.drawGrid(ctx, cw, ch);
    if (this.photo && settings.mode === 'overlay') {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.photo, 0, 0, cw, ch);
      ctx.globalAlpha = 1;
    }
  }

  private buildImageData(
    w: number,
    h: number,
    settings: RenderSettings,
    aspect: number,
  ): { image: ImageData } {
    const image = new ImageData(w, h);
    if (!this.hist) return { image };
    const hist = this.hist;
    let maxLum = 1e-6;
    for (let i = 0; i < hist.r.length; i++) {
      const l = hist.r[i] + hist.g[i] + hist.b[i];
      if (l > maxLum) maxLum = l;
    }
    void maxLum;
    const exposure = settings.exposure;
    const gamma = settings.gamma;
    const idx = (alt: number, az: number) => {
      const ai = Math.min(hist.altBins - 1, Math.max(0, Math.floor((alt / 90) * hist.altBins)));
      let a = az % 360;
      if (a < 0) a += 360;
      const aj = Math.min(hist.azBins - 1, Math.max(0, Math.floor((a / 360) * hist.azBins)));
      return ai * hist.azBins + aj;
    };

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const u = px / w;
        const v = py / h;
        let r = 0;
        let g = 0;
        let b = 0;
        if (settings.mode === 'fisheye') {
          const dx = (u - 0.5) * aspect;
          const dy = v - 0.5;
          const rr = Math.hypot(dx, dy);
          if (rr <= 1) {
            const alt = 90 - rr * 90;
            let az = 180 + (Math.atan2(dx, -dy) * 180) / Math.PI;
            az = ((az % 360) + 360) % 360;
            const k = idx(alt, az);
            const tone = (c: number) => {
              const e = 1 - Math.exp(-(c / maxLum) * exposure * 3);
              return Math.pow(Math.min(1, Math.max(0, e)), 1 / gamma) * 255;
            };
            r = tone(hist.r[k]);
            g = tone(hist.g[k]);
            b = tone(hist.b[k]);
          }
        }
        const o = (py * w + px) * 4;
        image.data[o] = r;
        image.data[o + 1] = g;
        image.data[o + 2] = b;
        image.data[o + 3] = 255;
      }
    }
    return { image };
  }

  private drawGrid(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const cx = cw / 2;
    const cy = ch / 2;
    const R = ch / 2;
    ctx.strokeStyle = 'rgba(140,170,210,0.25)';
    ctx.lineWidth = 1;
    for (const deg of [22, 46, 67.5]) {
      ctx.beginPath();
      ctx.arc(cx, cy, (deg / 90) * R, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
  }

  async uploadPhoto(source: ImageBitmap | HTMLImageElement | HTMLCanvasElement): Promise<void> {
    this.photo = source as HTMLImageElement;
  }

  async readHistogram(): Promise<Histogram> {
    return this.hist!;
  }

  destroy(): void {
    /* 无资源 */
  }
}

export type AnySimulator = CpuSimulator | import('./GpuSimulator').GpuSimulator;
