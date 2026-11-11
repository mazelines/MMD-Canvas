// PMX 2.0 / 2.1 binary parser. Pure JS, runs in Node and in the browser.
// Returns the model in its native space (left-handed, Y-up, 1 unit ~= 8cm).

class Reader {
  constructor(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = 0;
    this.decoder = null;
  }
  need(n) {
    if (this.pos + n > this.u8.byteLength) {
      throw new Error(`PMX: 파일이 예상보다 짧습니다 (offset ${this.pos}, need ${n})`);
    }
  }
  u8_() { this.need(1); return this.dv.getUint8(this.pos++); }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  vec(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  skip(n) { this.need(n); this.pos += n; }
  text() {
    const len = this.i32();
    if (len < 0) throw new Error('PMX: 잘못된 문자열 길이');
    this.need(len);
    const s = this.decoder.decode(this.u8.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  /** signed index (bone / texture / material / morph / rigid body) */
  index(size) {
    if (size === 1) return this.i8();
    if (size === 2) return this.i16();
    return this.i32();
  }
  /** vertex index: 1 and 2 byte variants are unsigned */
  vindex(size) {
    if (size === 1) return this.u8_();
    if (size === 2) return this.u16();
    return this.i32();
  }
}

export const MORPH_TYPE = {
  GROUP: 0, VERTEX: 1, BONE: 2, UV: 3, UV1: 4, UV2: 5, UV3: 6, UV4: 7, MATERIAL: 8, FLIP: 9, IMPULSE: 10,
};

export function isPmx(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4d && u8[2] === 0x58 && u8[3] === 0x20;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns parsed PMX model
 */
export function parsePmx(buffer) {
  const r = new Reader(buffer);
  if (!isPmx(r.u8)) {
    const head = String.fromCharCode(...r.u8.subarray(0, 3));
    if (head === 'Pmd') throw new Error('PMD(구버전) 포맷은 지원하지 않습니다. PMX Editor에서 PMX로 저장한 뒤 사용하세요.');
    throw new Error('PMX 파일이 아닙니다 (매직 넘버 불일치)');
  }
  r.skip(4);
  const version = r.f32();
  const globalsCount = r.u8_();
  const globals = [];
  for (let i = 0; i < globalsCount; i++) globals.push(r.u8_());
  const [encoding, additionalUv, vSize, tSize, mSize, bSize, mpSize, rbSize] = globals;
  r.decoder = new TextDecoder(encoding === 1 ? 'utf-8' : 'utf-16le');

  const model = {
    version: Math.round(version * 10) / 10,
    encoding: encoding === 1 ? 'UTF-8' : 'UTF-16LE',
    additionalUvCount: additionalUv,
    name: r.text(),
    nameEn: r.text(),
    comment: r.text(),
    commentEn: r.text(),
    warnings: [],
  };

  // ---- vertices ----
  const vCount = r.i32();
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const skinIndices = new Int32Array(vCount * 4).fill(-1);
  const skinWeights = new Float32Array(vCount * 4);
  const edgeScale = new Float32Array(vCount);
  const deformCounts = { BDEF1: 0, BDEF2: 0, BDEF4: 0, SDEF: 0, QDEF: 0 };
  for (let i = 0; i < vCount; i++) {
    const p = i * 3, s = i * 4;
    positions[p] = r.f32(); positions[p + 1] = r.f32(); positions[p + 2] = r.f32();
    normals[p] = r.f32(); normals[p + 1] = r.f32(); normals[p + 2] = r.f32();
    uvs[i * 2] = r.f32(); uvs[i * 2 + 1] = r.f32();
    if (additionalUv) r.skip(16 * additionalUv);
    const type = r.u8_();
    switch (type) {
      case 0:
        skinIndices[s] = r.index(bSize); skinWeights[s] = 1; deformCounts.BDEF1++;
        break;
      case 1: case 3: {
        skinIndices[s] = r.index(bSize); skinIndices[s + 1] = r.index(bSize);
        const w = r.f32();
        skinWeights[s] = w; skinWeights[s + 1] = 1 - w;
        if (type === 3) { r.skip(36); deformCounts.SDEF++; } else deformCounts.BDEF2++;
        break;
      }
      case 2: case 4:
        for (let k = 0; k < 4; k++) skinIndices[s + k] = r.index(bSize);
        for (let k = 0; k < 4; k++) skinWeights[s + k] = r.f32();
        if (type === 4) deformCounts.QDEF++; else deformCounts.BDEF4++;
        break;
      default:
        throw new Error(`PMX: 알 수 없는 스키닝 타입 ${type} (vertex ${i})`);
    }
    edgeScale[i] = r.f32();
  }
  model.vertexCount = vCount;
  model.positions = positions;
  model.normals = normals;
  model.uvs = uvs;
  model.skinIndices = skinIndices;
  model.skinWeights = skinWeights;
  model.deformCounts = deformCounts;

  // ---- faces ----
  const iCount = r.i32();
  const indices = new Uint32Array(iCount);
  for (let i = 0; i < iCount; i++) indices[i] = r.vindex(vSize);
  model.indices = indices;

  // ---- textures ----
  const tCount = r.i32();
  model.textures = [];
  for (let i = 0; i < tCount; i++) model.textures.push(r.text());

  // ---- materials ----
  const mCount = r.i32();
  model.materials = [];
  let indexStart = 0;
  for (let i = 0; i < mCount; i++) {
    const m = {
      name: r.text(), nameEn: r.text(),
      diffuse: r.vec(4), specular: r.vec(3), shininess: r.f32(), ambient: r.vec(3),
      flags: r.u8_(),
      edgeColor: r.vec(4), edgeSize: r.f32(),
      textureIndex: r.index(tSize), sphereIndex: r.index(tSize), sphereMode: r.u8_(),
    };
    m.sharedToon = r.u8_() === 1;
    m.toonIndex = m.sharedToon ? r.u8_() : r.index(tSize);
    m.memo = r.text();
    m.indexCount = r.i32();
    m.indexStart = indexStart;
    indexStart += m.indexCount;
    m.doubleSided = (m.flags & 0x01) !== 0;
    m.hasEdge = (m.flags & 0x10) !== 0;
    model.materials.push(m);
  }
  if (indexStart !== iCount) {
    model.warnings.push(`재질의 면 인덱스 합계(${indexStart})가 전체 인덱스 수(${iCount})와 다릅니다.`);
  }

  // ---- bones ----
  const bCount = r.i32();
  model.bones = [];
  for (let i = 0; i < bCount; i++) {
    const b = { name: r.text(), nameEn: r.text(), position: r.vec(3), parent: r.index(bSize), layer: r.i32(), flags: r.u16() };
    const f = b.flags;
    if (f & 0x0001) b.tailIndex = r.index(bSize); else b.tailOffset = r.vec(3);
    if (f & 0x0300) { b.inheritParent = r.index(bSize); b.inheritWeight = r.f32(); }
    if (f & 0x0400) b.fixedAxis = r.vec(3);
    if (f & 0x0800) { b.localX = r.vec(3); b.localZ = r.vec(3); }
    if (f & 0x2000) b.externalKey = r.i32();
    if (f & 0x0020) {
      const ik = { target: r.index(bSize), loop: r.i32(), limit: r.f32(), links: [] };
      const n = r.i32();
      for (let k = 0; k < n; k++) {
        const link = { bone: r.index(bSize), hasLimit: r.u8_() === 1 };
        if (link.hasLimit) { link.min = r.vec(3); link.max = r.vec(3); }
        ik.links.push(link);
      }
      b.ik = ik;
    }
    b.visible = (f & 0x0008) !== 0;
    b.isIk = (f & 0x0020) !== 0;
    model.bones.push(b);
  }

  // ---- morphs ----
  const mpCount = r.i32();
  model.morphs = [];
  for (let i = 0; i < mpCount; i++) {
    const mp = { name: r.text(), nameEn: r.text(), panel: r.u8_(), type: r.u8_() };
    const n = r.i32();
    switch (mp.type) {
      case MORPH_TYPE.GROUP: case MORPH_TYPE.FLIP:
        mp.items = [];
        for (let k = 0; k < n; k++) mp.items.push({ morph: r.index(mpSize), weight: r.f32() });
        break;
      case MORPH_TYPE.VERTEX: {
        const vi = new Uint32Array(n), off = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          vi[k] = r.vindex(vSize);
          off[k * 3] = r.f32(); off[k * 3 + 1] = r.f32(); off[k * 3 + 2] = r.f32();
        }
        mp.vertexIndices = vi; mp.offsets = off;
        break;
      }
      case MORPH_TYPE.BONE: r.skip(n * (bSize + 28)); break;
      case MORPH_TYPE.UV: case MORPH_TYPE.UV1: case MORPH_TYPE.UV2: case MORPH_TYPE.UV3: case MORPH_TYPE.UV4:
        r.skip(n * (vSize + 16)); break;
      case MORPH_TYPE.MATERIAL: r.skip(n * (mSize + 1 + 112)); break;
      case MORPH_TYPE.IMPULSE: r.skip(n * (rbSize + 1 + 24)); break;
      default: throw new Error(`PMX: 알 수 없는 모프 타입 ${mp.type}`);
    }
    mp.count = n;
    model.morphs.push(mp);
  }

  // Everything below is informational only; a damaged tail must not block conversion.
  model.displayFrameCount = 0; model.rigidBodyCount = 0; model.jointCount = 0;
  try {
    const dCount = r.i32();
    for (let i = 0; i < dCount; i++) {
      r.text(); r.text(); r.skip(1);
      const n = r.i32();
      for (let k = 0; k < n; k++) r.skip(r.u8_() === 1 ? mpSize : bSize);
    }
    model.displayFrameCount = dCount;
    const rCount = r.i32();
    for (let i = 0; i < rCount; i++) { r.text(); r.text(); r.skip(bSize + 1 + 2 + 1 + 36 + 20 + 1); }
    model.rigidBodyCount = rCount;
    const jCount = r.i32();
    for (let i = 0; i < jCount; i++) { r.text(); r.text(); r.skip(1 + rbSize * 2 + 96); }
    model.jointCount = jCount;
  } catch (e) {
    model.warnings.push('표시 프레임/물리 섹션을 끝까지 읽지 못했습니다 (변환에는 영향 없음).');
  }
  return model;
}
