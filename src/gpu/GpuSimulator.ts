import type { SimParams, CrystalClass } from '../physics/crystal';
import { ALT_BINS, AZ_BINS, Histogram } from '../physics/tracer';
import traceWgsl from './trace.wgsl?raw';
import renderWgsl from './render.wgsl?raw';

const UNIFORM_F32 = 32; // Params 结构按 16 字节对齐填充后的 float 数
const RENDER_UNIFORM_F32 = 16;

export interface RenderSettings {
  exposure: number;
  gamma: number;
  mode: 'fisheye' | 'overlay';
  sunU?: number;
  sunV?: number;
  pxPerDeg?: number;
}

export interface SimTiming {
  totalMs: number;
  computeMs: number;
}

const CLASS_ORDER: CrystalClass[] = ['plate', 'column', 'random'];

export class GpuSimulator {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private computePipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private renderUniformBuffer!: GPUBuffer;
  private accBuffers!: GPUBuffer[];
  private zeroBuffer: GPUBuffer | null = null;
  private zeroBufferCells = 0;
  private bindGroupCompute!: GPUBindGroup;
  private bindGroupRender!: GPUBindGroup;
  private sampler!: GPUSampler;
  private photoTexture!: GPUTexture;
  private photoView!: GPUTextureView;
  private canvasSize = { w: 0, h: 0 };
  private lastSunAltDeg = 20;
  readonly altBins = ALT_BINS;
  readonly azBins = AZ_BINS;

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU 不可用');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到 GPU 适配器');
    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => {
      console.error('GPU device lost:', info.message);
    });
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.attach(canvas);

    const computeModule = this.device.createShaderModule({ code: traceWgsl });
    this.computePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
    });

    const renderModule = this.device.createShaderModule({ code: renderWgsl });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: undefined }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const cells = this.altBins * this.azBins;
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_F32 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.renderUniformBuffer = this.device.createBuffer({
      size: RENDER_UNIFORM_F32 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.accBuffers = [0, 1, 2].map(() =>
      this.device.createBuffer({
        size: cells * 4,
        usage:
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      }),
    );

    this.bindGroupCompute = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.accBuffers[0] } },
        { binding: 2, resource: { buffer: this.accBuffers[1] } },
        { binding: 3, resource: { buffer: this.accBuffers[2] } },
      ],
    });

    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.ensurePhotoTexture(2, 2);
    this.buildRenderBindGroup();
  }

  /** 切换渲染目标(页面切换时复用同一设备与缓冲, 仅重配 canvas 上下文) */
  attach(canvas: HTMLCanvasElement): void {
    this.context = canvas.getContext('webgpu')!;
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
  }

  private ensurePhotoTexture(w: number, h: number): void {
    if (this.photoTexture && this.canvasSize.w === w && this.canvasSize.h === h) return;
    if (this.photoTexture) this.photoTexture.destroy();
    this.photoTexture = this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.photoView = this.photoTexture.createView();
    this.canvasSize = { w, h };
  }

  private buildRenderBindGroup(): void {
    this.bindGroupRender = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.accBuffers[0] } },
        { binding: 2, resource: { buffer: this.accBuffers[1] } },
        { binding: 3, resource: { buffer: this.accBuffers[2] } },
        { binding: 4, resource: this.photoView },
        { binding: 5, resource: this.sampler },
      ],
    });
  }

  private writeUniforms(params: SimParams): void {
    const data = new Float32Array(UNIFORM_F32);
    const u32 = new Uint32Array(data.buffer);
    const fractions = CLASS_ORDER.map((c) => params.populations[c].fraction);
    const tilts = CLASS_ORDER.map((c) => (params.populations[c].tiltSigma * Math.PI) / 180);
    const aspects = CLASS_ORDER.map((c) => params.populations[c].aspect);
    // 与 trace.wgsl 的 Params 布局严格对应:
    // 标量占 f32[0..6], 三个 array<f32,3> 各按 16 字节对齐 → f32[8],[12],[16]
    data[0] = (params.sunAltDeg * Math.PI) / 180;
    u32[1] = params.rays;
    u32[2] = params.wavelengthBins;
    u32[3] = params.seed >>> 0;
    u32[4] = params.maxBounces;
    u32[5] = this.altBins;
    u32[6] = this.azBins;
    data[8] = fractions[0];
    data[9] = fractions[1];
    data[10] = fractions[2];
    data[12] = tilts[0];
    data[13] = tilts[1];
    data[14] = tilts[2];
    data[16] = aspects[0];
    data[17] = aspects[1];
    data[18] = aspects[2];
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  /** 运行一次完整模拟并渲染到画布, 返回计时 */
  async runAndRender(params: SimParams, settings: RenderSettings): Promise<SimTiming> {
    const t0 = performance.now();
    this.lastSunAltDeg = params.sunAltDeg;
    this.writeUniforms(params);

    // 清空累积缓冲(复用持久零缓冲, 避免每次模拟创建/映射大块内存)
    const encoder0 = this.device.createCommandEncoder();
    const cells = this.altBins * this.azBins;
    if (!this.zeroBuffer || this.zeroBufferCells < cells) {
      this.zeroBuffer?.destroy();
      this.zeroBuffer = this.device.createBuffer({
        size: cells * 4,
        usage: GPUBufferUsage.COPY_SRC,
      });
      this.zeroBufferCells = cells;
    }
    for (const buf of this.accBuffers) {
      encoder0.copyBufferToBuffer(this.zeroBuffer, 0, buf, 0, cells * 4);
    }
    this.device.queue.submit([encoder0.finish()]);

    // 计算 pass
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.bindGroupCompute);
    const workgroups = Math.ceil(params.rays / 256);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    const tCompute = performance.now();
    await this.device.queue.onSubmittedWorkDone();
    const computeMs = tCompute - t0;

    await this.render(settings);
    return { totalMs: performance.now() - t0, computeMs };
  }

  async render(settings: RenderSettings): Promise<void> {
    const canvas = this.context.canvas as HTMLCanvasElement;
    const w = canvas.clientWidth * (window.devicePixelRatio || 1);
    const h = canvas.clientHeight * (window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(w) || canvas.height !== Math.floor(h)) {
      canvas.width = Math.floor(w);
      canvas.height = Math.floor(h);
    }
    this.ensurePhotoTexture(canvas.width, canvas.height);
    this.buildRenderBindGroup();

    const data = new Float32Array(RENDER_UNIFORM_F32);
    const u32 = new Uint32Array(data.buffer);
    u32[0] = canvas.width;
    u32[1] = canvas.height;
    u32[2] = this.altBins;
    u32[3] = this.azBins;
    data[4] = settings.exposure;
    u32[5] = settings.mode === 'fisheye' ? 0 : 1;
    data[6] = settings.sunU ?? 0.5;
    data[7] = settings.sunV ?? 0.5;
    data[8] = settings.pxPerDeg ?? 4;
    data[9] = 0; // 对齐填充
    data[10] = settings.gamma;
    data[11] = (this.lastSunAltDeg * Math.PI) / 180;
    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, data);

    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const rp = encoder.beginRenderPass({
      colorAttachments: [
        { view, clearValue: { r: 0.015, g: 0.02, b: 0.035, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    rp.setPipeline(this.renderPipeline);
    rp.setBindGroup(0, this.bindGroupRender);
    rp.draw(3);
    rp.end();
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
  }

  /** 上传照片到叠加纹理 (ImageBitmap 或 HTMLImageElement) */
  async uploadPhoto(source: ImageBitmap | HTMLImageElement | HTMLCanvasElement): Promise<void> {
    const w = this.photoTexture.width;
    const h = this.photoTexture.height;
    const srcW = 'width' in source ? source.width : w;
    const srcH = 'height' in source ? source.height : h;
    this.device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource },
      { texture: this.photoTexture },
      [Math.min(srcW, w), Math.min(srcH, h)],
    );
    await this.device.queue.onSubmittedWorkDone();
  }

  /** 读回累积直方图 (CPU 物理校验/分析用) */
  async readHistogram(): Promise<Histogram> {
    const cells = this.altBins * this.azBins;
    const hist = makeEmptyHistogram(this.altBins, this.azBins);
    for (let ch = 0; ch < 3; ch++) {
      const staging = this.device.createBuffer({
        size: cells * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.accBuffers[ch], 0, staging, 0, cells * 4);
      this.device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const arr = new Uint32Array(staging.getMappedRange().slice(0));
      const target = ch === 0 ? hist.r : ch === 1 ? hist.g : hist.b;
      for (let i = 0; i < cells; i++) target[i] = arr[i] / 1024;
      staging.destroy();
    }
    return hist;
  }

  destroy(): void {
    this.accBuffers?.forEach((b) => b.destroy());
    this.uniformBuffer?.destroy();
    this.renderUniformBuffer?.destroy();
    this.photoTexture?.destroy();
    this.zeroBuffer?.destroy();
  }
}

function makeEmptyHistogram(altBins: number, azBins: number): Histogram {
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
