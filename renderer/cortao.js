import { Vector3 } from 'three';
import { DEFAULT_CORTAO, normalizeCortao } from '../src/core/ambient-occlusion.js';

/** Editor state only. All AO passes run in DX12. */
export class ViewportCORTAO {
  constructor() { this.settings = { ...DEFAULT_CORTAO }; this.debugView = 'off'; this.modelSize = 1; }
  configure(settings) { this.settings = normalizeCortao({ ...this.settings, ...settings }); }
  setDebugView(view) { this.debugView = ['ao', 'raw'].includes(view) ? view : 'off'; }
  fit(box) { if (!box.isEmpty()) this.modelSize = Math.max(box.getSize(new Vector3()).length(), 1e-4); }
  clear() { this.modelSize = 1; }
}
