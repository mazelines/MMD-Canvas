import * as THREE from 'three';
import { createHullMaterial, createHullMesh } from './hull-outline.js';
import { SmoothHullGeometry } from './smooth-normals.js';

const SURFACE_KEYS = [
  'color', 'map', 'lightMap', 'lightMapIntensity', 'aoMap', 'aoMapIntensity',
  'emissive', 'emissiveIntensity', 'emissiveMap', 'bumpMap', 'bumpScale',
  'normalMap', 'normalMapType', 'normalScale', 'displacementMap', 'displacementScale',
  'displacementBias', 'alphaMap', 'wireframe', 'wireframeLinewidth', 'flatShading',
  'opacity', 'transparent', 'alphaTest', 'visible', 'side', 'vertexColors',
];

/** Viewport-only material variants. Source materials remain available to the inspector. */
export class ViewportShading {
  constructor(object, viewport = new THREE.Vector2(1, 1), outline = { width: 1.6, color: '#151923' }) {
    this.bindings = [];
    this.records = new Map();
    this.viewport = viewport;
    this.outlineWidth = { value: outline.width };
    this.outlineColor = new THREE.Color(outline.color);
    this.gradient = new THREE.DataTexture(new Uint8Array([64, 255]), 2, 1, THREE.RedFormat);
    this.gradient.name = 'Viewport Toon · 2 tones';
    this.gradient.colorSpace = THREE.NoColorSpace; // linear lighting weights, not display colors
    this.gradient.minFilter = this.gradient.magFilter = THREE.NearestFilter;
    this.gradient.generateMipmaps = false;
    this.gradient.needsUpdate = true;
    object.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.material) return;
      this.bindings.push({ mesh, original: mesh.material });
      for (const source of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!source || source.isShaderMaterial || this.records.has(source)) continue;
        this.records.set(source, { source, variants: {}, hull: createHullMaterial(source, viewport, this.outlineWidth) });
      }
    });
    this.mode = 'lambert';
  }

  createHulls() {
    for (const binding of this.bindings) {
      if (binding.hull) continue;
      if (binding.mesh.isBatchedMesh) continue;
      if (!binding.mesh.geometry.attributes.normal) binding.mesh.geometry.computeVertexNormals();
      const hullFor = (source) => this.records.get(source)?.hull || new THREE.MeshBasicMaterial({ visible: false });
      const materials = Array.isArray(binding.original) ? binding.original.map(hullFor) : hullFor(binding.original);
      binding.smooth = new SmoothHullGeometry(binding.mesh.geometry);
      binding.hull = createHullMesh(binding.mesh, materials, binding.smooth.geometry);
      binding.hull.visible = false;
    }
  }

  variant(source, mode) {
    const record = this.records.get(source);
    if (!record) return source; // custom shaders keep their own rendering contract
    if (!record.variants[mode]) {
      const material = mode === 'lambert' && source.isMeshLambertMaterial ? source
        : mode === 'toon' ? new THREE.MeshToonMaterial() : new THREE.MeshLambertMaterial();
      if (material !== source) {
        THREE.Material.prototype.copy.call(material, source);
        delete material.userData.shPatched;
        if (mode === 'toon') material.gradientMap = this.gradient;
      }
      record.variants[mode] = material;
    }
    return record.variants[mode];
  }

  sync() {
    for (const { source, variants, hull } of this.records.values()) {
      let hullChanged = false;
      for (const key of ['map', 'alphaMap', 'opacity', 'transparent']) {
        if (hull[key] !== (source[key] ?? (key === 'opacity' ? 1 : key === 'transparent' ? false : null))) {
          hull[key] = source[key] ?? (key === 'opacity' ? 1 : key === 'transparent' ? false : null);
          hullChanged = true;
        }
      }
      hull.alphaTest = Math.max(source.alphaTest || 0, source.transparent ? 0.5 : 0);
      hull.visible = source.visible && !source.wireframe && this.outlineWidth.value > 0;
      hull.color.copy(this.outlineColor);
      if (hullChanged) hull.needsUpdate = true;
      for (const material of Object.values(variants)) {
        if (material === source) continue;
        let changed = false;
        for (const key of SURFACE_KEYS) {
          if (!(key in source) || !(key in material)) continue;
          const value = source[key];
          if (value?.isColor || value?.isVector2) material[key].copy(value);
          else if (material[key] !== value) { material[key] = value; changed = true; }
        }
        // A late PMX alpha/texture load can change the required shader defines.
        if (changed) material.needsUpdate = true;
      }
    }
  }

  apply(mode) {
    if (!['lambert', 'toon'].includes(mode)) throw new Error(`Unknown viewport mode: ${mode}`);
    this.mode = mode;
    if (mode === 'toon') this.createHulls();
    for (const { mesh, original, hull } of this.bindings) {
      mesh.material = Array.isArray(original) ? original.map((source) => this.variant(source, mode)) : this.variant(original, mode);
      if (hull) hull.visible = mode === 'toon';
    }
    this.sync();
    this.updateOutlines();
  }

  updateOutlines() {
    if (this.mode !== 'toon' || this.outlineWidth.value <= 0) return;
    for (const { mesh, smooth } of this.bindings) smooth?.update(mesh);
  }

  setOutline(width, color) {
    this.outlineWidth.value = width;
    this.outlineColor.set(color);
    this.sync();
  }

  dispose() {
    for (const { mesh, original, hull, smooth } of this.bindings) {
      mesh.material = original;
      if (hull) {
        mesh.remove(hull);
        smooth.geometry.dispose();
        for (const material of Array.isArray(hull.material) ? hull.material : [hull.material]) {
          if (!material.userData.viewportOutline) material.dispose();
        }
        if (hull.isInstancedMesh) { hull.morphTexture = null; hull.dispose(); }
      }
    }
    for (const { source, variants, hull } of this.records.values()) {
      for (const material of Object.values(variants)) if (material !== source) material.dispose();
      hull.dispose();
    }
    this.gradient.dispose();
    this.records.clear();
    this.bindings.length = 0;
  }
}
