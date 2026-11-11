import { t } from '../src/i18n/index.js';
// three.js viewer: loads PMX (own parser) and common 3D formats (three.js loaders).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { parsePmx } from '../src/core/pmx-parser.js';
import { buildScene } from '../src/core/scene.js';
import { SoftShadows } from './shadows.js';
import { collectMaterials } from './material-info.js';
import { ViewportShading } from './viewport-shading.js';
import { LinearViewportPipeline } from './color-pipeline.js';
import { DEFAULT_LIGHT_LUX, DEFAULT_AMBIENT_LUX, clampLightLux } from '../src/core/lighting.js';

export const VIEWABLE = ['.pmx', '.fbx', '.glb', '.gltf', '.obj', '.stl', '.ply', '.dae', '.3mf', '.usdz', '.usda', '.usd', '.usdc'];

/** Local path -> app://fs/ URL (each segment encoded so relative resolution keeps working). */
export function fileUrl(p) {
  return 'app://fs/' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '');
const extname = (p) => { const m = /\.[^.\\/]+$/.exec(p); return m ? m[0].toLowerCase() : ''; };

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.colorPipeline = new LinearViewportPipeline(this.renderer);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x22252c);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0;

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    this.camera.position.set(0, 12, 40);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.requestRender());

    // The fill is a separate, visible setting: the lux control still measures the directional light only.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xb4b8c0, DEFAULT_AMBIENT_LUX);
    this.sun = new THREE.DirectionalLight(0xffffff, DEFAULT_LIGHT_LUX);
    this.sun.position.set(-0.4, 1, 0.8);
    this.scene.add(this.hemi, this.sun);

    this.grid = new THREE.GridHelper(10, 10, 0x5a6070, 0x363a44);
    this.colorPipeline.protectEditorObject(this.grid);
    this.scene.add(this.grid);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.current = null;        // { object, kind, pmx?, sceneData?, materials? }
    this.renderMode = 'lambert';
    this.outlineSettings = { width: 1.6, color: '#151923' };
    this.skeleton = null;
    this.flags = { wireframe: false, skeleton: false, grid: true };
    this.loadToken = 0;
    this.needsRender = true;

    // PCSS soft shadows for the sun
    this.shadows = new SoftShadows(this.renderer);
    this.scene.add(this.shadows.ground);
    this.shadow = { enabled: false, softness: 0.03, dirty: false };
    this.lightLevel = DEFAULT_LIGHT_LUX;
    this.ambientLevel = DEFAULT_AMBIENT_LUX;

    // light direction gizmo: a sun icon + rotate handles, like a directional light in an engine editor
    this.lightRig = makeSunIcon();
    this.lightRig.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.sun.position.clone().normalize());
    this.scene.add(this.lightRig);
    this.lightControls = new TransformControls(this.camera, this.renderer.domElement);
    this.lightControls.setMode('rotate');
    this.lightControls.setSpace('local');
    this.lightControls.setSize(0.75);
    this.lightControls.attach(this.lightRig);
    this.lightGizmo = this.lightControls.getHelper();
    this.colorPipeline.protectEditorObject(this.lightRig);
    this.colorPipeline.protectEditorObject(this.lightGizmo);
    this.scene.add(this.lightGizmo);
    this.lightControls.addEventListener('dragging-changed', (ev) => { this.controls.enabled = !ev.value; });
    this.lightControls.addEventListener('change', () => this.requestRender());
    this.lightControls.addEventListener('objectChange', () => this.syncLightFromRig(true));
    this.onLightDirection = null;
    this.setLightGizmo(false);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const tick = () => {
      requestAnimationFrame(tick);
      const changed = this.controls.update() || this.needsRender;
      this.needsRender = false;
      if (!changed) return;
      this.current?.shading?.updateOutlines();
      if (this.shadow.enabled && this.current && this.shadow.dirty) this.updateShadowMap();
      this.colorPipeline.render(this.scene, this.camera);
    };
    tick();
  }

  requestRender() { this.needsRender = true; }

  setRenderMode(mode) {
    if (!['lambert', 'toon'].includes(mode)) return;
    this.renderMode = mode;
    if (this.current) {
      this.current.shading.apply(mode);
      for (const binding of this.current.shading.bindings) if (binding.hull) this.colorPipeline.protectEditorObject(binding.hull);
      this.shadows.patch(this.current.object);
    }
    this.setLightIntensity(this.lightLevel);
    this.invalidateShadows();
    this.onMaterialsChanged?.();
  }

  refreshMaterialTextures() {
    this.current?.shading?.sync();
    this.invalidateShadows();
    this.onMaterialsChanged?.();
  }

  setOutline(width, color) {
    if (!Number.isFinite(width) || !/^#[0-9a-f]{6}$/i.test(color)) return;
    this.outlineSettings = { width: Math.min(8, Math.max(0, width)), color };
    this.current?.shading?.setOutline(this.outlineSettings.width, color);
    this.requestRender();
  }

  /** Physical directional-light illuminance; passed unchanged to the light uniform. */
  setLightIntensity(lux) {
    this.lightLevel = clampLightLux(lux);
    this.sun.intensity = this.lightLevel;
    this.requestRender();
  }

  /** Hemisphere fill illuminance in lux (0 = none: unlit faces go black). */
  setAmbientIntensity(lux) {
    this.ambientLevel = Number.isFinite(lux) ? clampLightLux(lux) : DEFAULT_AMBIENT_LUX;
    this.hemi.intensity = this.ambientLevel;
    this.requestRender();
  }

  get exposure() { return this.colorPipeline.exposure; }

  setExposure(ev100, compensation = 0) {
    this.colorPipeline.setExposure(ev100, compensation);
    this.requestRender();
  }

  getMaterialEmission(index) {
    const source = this.current?.materials[index]?.material;
    return source ? this.current.shading.getEmission(source) : null;
  }

  setMaterialEmission(index, nits) {
    const source = this.current?.materials[index]?.material;
    if (!source) return;
    this.current.shading.setEmission(source, nits);
    this.requestRender();
  }

  // ---------- light direction ----------
  /** @param {number[]|THREE.Vector3} dir world-space direction towards the light */
  setLightDirection(dir, notify = false) {
    const d = (Array.isArray(dir) ? new THREE.Vector3(...dir) : dir.clone()).normalize();
    if (!Number.isFinite(d.x + d.y + d.z) || d.lengthSq() < 0.5) return;
    this.lightRig.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
    this.syncLightFromRig(notify);
  }

  resetLightDirection() { this.setLightDirection([-0.4, 1, 0.8], true); }

  syncLightFromRig(notify) {
    const d = new THREE.Vector3(0, 0, 1).applyQuaternion(this.lightRig.quaternion).normalize();
    this.sun.position.copy(d);
    this.shadows.setLight(d, this.shadow.softness);
    this.shadow.dirty = true;
    if (notify) this.onLightDirection?.(d.toArray());
    this.requestRender();
  }

  /** @param {'translate'|'rotate'} mode move the light icon, or turn the light */
  setLightGizmoMode(mode) {
    this.lightControls.setMode(mode);
    this.requestRender();
  }

  /** @param {'local'|'world'} space axes of the gizmo handles */
  setLightGizmoSpace(space) {
    this.lightControls.setSpace(space);
    this.requestRender();
  }

  setLightGizmo(visible) {
    this.lightRig.visible = visible;
    this.lightGizmo.visible = visible;
    this.lightControls.enabled = visible;
    this.requestRender();
  }

  /** Average milliseconds per frame, shadow map included (forces the GPU to finish each one). */
  benchmark(frames = 20) {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const run = () => {
      this.current?.shading?.updateOutlines();
      if (this.shadow.enabled && this.current) this.updateShadowMap();
      this.colorPipeline.render(this.scene, this.camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    run(); run();
    const t = performance.now();
    for (let i = 0; i < frames; i++) run();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { msPerFrame: +((performance.now() - t) / frames).toFixed(2), width: size.x, height: size.y, lost: gl.isContextLost() };
  }

  // ---------- shadows ----------
  setShadows(enabled) {
    this.shadow.enabled = enabled;
    this.shadow.dirty = true;
    this.shadows.setEnabled(enabled);
    this.setLightIntensity(this.lightLevel);
  }

  /** @param {number} radius tan of the light's angular radius (0 = hard shadows) */
  setShadowSoftness(radius) {
    this.shadow.softness = radius;
    this.shadows.setLight(this.sun.position, radius);
    this.requestRender();
  }

  /** The shadow map no longer matches the model (morph, material visibility, late texture, light). */
  invalidateShadows() {
    this.shadow.dirty = true;
    this.requestRender();
  }

  updateShadowMap() {
    this.shadow.dirty = false;
    this.shadows.setLight(this.sun.position, this.shadow.softness);
    this.shadows.renderMap(this.current.object);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.colorPipeline.resize();
    this.current?.shading?.viewport.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  clear() {
    if (this.skeleton) { this.scene.remove(this.skeleton); disposeObject(this.skeleton); this.skeleton = null; }
    if (this.current) { this.current.shading?.dispose(); this.root.remove(this.current.object); disposeObject(this.current.object); this.current = null; }
    this.shadows.clear();
    this.shadow.dirty = false;
    this.requestRender();
  }

  /** @returns {Promise<object>} info about the loaded model */
  async load(filePath) {
    const token = ++this.loadToken;
    const ext = extname(filePath);
    let loaded;
    if (ext === '.pmx') loaded = await this.loadPmx(filePath);
    else loaded = await this.loadGeneric(filePath, ext);
    if (token !== this.loadToken) { disposeObject(loaded.object); return null; } // superseded by a newer load
    this.clear();
    this.current = loaded;
    loaded.materials = collectMaterials(loaded.object);
    loaded.info.materialNames = loaded.materials.map((entry) => entry.name);
    loaded.shading = new ViewportShading(loaded.object, new THREE.Vector2(this.container.clientWidth || 1, this.container.clientHeight || 1), this.outlineSettings);
    loaded.shading.apply(this.renderMode);
    for (const binding of loaded.shading.bindings) if (binding.hull) this.colorPipeline.protectEditorObject(binding.hull);
    this.root.add(loaded.object);
    this.shadows.patch(loaded.object);
    this.applyFlags();
    this.frame();
    this.invalidateShadows();
    const info = { ...loaded.info, ...countGeometry(loaded.object) };
    loaded.info = info;
    return info;
  }

  // ---------- PMX ----------
  async loadPmx(filePath) {
    const res = await fetch(fileUrl(filePath));
    if (!res.ok) throw new Error(t`파일을 읽을 수 없습니다: ${filePath}`);
    const pmx = parsePmx(await res.arrayBuffer());
    const data = buildScene(pmx, { scale: 1 });
    const baseDir = dirname(filePath);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(data.positions); // working copy (morphs modify it)
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

    const manager = new THREE.LoadingManager();
    manager.onLoad = () => this.refreshMaterialTextures();
    const texLoader = new THREE.TextureLoader(manager);
    const tgaLoader = new TGALoader(manager);
    const ddsLoader = new DDSLoader(manager);
    const cache = new Map();
    const missing = [];
    const loadTexture = (rel, onAlpha) => {
      const key = rel.toLowerCase();
      let entry = cache.get(key);
      if (!entry) {
        const url = fileUrl(`${baseDir}/${rel.trim().replace(/\\/g, '/')}`);
        const ext = extname(rel);
        const loader = ext === '.tga' ? tgaLoader : ext === '.dds' ? ddsLoader : texLoader;
        entry = { listeners: [], hasAlpha: null };
        entry.texture = loader.load(url, (t) => {
          t.userData.loadStatus = 'loaded';
          t.colorSpace = THREE.SRGBColorSpace;
          entry.hasAlpha = ext === '.dds' ? false : textureUsesAlpha(t);
          entry.listeners.forEach((fn) => fn(entry.hasAlpha));
          this.requestRender();
        }, undefined, () => { missing.push(rel); entry.texture.userData.loadStatus = 'error'; this.onMaterialsChanged?.(); });
        entry.texture.userData.sourcePath = rel;
        entry.texture.userData.loadStatus = 'pending';
        entry.texture.colorSpace = THREE.SRGBColorSpace;
        entry.texture.wrapS = entry.texture.wrapT = THREE.RepeatWrapping;
        cache.set(key, entry);
      }
      if (entry.hasAlpha === null) entry.listeners.push(onAlpha); else onAlpha(entry.hasAlpha);
      return entry.texture;
    };

    const materials = data.materials.map((m, materialIndex) => {
      const mat = new THREE.MeshLambertMaterial({
        name: m.name,
        color: new THREE.Color().setRGB(...(m.texture ? [1, 1, 1] : m.baseColor), THREE.SRGBColorSpace),
        opacity: m.alpha,
        transparent: m.alpha < 0.999,
        side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      });
      mat.userData.pmx = pmx.materials[materialIndex];
      mat.userData.pmxTextures = { sphere: m.sphereTexture, toon: m.toonTexture };
      if (m.texture) {
        mat.map = loadTexture(m.texture, (hasAlpha) => {
          if (hasAlpha && !mat.transparent) { mat.transparent = true; mat.alphaTest = 0.02; mat.needsUpdate = true; }
          this.invalidateShadows();
        });
      }
      geometry.addGroup(m.indexStart, m.indexCount, materialIndex);
      return mat;
    });

    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = data.name;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return {
      kind: 'pmx',
      object: mesh,
      pmx,
      data,
      basePositions: data.positions,
      morphWeights: new Float32Array(data.morphs.length),
      missingTextures: missing,
      info: {
        kind: 'pmx',
        name: pmx.name, nameEn: pmx.nameEn, comment: pmx.comment,
        format: `PMX ${pmx.version.toFixed(1)} (${pmx.encoding})`,
        bones: pmx.bones.length, morphs: pmx.morphs.length, textures: data.textures.length,
        rigidBodies: pmx.rigidBodyCount, joints: pmx.jointCount,
        materialNames: data.materials.map((m) => m.name),
        morphList: data.morphs.map((m) => ({ name: m.name, panel: m.panel })),
        warnings: data.warnings,
      },
    };
  }

  setMorph(index, weight) {
    const c = this.current;
    if (!c || c.kind !== 'pmx') return;
    c.morphWeights[index] = weight;
    this.applyMorphs();
  }

  setMorphWeights(weights) {
    const c = this.current;
    if (!c || c.kind !== 'pmx' || weights.length !== c.morphWeights.length) return;
    c.morphWeights.set(weights);
    this.applyMorphs();
  }

  applyMorphs() {
    const c = this.current;
    if (!c || c.kind !== 'pmx') return;
    const pos = c.object.geometry.attributes.position;
    pos.array.set(c.basePositions);
    c.data.morphs.forEach((m, mi) => {
      const w = c.morphWeights[mi];
      if (!w) return;
      for (let k = 0; k < m.indices.length; k++) {
        const v = m.indices[k] * 3;
        pos.array[v] += m.offsets[k * 3] * w;
        pos.array[v + 1] += m.offsets[k * 3 + 1] * w;
        pos.array[v + 2] += m.offsets[k * 3 + 2] * w;
      }
    });
    pos.needsUpdate = true;
    // Morph edits change both culling bounds and the tightly fitted shadow projection.
    // Refresh them without calling frame(), which would reset the user's camera.
    c.object.geometry.computeBoundingBox();
    c.object.geometry.computeBoundingSphere();
    this.shadows.fit(new THREE.Box3().setFromObject(c.object));
    this.invalidateShadows();
    this.requestRender();
  }

  setMaterialVisible(index, visible) {
    const entry = this.current?.materials[index];
    if (!entry) return;
    entry.material.visible = visible;
    this.current.shading?.sync();
    this.invalidateShadows();
    this.requestRender();
  }

  // ---------- other formats ----------
  async loadGeneric(filePath, ext) {
    const url = fileUrl(filePath);
    const manager = new THREE.LoadingManager();
    manager.addHandler(/\.tga$/i, new TGALoader(manager));
    manager.addHandler(/\.dds$/i, new DDSLoader(manager));
    manager.onLoad = () => this.refreshMaterialTextures();
    let object;
    const basic = () => new THREE.MeshStandardMaterial({ color: 0xb8bcc6, roughness: 0.7, metalness: 0.05 });
    switch (ext) {
      case '.fbx': {
        const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
        object = await new FBXLoader(manager).loadAsync(url);
        break;
      }
      case '.glb': case '.gltf': {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        object = (await new GLTFLoader(manager).loadAsync(url)).scene;
        break;
      }
      case '.obj': {
        const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
        const loader = new OBJLoader(manager);
        try {
          const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
          const mtl = await new MTLLoader(manager).loadAsync(url.replace(/\.obj$/i, '.mtl'));
          mtl.preload();
          loader.setMaterials(mtl);
        } catch { /* no .mtl next to the .obj */ }
        object = await loader.loadAsync(url);
        break;
      }
      case '.stl': {
        const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
        const g = await new STLLoader(manager).loadAsync(url);
        object = new THREE.Mesh(g, basic());
        break;
      }
      case '.ply': {
        const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
        const g = await new PLYLoader(manager).loadAsync(url);
        if (!g.attributes.normal) g.computeVertexNormals();
        const mat = basic();
        if (g.attributes.color) { mat.vertexColors = true; mat.color.set(0xffffff); }
        object = g.index ? new THREE.Mesh(g, mat) : new THREE.Points(g, new THREE.PointsMaterial({ size: 0.01, vertexColors: !!g.attributes.color }));
        break;
      }
      case '.dae': {
        const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
        object = (await new ColladaLoader(manager).loadAsync(url)).scene;
        break;
      }
      case '.3mf': {
        const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
        object = await new ThreeMFLoader(manager).loadAsync(url);
        break;
      }
      case '.usdz': case '.usda': case '.usd': case '.usdc': {
        const { USDLoader } = await import('three/addons/loaders/USDLoader.js');
        object = await new USDLoader(manager).loadAsync(url);
        break;
      }
      default:
        throw new Error(t`지원하지 않는 형식입니다: ${ext}`);
    }
    if (!object) throw new Error(t('모델을 불러오지 못했습니다.'));
    let bones = 0;
    const materialNames = new Set();
    object.traverse((o) => {
      if (o.isBone) bones++;
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => materialNames.add(m.name || t('(이름 없음)')));
    });
    return {
      kind: 'generic',
      object,
      info: {
        kind: 'generic',
        name: filePath.replace(/^.*[\\/]/, ''),
        format: ext.slice(1).toUpperCase(),
        bones,
        materialNames: [...materialNames],
        morphList: [],
        warnings: [],
      },
    };
  }

  // ---------- view helpers ----------
  frame() {
    const c = this.current;
    if (!c) return;
    // bones must have up-to-date world matrices before skinned bounds are measured
    c.object.updateMatrixWorld(true);
    c.object.traverse((o) => { if (o.isSkinnedMesh) { o.skeleton?.update(); o.computeBoundingBox(); o.computeBoundingSphere(); } });
    const box = new THREE.Box3().setFromObject(c.object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-4);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.08;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.25, 0.12, 1).normalize().multiplyScalar(dist));
    this.camera.near = dist / 200;
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = dist * 20;

    // grid sized to the model, sitting at its feet
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(size.x, size.y, size.z) / 4 || 1)));
    const cells = Math.max(10, Math.ceil((Math.max(size.x, size.z) * 2.5) / step / 2) * 2);
    this.grid = new THREE.GridHelper(step * cells, cells, 0x5a6070, 0x363a44);
    this.colorPipeline.protectEditorObject(this.grid);
    this.grid.position.set(Math.round(center.x / step) * step, box.min.y, Math.round(center.z / step) * step);
    this.grid.visible = this.flags.grid;
    this.scene.add(this.grid);
    this.shadows.fit(box);
    this.shadow.dirty = true;
    this.lightRig.position.set(box.min.x - radius * 0.25, box.max.y, center.z);
    this.lightRig.scale.setScalar(radius * 0.09);
    this.buildSkeleton(radius);
    this.requestRender();
  }

  buildSkeleton(radius) {
    if (this.skeleton) { this.scene.remove(this.skeleton); disposeObject(this.skeleton); this.skeleton = null; }
    const c = this.current;
    if (!c) return;
    const group = new THREE.Group();
    if (c.kind === 'pmx') {
      const bones = c.data.bones;
      const lines = [], points = [];
      for (const b of bones) {
        points.push(...b.position);
        if (b.parent >= 0) lines.push(...bones[b.parent].position, ...b.position);
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      group.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x4fd1ff, depthTest: false, transparent: true })));
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      group.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffd24f, size: 5, sizeAttenuation: false, depthTest: false, transparent: true })));
    } else {
      let hasBones = false;
      c.object.traverse((o) => { if (o.isBone) hasBones = true; });
      if (hasBones) {
        const helper = new THREE.SkeletonHelper(c.object);
        helper.material.depthTest = false;
        group.add(helper);
      }
    }
    group.renderOrder = 999;
    group.traverse((o) => { o.renderOrder = 999; });
    group.visible = this.flags.skeleton;
    this.skeleton = group;
    this.colorPipeline.protectEditorObject(group);
    this.scene.add(group);
    void radius;
  }

  setFlag(name, value) {
    this.flags[name] = value;
    this.applyFlags();
  }

  applyFlags() {
    this.grid.visible = this.flags.grid;
    if (this.skeleton) this.skeleton.visible = this.flags.skeleton;
    if (this.current) {
      this.current.materials?.forEach(({ material }) => { if ('wireframe' in material) material.wireframe = this.flags.wireframe; });
      this.current.object.traverse((o) => {
        if (!o.material || o.userData.viewportOutline) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if ('wireframe' in m) m.wireframe = this.flags.wireframe; });
      });
      this.current.shading?.sync();
    }
    this.requestRender();
  }

  setBackground(hex) {
    this.scene.background = new THREE.Color(hex);
    this.requestRender();
  }
}

/** Directional light icon: a disc with parallel rays along local -Z (the way the light travels). */
function makeSunIcon() {
  const pts = [];
  const N = 32;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, b = ((i + 1) / N) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), -3);
  }
  pts.push(0, 0, 0, 0, 0, -4.5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const icon = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd24f, depthTest: false, transparent: true }));
  icon.renderOrder = 998;
  return icon;
}

function countGeometry(object) {
  let vertices = 0, triangles = 0, meshes = 0;
  object.traverse((o) => {
    if (!o.geometry || o.userData.viewportOutline) return;
    meshes++;
    const g = o.geometry;
    vertices += g.attributes.position ? g.attributes.position.count : 0;
    if (o.isMesh) triangles += (g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3;
  });
  return { vertices, triangles: Math.round(triangles), meshes };
}

function disposeObject(object) {
  object.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      });
    }
  });
}

/** True when the texture has meaningfully transparent pixels (sampled on a small canvas). */
function textureUsesAlpha(texture) {
  try {
    const img = texture.image;
    if (!img) return false;
    if (img.data && img.width) { // DataTexture (TGA)
      const d = img.data, step = Math.max(1, Math.floor(d.length / 4 / 20000)) * 4;
      for (let i = 3; i < d.length; i += step) if (d[i] < 250) return true;
      return false;
    }
    const size = 96;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  } catch { /* treat as opaque */ }
  return false;
}
