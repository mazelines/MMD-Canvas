import * as THREE from 'three';

// Spatial welding is only used for the outline. UVs, indices and surface normals stay intact.
export function weldPositions(position) {
  const bounds = new THREE.Box3().setFromBufferAttribute(position);
  const size = bounds.getSize(new THREE.Vector3());
  const epsilon = Math.max(Math.max(size.x, size.y, size.z) * 1e-6, 1e-8);
  const cells = new Map(), representatives = [], groups = new Uint32Array(position.count);
  // Integer spatial hashes avoid millions of temporary strings on unindexed imports.
  // Hash collisions are harmless because every candidate gets a distance check.
  const key = (x, y, z) => Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const cx = Math.floor((x - bounds.min.x) / epsilon), cy = Math.floor((y - bounds.min.y) / epsilon), cz = Math.floor((z - bounds.min.z) / epsilon);
    let found = -1;
    const cell = key(cx, cy, cz);
    for (const group of cells.get(cell) || []) {
      const p = representatives[group];
      if ((x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2 <= epsilon * epsilon) { found = group; break; }
    }
    search: for (let dx = -1; found < 0 && dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      for (const group of cells.get(key(cx + dx, cy + dy, cz + dz)) || []) {
        const p = representatives[group];
        if ((x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2 <= epsilon * epsilon) { found = group; break search; }
      }
    }
    if (found < 0) {
      found = representatives.length;
      representatives.push([x, y, z]);
      if (!cells.has(cell)) cells.set(cell, []);
      cells.get(cell).push(found);
    }
    groups[i] = found;
  }
  return { groups, count: representatives.length };
}

/** Angle weighting avoids UV seams and diagonal-dependent normals on triangulated faces. */
export function calculateSmoothNormals(positions, index, weld, output, sums = new Float64Array(weld.count * 3)) {
  sums.fill(0);
  const total = index ? index.count : positions.length / 3;
  for (let i = 0; i + 2 < total; i += 3) {
    const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(length) || length < 1e-20) continue;
    const dot = ux * vx + uy * vy + uz * vz;
    const angleA = Math.atan2(length, dot);
    const angleB = Math.atan2(length, ux * ux + uy * uy + uz * uz - dot);
    const angleC = Math.max(0, Math.PI - angleA - angleB);
    for (let corner = 0; corner < 3; corner++) {
      const group = weld.groups[corner === 0 ? a : corner === 1 ? b : c] * 3;
      const weight = (corner === 0 ? angleA : corner === 1 ? angleB : angleC) / length;
      sums[group] += nx * weight; sums[group + 1] += ny * weight; sums[group + 2] += nz * weight;
    }
  }
  for (let group = 0; group < weld.count; group++) {
    const offset = group * 3, length = Math.hypot(sums[offset], sums[offset + 1], sums[offset + 2]);
    if (length > 1e-12) { sums[offset] /= length; sums[offset + 1] /= length; sums[offset + 2] /= length; }
    else { sums[offset] = 0; sums[offset + 1] = 1; sums[offset + 2] = 0; }
  }
  for (let i = 0; i < weld.groups.length; i++) {
    const offset = weld.groups[i] * 3;
    output[i * 3] = sums[offset]; output[i * 3 + 1] = sums[offset + 1]; output[i * 3 + 2] = sums[offset + 2];
  }
}

export class SmoothHullGeometry {
  constructor(source) {
    this.source = source;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.index = source.index;
    for (const [name, attribute] of Object.entries(source.attributes)) this.geometry.setAttribute(name, attribute);
    this.geometry.groups = source.groups.map((group) => ({ ...group }));
    this.geometry.drawRange = { ...source.drawRange };
    this.geometry.boundingBox = source.boundingBox;
    this.geometry.boundingSphere = source.boundingSphere;
    this.geometry.morphAttributes = { ...source.morphAttributes };
    delete this.geometry.morphAttributes.normal; // already recomputed from the morphed positions
    this.geometry.morphTargetsRelative = source.morphTargetsRelative;
    const position = source.attributes.position;
    this.weld = weldPositions(position);
    this.positions = new Float32Array(position.count * 3);
    this.sums = new Float64Array(this.weld.count * 3);
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(position.count * 3), 3));
    this.signature = null;
  }

  update(mesh) {
    const position = this.source.attributes.position;
    const morphs = this.source.morphAttributes.position || [];
    const weights = mesh.morphTargetInfluences || [];
    const signature = `${position.version ?? position.data?.version ?? 0}|${this.source.index?.version || 0}|${weights.join(',')}|${morphs.map((m) => m.version ?? m.data?.version ?? 0).join(',')}`;
    if (signature === this.signature) return false;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      let px = x, py = y, pz = z;
      for (let j = 0; j < morphs.length; j++) {
        const weight = weights[j] || 0;
        if (!weight) continue;
        const target = morphs[j], relative = this.source.morphTargetsRelative;
        px += (target.getX(i) - (relative ? 0 : x)) * weight;
        py += (target.getY(i) - (relative ? 0 : y)) * weight;
        pz += (target.getZ(i) - (relative ? 0 : z)) * weight;
      }
      this.positions[i * 3] = px; this.positions[i * 3 + 1] = py; this.positions[i * 3 + 2] = pz;
    }
    calculateSmoothNormals(this.positions, this.source.index, this.weld, this.geometry.attributes.normal.array, this.sums);
    this.geometry.attributes.normal.needsUpdate = true;
    this.signature = signature;
    return true;
  }
}
