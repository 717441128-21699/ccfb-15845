import type { SimParams, CrystalClass } from '../physics/crystal';
import { defaultParams, CIRRUS_PRESETS } from '../physics/presets';

export interface RenderState {
  exposure: number;
  gamma: number;
  autoRun: boolean;
}

export interface PhotoCalibration {
  sunU: number; // 太阳在照片中的归一化 x
  sunV: number; // 归一化 y
  pxPerDeg: number; // 每度角距对应的相对像素(相对半高)
  overlayAlpha: number;
  photoDataUrl: string | null;
}

export interface AppState {
  params: SimParams;
  render: RenderState;
  calibration: PhotoCalibration;
  activePresetId: string;
}

const STORAGE_KEY = 'ice-halo-state-v1';

function initialState(): AppState {
  return {
    params: defaultParams(),
    render: { exposure: 1.2, gamma: 2.2, autoRun: true },
    calibration: { sunU: 0.5, sunV: 0.55, pxPerDeg: 4, overlayAlpha: 0.85, photoDataUrl: null },
    activePresetId: CIRRUS_PRESETS[0].id,
  };
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as AppState;
    // 合并默认值, 防止旧版本缺字段
    const base = initialState();
    return {
      params: { ...base.params, ...parsed.params, populations: parsed.params?.populations ?? base.params.populations },
      render: { ...base.render, ...parsed.render },
      calibration: { ...base.calibration, ...parsed.calibration },
      activePresetId: parsed.activePresetId ?? base.activePresetId,
    };
  } catch {
    return initialState();
  }
}

type Listener = (state: AppState) => void;

class Store {
  private state: AppState = load();
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 不可变更新并通知 */
  update(recipe: (draft: AppState) => void): void {
    const draft: AppState = structuredClone(this.state);
    recipe(draft);
    this.state = draft;
    this.persist();
    this.listeners.forEach((fn) => fn(this.state));
  }

  updateParams(recipe: (p: SimParams) => void): void {
    this.update((s) => recipe(s.params));
  }

  setPreset(presetId: string): void {
    const preset = CIRRUS_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.update((s) => {
      s.activePresetId = presetId;
      s.params.populations = structuredClone(preset.populations);
    });
  }

  setPopulation(cls: CrystalClass, patch: Partial<SimParams['populations'][CrystalClass]>): void {
    this.updateParams((p) => {
      p.populations[cls] = { ...p.populations[cls], ...patch };
    });
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // 照片过大等情况下静默失败
    }
  }
}

export const store = new Store();
