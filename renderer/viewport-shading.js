import * as THREE from 'three';
import { MAX_EMISSIVE_NITS, sourceEmissionNits } from '../src/core/lighting.js';

const SURFACE_KEYS = [
  'color', 'map', 'lightMap', 'lightMapIntensity', 'aoMap', 'aoMapIntensity',
  'emissive', 'emissiveIntensity', 'emissiveMap', 'bumpMap', 'bumpScale',
  'normalMap', 'normalMapType', 'normalScale', 'displacementMap', 'displacementScale',
  'displacementBias', 'alphaMap', 'wireframe', 'wireframeLinewidth', 'flatShading',
  'opacity', 'transparent', 'alphaTest', 'visible', 'side', 'vertexColors',
];

/** CPU material records for the native viewport. Source materials remain available to the inspector. */
export class ViewportShading {
  constructor(object, viewport = new THREE.Vector2(1, 1), outline = { width: 1.6, color: '#151923' }) {
    this.bindings = [];
    this.records = new Map();
    this.viewport = viewport;
    this.outlineWidth = { value: outline.width };
    this.outlineColor = new THREE.Color(outline.color);
    object.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.material) return;
      this.bindings.push({ mesh, original: mesh.material });
      for (const source of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!source || source.isShaderMaterial || this.records.has(source)) continue;
        this.records.set(source, { source, variants: {}, emissiveNits: null });
      }
    });
    this.mode = 'lambert';
  }

  variant(source, mode) {
    const record = this.records.get(source);
    if (!record) return source; // custom shaders keep their own rendering contract
    if (!record.variants[mode]) {
      const material = mode === 'toon' ? new THREE.MeshToonMaterial() : new THREE.MeshLambertMaterial();
      if (material !== source) {
        THREE.Material.prototype.copy.call(material, source);
      }
      record.variants[mode] = material;
    }
    return record.variants[mode];
  }

  sync() {
    for (const { source, variants, emissiveNits } of this.records.values()) {
      for (const material of Object.values(variants)) {
        if (material === source) continue;
        let changed = false;
        for (const key of SURFACE_KEYS) {
          if (key === 'emissiveIntensity') continue;
          if (!(key in source)) continue;
          const value = source[key];
          if (value?.isColor || value?.isVector2) {
            if (material[key]?.copy) material[key].copy(value); else material[key] = value.clone();
          }
          else if (material[key] !== value) { material[key] = value; changed = true; }
        }
        material.emissiveIntensity = emissiveNits ?? sourceEmissionNits(source);
        // Late texture loads update the native material packet on the next frame.
        if (changed) material.needsUpdate = true;
      }
    }
  }

  getEmission(source) {
    const record = this.records.get(source);
    if (!record || !source.emissive?.isColor) return null;
    return { nits: record.emissiveNits ?? sourceEmissionNits(source), override: record.emissiveNits };
  }

  setEmission(source, nits) {
    const record = this.records.get(source);
    if (!record || !source.emissive?.isColor || (nits !== null && !Number.isFinite(nits))) return;
    record.emissiveNits = nits === null ? null : Math.max(0, Math.min(MAX_EMISSIVE_NITS, nits));
    this.sync();
  }

  apply(mode) {
    if (!['lambert', 'toon'].includes(mode)) throw new Error(`Unknown viewport mode: ${mode}`);
    this.mode = mode;
    for (const { mesh, original } of this.bindings) {
      mesh.material = Array.isArray(original) ? original.map((source) => this.variant(source, mode)) : this.variant(original, mode);
    }
    this.sync();
  }

  setOutline(width, color) {
    this.outlineWidth.value = width;
    this.outlineColor.set(color);
    this.sync();
  }

  dispose() {
    for (const { mesh, original } of this.bindings) mesh.material = original;
    for (const { source, variants } of this.records.values()) {
      for (const material of Object.values(variants)) if (material !== source) material.dispose();
    }
    this.records.clear();
    this.bindings.length = 0;
  }
}
