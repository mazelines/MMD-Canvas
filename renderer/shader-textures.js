import * as THREE from 'three';
import { t } from '../src/i18n/index.js';

// Shader masks are linear data with their own UV orientation, independent of a
// material's diffuse map. Only browser-decodable images are offered by the picker.
export class ShaderTextures {
  constructor() { this.entries = new Map(); this.revision = -1; }
  async prepare(paths, revision) {
    for (const [path, entry] of this.entries) {
      if (!paths.includes(path) || (entry.error && revision !== this.revision)) {
        entry.texture?.dispose(); this.entries.delete(path);
      }
    }
    this.revision = revision;
    await Promise.all(paths.map(async path => {
      if (this.entries.has(path)) return;
      try {
        const url = 'app://fs/' + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
        const texture = await new THREE.TextureLoader().loadAsync(url);
        texture.colorSpace = THREE.NoColorSpace;
        this.entries.set(path, { texture });
      } catch {
        this.entries.set(path, { error: t('마스크 텍스처를 읽을 수 없습니다: {0} (발광 차단)', path) });
      }
    }));
  }
  get key() { return [...this.entries].map(([path, entry]) => [path, entry.texture?.id ?? -2]); }
  get errors() { return [...this.entries.values()].flatMap(entry => entry.error ? [entry.error] : []); }
}
