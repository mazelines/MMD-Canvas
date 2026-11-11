// node tests/run-tests.js            -> core tests
// node tests/run-tests.js --blender  -> additionally imports every output into Blender (if installed)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSample } from './make-sample.js';
import { parsePmx } from '../src/core/pmx-parser.js';
import { buildScene } from '../src/core/scene.js';
import { convertPmxFile } from '../src/core/convert.js';
import { translateName, uniquify, usdIdentifier } from '../src/core/names.js';
import { textureUsesAlpha } from '../src/core/texture-alpha.js';
import { registerShadowTests } from './shadow-tests.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.join(here, 'sample');
const outDir = path.join(here, 'out');
fs.rmSync(outDir, { recursive: true, force: true });

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); }
  });
}

/** Minimal binary FBX reader: validates node framing and returns the node tree. */
function readFbx(buf) {
  assert.equal(buf.toString('latin1', 0, 20), 'Kaydara FBX Binary  ');
  assert.equal(buf.readUInt32LE(23), 7400);
  const readNode = (pos) => {
    const end = buf.readUInt32LE(pos), numProps = buf.readUInt32LE(pos + 4), propLen = buf.readUInt32LE(pos + 8), nameLen = buf[pos + 12];
    if (end === 0) return null;
    const name = buf.toString('latin1', pos + 13, pos + 13 + nameLen);
    let p = pos + 13 + nameLen;
    const props = [];
    for (let i = 0; i < numProps; i++) {
      const t = String.fromCharCode(buf[p++]);
      if (t === 'I') { props.push(buf.readInt32LE(p)); p += 4; }
      else if (t === 'L') { props.push(buf.readBigInt64LE(p)); p += 8; }
      else if (t === 'D') { props.push(buf.readDoubleLE(p)); p += 8; }
      else if (t === 'C') { props.push(buf[p] === 1); p += 1; }
      else if (t === 'S' || t === 'R') { const n = buf.readUInt32LE(p); props.push(t === 'S' ? buf.toString('utf8', p + 4, p + 4 + n) : buf.subarray(p + 4, p + 4 + n)); p += 4 + n; }
      else if (t === 'd' || t === 'i') {
        const count = buf.readUInt32LE(p), enc = buf.readUInt32LE(p + 4), len = buf.readUInt32LE(p + 8);
        let data = buf.subarray(p + 12, p + 12 + len);
        if (enc === 1) data = zlib.inflateSync(data);
        const size = t === 'd' ? 8 : 4;
        assert.equal(data.length, count * size, `array size in ${name}`);
        const copy = Buffer.from(data);
        props.push(t === 'd' ? new Float64Array(copy.buffer, copy.byteOffset, count) : new Int32Array(copy.buffer, copy.byteOffset, count));
        p += 12 + len;
      } else throw new Error(`unknown property type '${t}' in ${name}`);
    }
    assert.equal(p, pos + 13 + nameLen + propLen, `property length of ${name}`);
    const children = [];
    while (p < end) {
      const c = readNode(p);
      if (!c) { p += 13; break; }
      children.push(c); p = c.end;
    }
    assert.equal(p, end, `end offset of ${name}`);
    return { name, props, children, end };
  };
  const nodes = [];
  let pos = 27;
  for (;;) { const n = readNode(pos); if (!n) break; nodes.push(n); pos = n.end; }
  return nodes;
}
const child = (n, name) => n.children.find((c) => c.name === name);
const children = (n, name) => n.children.filter((c) => c.name === name);

function readZipNames(buf) {
  const names = [];
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const size = buf.readUInt32LE(pos + 18), nameLen = buf.readUInt16LE(pos + 26), extraLen = buf.readUInt16LE(pos + 28);
    const dataStart = pos + 30 + nameLen + extraLen;
    assert.equal(dataStart % 64, 0, 'usdz entries must be 64-byte aligned');
    assert.equal(buf.readUInt16LE(pos + 8), 0, 'usdz entries must be stored uncompressed');
    names.push(buf.toString('utf8', pos + 30, pos + 30 + nameLen));
    pos = dataStart + size;
  }
  return names;
}

// ---------------------------------------------------------------- unit tests
test('name helpers', () => {
  assert.equal(translateName('左足ＩＫ'), 'LeftLegIK');
  assert.equal(translateName('上半身2'), 'UpperBody2');
  assert.equal(translateName('右手首'), 'RightWrist');
  assert.equal(translateName('謎の骨'), null);
  assert.deepEqual(uniquify(['a', 'A', 'a', '']), ['a', 'A_2', 'a_3', 'item_3']);
  assert.equal(usdIdentifier('1 body-L'), '_1_body_L');
  assert.equal(usdIdentifier('頭', true), 'u982d');
  assert.equal(usdIdentifier('頭'), '頭');
});

for (const variant of ['basic', 'complex']) {
  const s = makeSample(sampleDir, variant);

  test(`[${variant}] parse`, () => {
    const pmx = parsePmx(fs.readFileSync(s.file));
    assert.equal(pmx.name, 'テストモデル');
    assert.equal(pmx.nameEn, 'TestModel');
    assert.equal(pmx.version, variant === 'complex' ? 2.1 : 2);
    assert.equal(pmx.vertexCount, s.vertexCount);
    assert.equal(pmx.indices.length, s.triangleCount * 3);
    assert.equal(pmx.materials.length, s.materialCount);
    assert.equal(pmx.bones.length, s.boneCount);
    assert.equal(pmx.morphs.length, s.morphCount);
    assert.equal(pmx.rigidBodyCount, 1);
    assert.equal(pmx.jointCount, 1);
    assert.deepEqual(pmx.warnings, []);
    assert.equal(pmx.textures[0], 'tex\\body.png');
    if (variant === 'complex') {
      assert.equal(pmx.bones[5].ik.links.length, 2);
      assert.ok(pmx.deformCounts.SDEF > 0 && pmx.deformCounts.QDEF > 0 && pmx.deformCounts.BDEF4 > 0);
    }
  });

  test(`[${variant}] scene normalisation`, () => {
    const scene = buildScene(parsePmx(fs.readFileSync(s.file)));
    assert.equal(scene.materials.length, s.usedMaterialCount);
    assert.equal(scene.triangleCount, s.triangleCount);
    assert.equal(scene.morphs.length, s.vertexMorphCount);
    // parents come before children
    scene.bones.forEach((b, i) => assert.ok(b.parent < i, `bone ${b.name} placed before its parent`));
    assert.equal(new Set(scene.bones.map((b) => b.name)).size, scene.bones.length, 'bone names unique');
    // weights normalised, indices valid
    for (let v = 0; v < scene.vertexCount; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += scene.skinWeights[v * 4 + k];
        assert.ok(scene.skinIndices[v * 4 + k] >= 0 && scene.skinIndices[v * 4 + k] < scene.bones.length);
      }
      assert.ok(Math.abs(sum - 1) < 1e-5, `weights of vertex ${v} sum to ${sum}`);
    }
    // scale: 16 units * 8 = 128 cm tall
    let maxY = -Infinity;
    for (let i = 1; i < scene.positions.length; i += 3) maxY = Math.max(maxY, scene.positions[i]);
    assert.ok(Math.abs(maxY - 128) < 1e-3);
    // winding: body faces must be counter-clockwise seen from outside (right-handed)
    const body = scene.materials[0];
    const P = scene.positions;
    for (let i = body.indexStart; i < body.indexStart + body.indexCount; i += 3) {
      const [a, b, c] = [scene.indices[i] * 3, scene.indices[i + 1] * 3, scene.indices[i + 2] * 3];
      const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const cx = (P[a] + P[b] + P[c]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      assert.ok(n[0] * cx + n[2] * cz > 0, 'face points outwards');
    }
    // the group morph is the sum of its children: あ*1 + ふくらみ*0.5
    const [a, f, g] = scene.morphs;
    assert.equal(g.indices.length, a.indices.length + f.indices.length);
    // english names
    const en = buildScene(parsePmx(fs.readFileSync(s.file)), { nameMode: 'english' });
    assert.deepEqual(en.bones.slice(0, 5).map((b) => b.name), ['Root', 'LowerBody', 'UpperBody', 'Neck', 'Head']);
    assert.equal(en.materials[0].name, 'Body');
  });

  test(`[${variant}] FBX`, async () => {
    const out = path.join(outDir, `${variant}.fbx`);
    const r = await convertPmxFile(s.file, out);
    assert.equal(r.stats.textures, 2);
    assert.equal(r.stats.missingTextures, 0);
    const nodes = readFbx(fs.readFileSync(out));
    const objects = nodes.find((n) => n.name === 'Objects');
    const geoms = children(objects, 'Geometry');
    const mesh = geoms.find((g) => g.props[2] === 'Mesh');
    assert.equal(child(mesh, 'Vertices').props[0].length, s.vertexCount * 3);
    const pvi = child(mesh, 'PolygonVertexIndex').props[0];
    assert.equal(pvi.length, s.triangleCount * 3);
    assert.ok(pvi[2] < 0 && pvi[0] >= 0 && pvi[1] >= 0, 'every third index closes a polygon');
    assert.equal(child(child(mesh, 'LayerElementMaterial'), 'Materials').props[0].length, s.triangleCount);
    assert.equal(geoms.filter((g) => g.props[2] === 'Shape').length, s.vertexMorphCount);
    assert.equal(children(objects, 'Material').length, s.usedMaterialCount);
    assert.equal(children(objects, 'Texture').length, 2);
    const models = children(objects, 'Model');
    assert.equal(models.filter((m) => m.props[2] === 'LimbNode').length, s.boneCount);
    const deformers = children(objects, 'Deformer');
    const clusters = deformers.filter((d) => d.props[2] === 'Cluster');
    assert.equal(clusters.length, s.boneCount);
    // every vertex's cluster weights add up to 1
    const sums = new Float64Array(s.vertexCount);
    for (const c of clusters) {
      const ix = child(c, 'Indexes'); if (!ix) continue;
      const wt = child(c, 'Weights').props[0];
      ix.props[0].forEach((v, k) => { sums[v] += wt[k]; });
    }
    sums.forEach((v, i) => assert.ok(Math.abs(v - 1) < 1e-5, `vertex ${i} total weight ${v}`));
    // every connection refers to existing objects
    const ids = new Set([0n, ...objects.children.map((o) => o.props[0])]);
    for (const c of nodes.find((n) => n.name === 'Connections').children) {
      assert.ok(ids.has(c.props[1]) && ids.has(c.props[2]), 'connection endpoints exist');
    }
    // alpha detection: opaque 32-bit PNG stays opaque, gradient texture is transparent
    const byName = Object.fromEntries(r.textures.map((t) => [path.basename(t.output).toLowerCase(), t.hasAlpha]));
    assert.equal(byName['body.png'], false);
    assert.equal(byName[variant === 'complex' ? 'flag.tga' : '透過.png'], true);
    assert.ok(fs.existsSync(path.join(outDir, `${variant}_textures`, 'body.png')));
  });

  test(`[${variant}] USDA`, async () => {
    const out = path.join(outDir, `${variant}.usda`);
    const r = await convertPmxFile(s.file, out);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.startsWith('#usda 1.0'));
    assert.equal(r.stats.bones, s.boneCount);
    assert.equal((text.match(/def GeomSubset /g) || []).length, s.usedMaterialCount);
    assert.equal((text.match(/def BlendShape /g) || []).length, s.vertexMorphCount);
    assert.equal((text.match(/def Material /g) || []).length, s.usedMaterialCount);
    assert.match(text, /uniform token\[\] joints = \["全ての親", "全ての親\/下半身", "全ての親\/下半身\/上半身"/);
    assert.match(text, /asset inputs:file = @\.\/\w+_textures\/body\.png@/);
    const faceCounts = /int\[\] faceVertexCounts = \[([^\]]*)\]/.exec(text)[1].split(',').length;
    assert.equal(faceCounts, s.triangleCount);
    const points = /point3f\[\] points = \[(.*?)\]\n/.exec(text)[1].split('), (').length;
    assert.equal(points, s.vertexCount);
    let depth = 0;
    for (const ch of text) { if (ch === '{') depth++; else if (ch === '}') depth--; assert.ok(depth >= 0); }
    assert.equal(depth, 0, 'balanced braces');
  });

  test(`[${variant}] USDZ + ASCII names`, async () => {
    const out = path.join(outDir, `${variant}_ascii.usdz`);
    await convertPmxFile(s.file, out, { asciiNames: true, nameMode: 'english' });
    const names = readZipNames(fs.readFileSync(out));
    assert.equal(names[0], `${variant}_ascii.usda`);
    assert.equal(names.length, 3);
    const buf = fs.readFileSync(out);
    const usda = buf.toString('utf8');
    assert.match(usda, /joints = \["Root", "Root\/LowerBody", "Root\/LowerBody\/UpperBody"/);
    const prims = [...usda.matchAll(/def \w+ "([^"]+)"/g)].map((m) => m[1]);
    for (const p of prims) assert.match(p, /^[A-Za-z_][A-Za-z0-9_]*$/, `ASCII prim name: ${p}`);
  });
}

test('options: no morphs, scale, missing texture, bad input', async () => {
  const s = makeSample(path.join(outDir, 'broken'), 'basic');
  fs.rmSync(path.join(outDir, 'broken', 'tex', 'body.png'));
  const r = await convertPmxFile(s.file, path.join(outDir, 'broken', 'o.fbx'), { morphs: false, scale: 1 });
  assert.equal(r.stats.morphs, 0);
  assert.equal(r.stats.missingTextures, 1);
  assert.ok(r.warnings.some((w) => w.includes('body.png')));
  const garbage = path.join(outDir, 'broken', 'garbage.pmx');
  fs.writeFileSync(garbage, 'not a pmx file at all');
  await assert.rejects(convertPmxFile(garbage, path.join(outDir, 'broken', 'g.fbx')), /PMX 파일이 아닙니다/);
  const truncated = path.join(outDir, 'broken', 'truncated.pmx');
  fs.writeFileSync(truncated, fs.readFileSync(s.file).subarray(0, 900));
  await assert.rejects(convertPmxFile(truncated, path.join(outDir, 'broken', 't.fbx')), /예상보다 짧습니다/);
  await assert.rejects(convertPmxFile(s.file, path.join(outDir, 'broken', 'x.obj')), /지원하지 않는 출력 형식/);
  assert.equal(textureUsesAlpha(Buffer.from('nope'), '.png'), false);
});

// ---------------------------------------------------------------- run
registerShadowTests(test);
for (const run of pending) await run();

if (process.argv.includes('--blender')) {
  const candidates = [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe', 'blender'].filter(Boolean);
  const blender = candidates.find((c) => c === 'blender' || fs.existsSync(c));
  const files = ['basic.fbx', 'basic.usda', 'basic_ascii.usdz', 'complex.fbx', 'complex.usda', 'complex_ascii.usdz'].map((f) => path.join(outDir, f));
  console.log(`\nBlender import check (${blender})`);
  try {
    const out = execFileSync(blender, ['-b', '--factory-startup', '--python', path.join(here, 'blender_check.py'), '--', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/).filter((l) => l.startsWith('CHECK:'))) {
      const info = JSON.parse(line.slice(6));
      const complex = info.file.startsWith('complex');
      try {
        assert.ok(!info.error, info.error);
        assert.equal(info.mesh.verts, 121);
        assert.equal(info.mesh.polys, 194);
        assert.equal(info.mesh.materials.length, 2);
        assert.equal(info.mesh.shape_keys.length, 4);
        assert.equal(info.armature.bones.length, complex ? 7 : 5);
        assert.equal(info.mesh.weighted_verts, 121);
        assert.equal(info.mesh.outward, 1);
        assert.ok(Math.abs(info.mesh.bounds_max[2] - 1.28) < 1e-3, 'height is 1.28 m');
        assert.equal(info.textures.length >= 2, true);
        passed++; console.log(`  ok   blender import ${info.file}`);
      } catch (e) { failed++; console.log(`  FAIL blender import ${info.file}\n       ${e.message}`); }
    }
  } catch (e) {
    failed++; console.log(`  FAIL could not run Blender: ${e.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
