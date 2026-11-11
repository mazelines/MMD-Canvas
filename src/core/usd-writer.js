// USD (text .usda) writer with UsdSkel skeleton/skinning, blend shapes, GeomSubsets and
// UsdPreviewSurface materials. Also a minimal USDZ packer (uncompressed, 64-byte aligned zip).

import zlib from 'node:zlib';
import { uniquify, usdIdentifier } from './names.js';

const f = (v) => {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

function tuples(arr, size, scale = 1) {
  const n = arr.length / size;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = '(';
    for (let k = 0; k < size; k++) s += (k ? ', ' : '') + f(arr[i * size + k] * scale);
    out[i] = s + ')';
  }
  return out.join(', ');
}
const list = (arr) => Array.prototype.join.call(arr, ', ');
const floats = (arr) => Array.prototype.map.call(arr, f).join(', ');
const matrix = (t) => `( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (${f(t[0])}, ${f(t[1])}, ${f(t[2])}, 1) )`;
const str = (s) => JSON.stringify(String(s));
const asset = (p) => (p.includes('@') ? `@@@${p}@@@` : `@${p}@`);

function uniqueIds(names, prefix, asciiOnly) {
  return uniquify(names.map((n) => usdIdentifier(n || '', asciiOnly)).map((n) => (n === '_' ? '' : n)), prefix);
}

/**
 * @param scene normalised scene from buildScene()
 * @param {Map} textureMap Map<pmx texture path, {relative, hasAlpha}>
 * @param {{asciiNames?:boolean, metersPerUnit?:number}} options
 * @returns {string} usda text
 */
export function writeUsda(scene, textureMap = new Map(), options = {}) {
  const ascii = !!options.asciiNames;
  const metersPerUnit = options.metersPerUnit ?? 0.01;
  const root = uniqueIds([scene.name], 'Model', ascii)[0];
  const rootPath = `/${root}`;
  const hasBones = scene.bones.length > 0;
  const triCount = scene.indices.length / 3;
  const L = [];

  L.push('#usda 1.0', '(');
  L.push(`    defaultPrim = ${str(root)}`);
  L.push(`    doc = "Converted from PMX by MMD Converter"`);
  L.push(`    metersPerUnit = ${metersPerUnit}`);
  L.push('    upAxis = "Y"', ')', '');

  L.push(`def ${hasBones ? 'SkelRoot' : 'Xform'} ${str(root)} (`);
  L.push('    kind = "component"');
  L.push(`    displayName = ${str(scene.name)}`);
  L.push(')', '{');

  // ---- skeleton ----
  let jointPaths = [];
  if (hasBones) {
    const ids = uniqueIds(scene.bones.map((b) => b.name), 'joint', ascii);
    jointPaths = [];
    scene.bones.forEach((b, i) => { jointPaths[i] = b.parent >= 0 ? `${jointPaths[b.parent]}/${ids[i]}` : ids[i]; });
    L.push('    def Skeleton "Skeleton" (', '        prepend apiSchemas = ["SkelBindingAPI"]', '    )', '    {');
    L.push(`        uniform token[] joints = [${jointPaths.map(str).join(', ')}]`);
    L.push(`        uniform token[] jointNames = [${scene.bones.map((b) => str(b.name)).join(', ')}]`);
    L.push(`        uniform matrix4d[] bindTransforms = [${scene.bones.map((b) => matrix(b.position)).join(', ')}]`);
    L.push(`        uniform matrix4d[] restTransforms = [${scene.bones.map((b) => matrix(b.local)).join(', ')}]`);
    L.push('    }', '');
  }

  // ---- materials (paths needed by the mesh subsets) ----
  const matIds = uniqueIds(scene.materials.map((m) => m.name), 'material', ascii);
  const anyDoubleSided = scene.materials.some((m) => m.doubleSided);

  // ---- mesh ----
  const apis = ['MaterialBindingAPI'];
  if (hasBones) apis.unshift('SkelBindingAPI');
  L.push('    def Mesh "Mesh" (', `        prepend apiSchemas = [${apis.map(str).join(', ')}]`, '    )', '    {');
  L.push(`        uniform bool doubleSided = ${anyDoubleSided ? 1 : 0}`);
  L.push(`        int[] faceVertexCounts = [${new Array(triCount).fill(3).join(', ')}]`);
  L.push(`        int[] faceVertexIndices = [${list(scene.indices)}]`);
  L.push(`        point3f[] points = [${tuples(scene.positions, 3)}]`);
  L.push(`        normal3f[] normals = [${tuples(scene.normals, 3)}] (`, '            interpolation = "vertex"', '        )');
  L.push(`        texCoord2f[] primvars:st = [${tuples(scene.uvs, 2)}] (`, '            interpolation = "vertex"', '        )');
  L.push('        uniform token subdivisionScheme = "none"');
  const b = sceneExtent(scene);
  L.push(`        float3[] extent = [(${b.min.map(f).join(', ')}), (${b.max.map(f).join(', ')})]`);
  if (hasBones) {
    L.push(`        int[] primvars:skel:jointIndices = [${list(scene.skinIndices)}] (`, '            elementSize = 4', '            interpolation = "vertex"', '        )');
    L.push(`        float[] primvars:skel:jointWeights = [${floats(scene.skinWeights)}] (`, '            elementSize = 4', '            interpolation = "vertex"', '        )');
    L.push('        matrix4d primvars:skel:geomBindTransform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )');
    L.push(`        rel skel:skeleton = <${rootPath}/Skeleton>`);
  }
  const shapeIds = uniqueIds(scene.morphs.map((m) => m.name), 'shape', ascii);
  if (scene.morphs.length && hasBones) {
    L.push(`        uniform token[] skel:blendShapes = [${shapeIds.map(str).join(', ')}]`);
    L.push(`        rel skel:blendShapeTargets = [${shapeIds.map((id) => `<${rootPath}/Mesh/${id}>`).join(', ')}]`);
  }
  if (scene.materials.length === 1) {
    L.push(`        rel material:binding = <${rootPath}/Materials/${matIds[0]}>`);
  } else if (scene.materials.length > 1) {
    L.push('        uniform token subsetFamily:materialBind:familyType = "partition"');
    scene.materials.forEach((m, i) => {
      const start = m.indexStart / 3, count = m.indexCount / 3;
      const faces = new Array(count);
      for (let k = 0; k < count; k++) faces[k] = start + k;
      L.push('', `        def GeomSubset ${str(`Subset_${i}`)} (`, '            prepend apiSchemas = ["MaterialBindingAPI"]', '        )', '        {');
      L.push('            uniform token elementType = "face"', '            uniform token familyName = "materialBind"');
      L.push(`            int[] indices = [${faces.join(', ')}]`);
      L.push(`            rel material:binding = <${rootPath}/Materials/${matIds[i]}>`, '        }');
    });
  }
  if (hasBones) {
    scene.morphs.forEach((m, i) => {
      L.push('', `        def BlendShape ${str(shapeIds[i])} (`, `            displayName = ${str(m.name)}`, '        )', '        {');
      L.push(`            uniform vector3f[] offsets = [${tuples(m.offsets, 3)}]`);
      L.push(`            uniform int[] pointIndices = [${list(m.indices)}]`, '        }');
    });
  }
  L.push('    }', '');

  // ---- materials ----
  L.push('    def Scope "Materials"', '    {');
  scene.materials.forEach((m, i) => {
    const mp = `${rootPath}/Materials/${matIds[i]}`;
    const tex = m.texture && textureMap.get(m.texture);
    L.push(`        def Material ${str(matIds[i])} (`, `            displayName = ${str(m.name)}`, '        )', '        {');
    L.push(`            token outputs:surface.connect = <${mp}/Surface.outputs:surface>`, '');
    L.push('            def Shader "Surface"', '            {', '                uniform token info:id = "UsdPreviewSurface"');
    if (tex) {
      L.push(`                color3f inputs:diffuseColor.connect = <${mp}/DiffuseTexture.outputs:rgb>`);
      if (tex.hasAlpha) {
        L.push(`                float inputs:opacity.connect = <${mp}/DiffuseTexture.outputs:a>`);
      } else {
        L.push(`                float inputs:opacity = ${f(m.alpha)}`);
      }
    } else {
      L.push(`                color3f inputs:diffuseColor = (${m.baseColor.map(f).join(', ')})`);
      L.push(`                float inputs:opacity = ${f(m.alpha)}`);
    }
    L.push('                float inputs:metallic = 0', '                float inputs:roughness = 0.8');
    L.push('                int inputs:useSpecularWorkflow = 0', '                token outputs:surface', '            }');
    if (tex) {
      L.push('', '            def Shader "PrimvarReader"', '            {', '                uniform token info:id = "UsdPrimvarReader_float2"');
      L.push('                string inputs:varname = "st"', '                float2 outputs:result', '            }');
      L.push('', '            def Shader "DiffuseTexture"', '            {', '                uniform token info:id = "UsdUVTexture"');
      L.push(`                asset inputs:file = ${asset(tex.relative)}`);
      L.push('                token inputs:sourceColorSpace = "sRGB"');
      L.push(`                float2 inputs:st.connect = <${mp}/PrimvarReader.outputs:result>`);
      L.push('                token inputs:wrapS = "repeat"', '                token inputs:wrapT = "repeat"');
      L.push(`                float4 inputs:scale = (1, 1, 1, ${f(m.alpha)})`);
      L.push('                float3 outputs:rgb', '                float outputs:a', '            }');
    }
    L.push('        }');
    if (i < scene.materials.length - 1) L.push('');
  });
  L.push('    }', '}', '');
  return L.join('\n');
}

function sceneExtent(scene) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const p = scene.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return p.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/**
 * USDZ = zip archive, no compression, every file's data aligned to 64 bytes.
 * @param {{name:string, data:Buffer}[]} files first entry must be the root layer
 */
export function packUsdz(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(file.data) >>> 0;
    const base = offset + 30 + name.length;
    let extraLen = (64 - (base % 64)) % 64;
    if (extraLen > 0 && extraLen < 4) extraLen += 64;
    const extra = Buffer.alloc(extraLen);
    if (extraLen) { extra.writeUInt16LE(0x1986, 0); extra.writeUInt16LE(extraLen - 4, 2); }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(file.data.length, 18); h.writeUInt32LE(file.data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(extraLen, 28);
    chunks.push(h, name, extra, file.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(file.data.length, 20); c.writeUInt32LE(file.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset = base + extraLen + file.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}
