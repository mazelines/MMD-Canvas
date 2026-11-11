// Writes a dense, self-shadowing OBJ (torus knot) for viewer / shadow performance checks.
// usage: node tests/make-heavy.js [out.obj] [tubularSegments] [radialSegments]
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const out = process.argv[2] || 'tests/out/heavy.obj';
const tubular = Number(process.argv[3] || 1500);
const radial = Number(process.argv[4] || 128);
const g = new THREE.TorusKnotGeometry(5, 1.6, tubular, radial, 2, 3);
const p = g.attributes.position, n = g.attributes.normal, idx = g.index;
const lines = [];
for (let i = 0; i < p.count; i++) lines.push(`v ${p.getX(i).toFixed(5)} ${(p.getY(i) + 9).toFixed(5)} ${p.getZ(i).toFixed(5)}`);
for (let i = 0; i < n.count; i++) lines.push(`vn ${n.getX(i).toFixed(4)} ${n.getY(i).toFixed(4)} ${n.getZ(i).toFixed(4)}`);
for (let i = 0; i < idx.count; i += 3) {
  const a = idx.getX(i) + 1, b = idx.getX(i + 1) + 1, c = idx.getX(i + 2) + 1;
  lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${out}: ${idx.count / 3} triangles`);
