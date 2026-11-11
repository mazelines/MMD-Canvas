// Generates small synthetic PMX files (plus PNG/TGA textures) for tests. Has its own encoder,
// independent of the parser. Two variants cover the format's switches:
//   'basic'   : PMX 2.0, UTF-16LE, 2-byte vertex index, 1-byte bone index, BDEF1/BDEF2
//   'complex' : PMX 2.1, UTF-8, 4-byte vertex index, 2-byte bone/morph index, 2 additional UVs,
//               BDEF4/SDEF/QDEF, IK / inherit / fixed-axis / local-axis bones, every morph type
// Shape: a segmented column skinned to a bone chain, with a double-sided "flag" quad.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

class W {
  constructor(encoding) { this.parts = []; this.encoding = encoding; }
  raw(b) { this.parts.push(b); return this; }
  u8(v) { return this.raw(Buffer.from([v & 0xff])); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return this.raw(b); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); return this.raw(b); }
  f32(...vs) { const b = Buffer.alloc(4 * vs.length); vs.forEach((v, i) => b.writeFloatLE(v, i * 4)); return this.raw(b); }
  text(s) { const b = Buffer.from(s, this.encoding); this.i32(b.length); return this.raw(b); }
  /** signed index of the given byte size */
  idx(size, v) {
    const b = Buffer.alloc(size);
    if (size === 1) b.writeInt8(v); else if (size === 2) b.writeInt16LE(v); else b.writeInt32LE(v);
    return this.raw(b);
  }
  /** vertex index: unsigned for 1/2 bytes */
  vidx(size, v) {
    const b = Buffer.alloc(size);
    if (size === 1) b.writeUInt8(v); else if (size === 2) b.writeUInt16LE(v); else b.writeInt32LE(v);
    return this.raw(b);
  }
  done() { return Buffer.concat(this.parts); }
}

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function tga32(width, height, pixel) {
  const head = Buffer.alloc(18);
  head[2] = 2; head.writeUInt16LE(width, 12); head.writeUInt16LE(height, 14); head[16] = 32; head[17] = 0x28; // top-left, 8 alpha bits
  const body = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) { const [r, g, b, a] = pixel(x, y); body.set([b, g, r, a], (y * width + x) * 4); }
  }
  return Buffer.concat([head, body]);
}

export function makeSample(dir, variant = 'basic') {
  const complex = variant === 'complex';
  const cfg = complex
    ? { version: 2.1, encoding: 'utf8', addUv: 2, vSize: 4, tSize: 1, mSize: 1, bSize: 2, mpSize: 2, rbSize: 1 }
    : { version: 2.0, encoding: 'utf16le', addUv: 0, vSize: 2, tSize: 1, mSize: 1, bSize: 1, mpSize: 1, rbSize: 1 };
  fs.mkdirSync(path.join(dir, 'tex'), { recursive: true });
  // opaque checker (32-bit but fully opaque) + translucent gradient
  fs.writeFileSync(path.join(dir, 'tex', 'body.png'), png(64, 64, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [230, 120, 150, 255] : [250, 230, 235, 255])));
  const flagPixel = (x, y) => [80, 160, 255, Math.round((y / 31) * 255)];
  const flagTex = complex ? 'TEX\\Flag.tga' : 'tex\\透過.png'; // complex: wrong case on purpose
  if (complex) fs.writeFileSync(path.join(dir, 'tex', 'flag.tga'), tga32(32, 32, flagPixel));
  else fs.writeFileSync(path.join(dir, 'tex', '透過.png'), png(32, 32, flagPixel));

  // bones as stored in the file. '上半身' is stored BEFORE its parent to exercise topological sorting.
  const H = 16;
  const bones = [
    { name: '全ての親', en: 'Root', pos: [0, 0, 0], parent: -1 },
    { name: '上半身', en: '', pos: [0, H / 3, 0], parent: 2 },
    { name: '下半身', en: 'LowerBody', pos: [0, 0.5, 0], parent: 0 },
    { name: '首', en: '', pos: [0, (2 * H) / 3, 0], parent: 1 },
    { name: '頭', en: '', pos: [0, H, 0], parent: 3 },
  ];
  const chain = [2, 1, 3, 4]; // skin chain position -> file bone index
  if (complex) {
    bones[3].flags = 0x001a | 0x0100 | 0x0400 | 0x0800; // inherit rotation + fixed axis + local axes
    bones[4].flags = 0x001b;                            // indexed tail
    bones.push({ name: '左足ＩＫ', en: '', pos: [1, 0, 0], parent: 0, flags: 0x003a, ik: true });
    bones.push({ name: '頭', en: '', pos: [0, H + 1, 0], parent: 4, flags: 0x201a }); // duplicate name + external parent
  }

  const RINGS = 9, SEG = 12, R = 1.2;
  const verts = [];
  for (let r = 0; r < RINGS; r++) {
    const y = (H * r) / (RINGS - 1);
    for (let s = 0; s <= SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const t = (r / (RINGS - 1)) * 3;
      const k0 = Math.min(3, Math.floor(t)), k1 = Math.min(3, k0 + 1);
      const type = complex ? [1, 2, 3, 4][r % 4] : 1;
      verts.push({ p: [Math.cos(a) * R, y, Math.sin(a) * R], n: [Math.cos(a), 0, Math.sin(a)], uv: [s / SEG, 1 - r / (RINGS - 1)], b0: chain[k0], b1: chain[k1], w: 1 - (t - k0), type });
    }
  }
  const idx = [];
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SEG; s++) {
      const a = r * (SEG + 1) + s, b = a + 1, c = a + SEG + 1, d = c + 1;
      idx.push(a, c, b, b, c, d); // clockwise seen from outside in MMD's left-handed space
    }
  }
  const bodyIndexCount = idx.length;
  const base = verts.length;
  const quad = [[R, H - 4, 0], [R + 5, H - 4, 0], [R, H, 0], [R + 5, H, 0]];
  const quv = [[0, 1], [1, 1], [0, 0], [1, 0]];
  quad.forEach((p, i) => verts.push({ p, n: [0, 0, -1], uv: quv[i], b0: 4, type: 0 }));
  idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);

  const w = new W(cfg.encoding);
  w.raw(Buffer.from('PMX ', 'latin1')).f32(cfg.version).u8(8);
  w.u8(cfg.encoding === 'utf8' ? 1 : 0).u8(cfg.addUv).u8(cfg.vSize).u8(cfg.tSize).u8(cfg.mSize).u8(cfg.bSize).u8(cfg.mpSize).u8(cfg.rbSize);
  w.text('テストモデル').text('TestModel').text('変換テスト用のサンプル').text('Synthetic sample for conversion tests');

  w.i32(verts.length);
  for (const v of verts) {
    w.f32(...v.p, ...v.n, ...v.uv);
    for (let k = 0; k < cfg.addUv; k++) w.f32(0.25, 0.5, 0.75, 1);
    w.u8(v.type);
    if (v.type === 0) w.idx(cfg.bSize, v.b0);
    else if (v.type === 1) w.idx(cfg.bSize, v.b0).idx(cfg.bSize, v.b1).f32(v.w);
    else if (v.type === 3) w.idx(cfg.bSize, v.b0).idx(cfg.bSize, v.b1).f32(v.w).f32(0, 0, 0, 1, 0, 0, 0, 1, 0);
    else w.idx(cfg.bSize, v.b0).idx(cfg.bSize, v.b1).idx(cfg.bSize, -1).idx(cfg.bSize, 0).f32(v.w, 1 - v.w, 0, 0); // BDEF4 / QDEF
    w.f32(1);
  }
  w.i32(idx.length);
  for (const i of idx) w.vidx(cfg.vSize, i);

  w.i32(2).text('tex\\body.png').text(flagTex);

  const material = (name, en, diffuse, flags, tex, count) => {
    w.text(name).text(en).f32(...diffuse).f32(0.2, 0.2, 0.2).f32(5).f32(0.4, 0.4, 0.4).u8(flags);
    w.f32(0, 0, 0, 1).f32(1).idx(cfg.tSize, tex).idx(cfg.tSize, -1).u8(0).u8(1).u8(0).text('').i32(count);
  };
  const materialCount = complex ? 3 : 2;
  w.i32(materialCount);
  material('体', 'Body', [0.8, 0.8, 0.8, 1], 0x1e, 0, bodyIndexCount);
  if (complex) material('空', 'Empty', [1, 0, 0, 1], 0, -1, 0); // material without faces
  material('旗', 'Flag', [1, 1, 1, 0.9], 0x01, 1, 6);

  w.i32(bones.length);
  bones.forEach((b) => {
    const flags = b.flags ?? 0x001a; // offset tail, rotatable | visible | enabled
    w.text(b.name).text(b.en).f32(...b.pos).idx(cfg.bSize, b.parent).i32(0).u16(flags);
    if (flags & 0x0001) w.idx(cfg.bSize, -1); else w.f32(0, 1, 0);
    if (flags & 0x0300) w.idx(cfg.bSize, 1).f32(0.5);
    if (flags & 0x0400) w.f32(0, 1, 0);
    if (flags & 0x0800) w.f32(1, 0, 0).f32(0, 0, 1);
    if (flags & 0x2000) w.i32(7);
    if (flags & 0x0020) {
      w.idx(cfg.bSize, 4).i32(40).f32(2).i32(2);
      w.idx(cfg.bSize, 3).u8(1).f32(-3, 0, 0).f32(0, 0, 0);
      w.idx(cfg.bSize, 1).u8(0);
    }
  });

  // morphs
  const topRing = (RINGS - 1) * (SEG + 1), mid = 4 * (SEG + 1);
  w.i32(complex ? 8 : 4);
  w.text('あ').text('a').u8(3).u8(1).i32(SEG + 1);
  for (let s = 0; s <= SEG; s++) w.vidx(cfg.vSize, topRing + s).f32(0, 2, 0);
  w.text('ふくらみ').text('').u8(4).u8(1).i32(SEG + 1);
  for (let s = 0; s <= SEG; s++) { const v = verts[mid + s]; w.vidx(cfg.vSize, mid + s).f32(v.n[0], 0, v.n[2]); }
  w.text('まとめ').text('').u8(4).u8(0).i32(2).idx(cfg.mpSize, 0).f32(1).idx(cfg.mpSize, 1).f32(0.5);
  w.text('色').text('').u8(4).u8(8).i32(1).idx(cfg.mSize, 0).u8(0).f32(...new Array(28).fill(1));
  if (complex) {
    w.text('ボーン').text('').u8(4).u8(2).i32(1).idx(cfg.bSize, 4).f32(0, 1, 0).f32(0, 0, 0, 1);
    w.text('UV').text('').u8(4).u8(3).i32(2).vidx(cfg.vSize, 0).f32(0.1, 0, 0, 0).vidx(cfg.vSize, 1).f32(0.1, 0, 0, 0);
    w.text('フリップ').text('').u8(4).u8(9).i32(1).idx(cfg.mpSize, 0).f32(1);
    w.text('インパルス').text('').u8(4).u8(10).i32(1).idx(cfg.rbSize, 0).u8(1).f32(0, 1, 0).f32(0, 0, 0);
  }

  // display frames, rigid body, joint
  w.i32(1).text('Root').text('Root').u8(1).i32(2).u8(0).idx(cfg.bSize, 0).u8(1).idx(cfg.mpSize, 0);
  w.i32(1).text('剛体').text('rb').idx(cfg.bSize, 4).u8(0).u16(0xffff).u8(0).f32(1, 1, 1).f32(0, H, 0).f32(0, 0, 0).f32(1, 0.5, 0.5, 0, 0.5).u8(0);
  w.i32(1).text('ジョイント').text('j').u8(0).idx(cfg.rbSize, 0).idx(cfg.rbSize, 0).f32(...new Array(24).fill(0));
  if (complex) w.i32(0); // PMX 2.1 soft body count

  const file = path.join(dir, complex ? 'complex.pmx' : 'sample.pmx');
  fs.writeFileSync(file, w.done());
  return {
    file, variant, height: H, radius: R,
    vertexCount: verts.length,
    triangleCount: idx.length / 3,
    materialCount, usedMaterialCount: 2,
    boneCount: bones.length,
    morphCount: complex ? 8 : 4,
    vertexMorphCount: 3, // あ, ふくらみ and the group morph flattened from them
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || path.join(process.cwd(), 'tests', 'sample');
  console.log(makeSample(dir, 'basic'));
  console.log(makeSample(dir, 'complex'));
}
