import { t } from '../i18n/index.js';
// Turns a parsed PMX into a normalised, exporter-friendly scene:
//  - right-handed, Y-up (Z negated, triangle winding reversed)
//  - UV origin bottom-left (v flipped)
//  - bones topologically sorted (parent always before child)
//  - skin weights cleaned and normalised
//  - vertex morphs (and group morphs made only of vertex morphs) as sparse deltas
// Pure JS: shared by the viewer (renderer) and the exporters (Node).

import { MORPH_TYPE } from './pmx-parser.js';
import { pickName, uniquify } from './names.js';

export const DEFAULT_SCENE_OPTIONS = {
  scale: 8,              // 1 MMD unit = 8 cm -> output in centimetres
  nameMode: 'original',  // 'original' | 'english'
  translateBones: true,  // with nameMode 'english': dictionary-translate standard bone names
  morphs: true,
};

function sortBones(bones) {
  const n = bones.length;
  const order = [];
  const state = new Uint8Array(n); // 0 = new, 1 = visiting, 2 = done
  const parentOf = bones.map((b, i) => (b.parent >= 0 && b.parent < n && b.parent !== i ? b.parent : -1));
  for (let i = 0; i < n; i++) {
    if (state[i]) continue;
    // walk up to the first unplaced ancestor, then emit downwards
    const chain = [];
    let c = i;
    while (c !== -1 && state[c] === 0) { state[c] = 1; chain.push(c); c = parentOf[c]; }
    if (c !== -1 && state[c] === 1) parentOf[chain[chain.length - 1]] = -1; // cycle: cut it
    for (let k = chain.length - 1; k >= 0; k--) { order.push(chain[k]); state[chain[k]] = 2; }
  }
  return { order, parentOf };
}

export function buildScene(pmx, options = {}) {
  const opt = { ...DEFAULT_SCENE_OPTIONS, ...options };
  const s = opt.scale;
  const warnings = [...(pmx.warnings || [])];
  const vCount = pmx.vertexCount;

  // ---- geometry ----
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  for (let i = 0; i < vCount; i++) {
    const p = i * 3;
    positions[p] = pmx.positions[p] * s;
    positions[p + 1] = pmx.positions[p + 1] * s;
    positions[p + 2] = -pmx.positions[p + 2] * s;
    let nx = pmx.normals[p], ny = pmx.normals[p + 1], nz = -pmx.normals[p + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-8) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
    normals[p] = nx; normals[p + 1] = ny; normals[p + 2] = nz;
    uvs[i * 2] = pmx.uvs[i * 2];
    uvs[i * 2 + 1] = 1 - pmx.uvs[i * 2 + 1];
  }

  // ---- materials / triangles ----
  const src = pmx.indices;
  const indices = new Uint32Array(src.length - (src.length % 3));
  let w = 0, dropped = 0;
  const materials = [];
  const matNames = uniquify(pmx.materials.map((m) => pickName(m, opt.nameMode)), 'material');
  pmx.materials.forEach((m, mi) => {
    const start = w;
    const end = Math.min(m.indexStart + m.indexCount, src.length);
    for (let i = m.indexStart; i + 2 < end; i += 3) {
      const a = src[i], b = src[i + 1], c = src[i + 2];
      if (a >= vCount || b >= vCount || c >= vCount) { dropped++; continue; }
      indices[w++] = a; indices[w++] = c; indices[w++] = b; // reversed winding
    }
    if (w === start) return; // material without faces
    const texPath = (idx) => (idx >= 0 && idx < pmx.textures.length ? pmx.textures[idx] : null);
    materials.push({
      name: matNames[mi],
      sourceIndex: mi,
      diffuse: m.diffuse.slice(0, 3),
      // MMD shades as diffuse * light(0.6) + ambient; this is the closest single flat colour
      baseColor: [0, 1, 2].map((k) => Math.min(1, Math.max(0, m.diffuse[k] * 0.6 + m.ambient[k]))),
      alpha: m.diffuse[3],
      specular: m.specular.slice(),
      shininess: m.shininess,
      ambient: m.ambient.slice(),
      doubleSided: m.doubleSided,
      texture: texPath(m.textureIndex),
      sphereTexture: texPath(m.sphereIndex),
      sphereMode: m.sphereMode,
      toonTexture: m.sharedToon ? null : texPath(m.toonIndex),
      indexStart: start,
      indexCount: w - start,
    });
  });
  if (dropped) warnings.push(t`범위를 벗어난 정점을 참조하는 삼각형 ${dropped}개를 제외했습니다.`);
  const finalIndices = indices.subarray(0, w);

  // ---- bones ----
  const { order, parentOf } = sortBones(pmx.bones);
  const remap = new Int32Array(pmx.bones.length).fill(-1);
  order.forEach((oldIdx, newIdx) => { remap[oldIdx] = newIdx; });
  const boneNames = uniquify(order.map((oi) => pickName(pmx.bones[oi], opt.nameMode, opt.translateBones)), 'bone');
  const bones = order.map((oi, ni) => {
    const b = pmx.bones[oi];
    const parent = parentOf[oi] === -1 ? -1 : remap[parentOf[oi]];
    const position = [b.position[0] * s, b.position[1] * s, -b.position[2] * s];
    return { name: boneNames[ni], originalName: b.name, sourceIndex: oi, parent, position, local: position, isIk: b.isIk, visible: b.visible };
  });
  for (const b of bones) {
    if (b.parent >= 0) {
      const pp = bones[b.parent].position;
      b.local = [b.position[0] - pp[0], b.position[1] - pp[1], b.position[2] - pp[2]];
    }
  }
  if (bones.length === 0 && vCount > 0) warnings.push(t('본이 없는 모델입니다. 스킨 없이 정적 메시로 내보냅니다.'));

  // ---- skinning ----
  const skinIndices = new Int32Array(vCount * 4);
  const skinWeights = new Float32Array(vCount * 4);
  let fixedSkin = 0;
  if (bones.length) {
    const acc = new Map();
    for (let i = 0; i < vCount; i++) {
      acc.clear();
      for (let k = 0; k < 4; k++) {
        const bi = pmx.skinIndices[i * 4 + k], wt = pmx.skinWeights[i * 4 + k];
        if (bi < 0 || bi >= remap.length || !(wt > 0)) continue;
        const ni = remap[bi];
        acc.set(ni, (acc.get(ni) || 0) + wt);
      }
      let total = 0;
      for (const v of acc.values()) total += v;
      if (total <= 1e-6) { acc.clear(); acc.set(0, 1); total = 1; fixedSkin++; }
      const entries = [...acc.entries()].sort((a, b) => b[1] - a[1]);
      for (let k = 0; k < entries.length && k < 4; k++) {
        skinIndices[i * 4 + k] = entries[k][0];
        skinWeights[i * 4 + k] = entries[k][1] / total;
      }
    }
    if (fixedSkin) warnings.push(t`가중치가 없는 정점 ${fixedSkin}개를 첫 번째 본에 연결했습니다.`);
  }
  const d = pmx.deformCounts || {};
  if (d.SDEF) warnings.push(t`SDEF 정점 ${d.SDEF}개는 일반 2본 선형 스키닝(BDEF2)으로 변환됩니다.`);
  if (d.QDEF) warnings.push(t`QDEF 정점 ${d.QDEF}개는 일반 4본 선형 스키닝(BDEF4)으로 변환됩니다.`);

  // ---- morphs ----
  const morphs = [];
  const skippedMorphs = {};
  if (opt.morphs) {
    const names = uniquify(pmx.morphs.map((m) => pickName(m, opt.nameMode)), 'morph');
    const accumulate = (target, m, weight) => {
      for (let k = 0; k < m.vertexIndices.length; k++) {
        const vi = m.vertexIndices[k];
        if (vi >= vCount) continue;
        let o = target.get(vi);
        if (!o) { o = [0, 0, 0]; target.set(vi, o); }
        o[0] += m.offsets[k * 3] * weight * s;
        o[1] += m.offsets[k * 3 + 1] * weight * s;
        o[2] += -m.offsets[k * 3 + 2] * weight * s;
      }
    };
    pmx.morphs.forEach((m, mi) => {
      const target = new Map();
      if (m.type === MORPH_TYPE.VERTEX) {
        accumulate(target, m, 1);
      } else if (m.type === MORPH_TYPE.GROUP) {
        const kids = m.items.map((it) => ({ m: pmx.morphs[it.morph], w: it.weight }));
        if (!kids.length || !kids.every((k) => k.m && k.m.type === MORPH_TYPE.VERTEX)) {
          skippedMorphs.group = (skippedMorphs.group || 0) + 1;
          return;
        }
        for (const k of kids) accumulate(target, k.m, k.w);
      } else {
        const label = { 2: 'bone', 3: 'uv', 4: 'uv', 5: 'uv', 6: 'uv', 7: 'uv', 8: 'material', 9: 'flip', 10: 'impulse' }[m.type] || 'other';
        skippedMorphs[label] = (skippedMorphs[label] || 0) + 1;
        return;
      }
      if (!target.size) return;
      const keys = [...target.keys()].sort((a, b) => a - b);
      const idx = new Uint32Array(keys.length);
      const off = new Float32Array(keys.length * 3);
      keys.forEach((vi, k) => { idx[k] = vi; off.set(target.get(vi), k * 3); });
      morphs.push({ name: names[mi], originalName: m.name, panel: m.panel, indices: idx, offsets: off });
    });
    const sk = Object.entries(skippedMorphs).map(([k, v]) => t`${k} ${v}개`).join(', ');
    if (sk) warnings.push(t`정점 모프가 아닌 모프는 내보내지 않습니다: ${sk}.`);
  }

  const usedTextures = [...new Set(materials.map((m) => m.texture).filter(Boolean))];
  if (pmx.rigidBodyCount) warnings.push(t`물리(강체 ${pmx.rigidBodyCount}개, 조인트 ${pmx.jointCount}개)는 FBX/USD로 옮겨지지 않습니다.`);

  return {
    name: pickName(pmx, opt.nameMode) || 'Model',
    comment: pmx.comment,
    scale: s,
    vertexCount: vCount,
    positions, normals, uvs,
    indices: finalIndices,
    triangleCount: finalIndices.length / 3,
    materials, bones, skinIndices, skinWeights, morphs,
    textures: usedTextures,
    warnings,
  };
}

/** Axis-aligned bounds of a scene: { min:[x,y,z], max:[x,y,z] } */
export function sceneBounds(scene) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const p = scene.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  if (!p.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
