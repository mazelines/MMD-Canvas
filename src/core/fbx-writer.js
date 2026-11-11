// Binary FBX 7.4 writer (Node). Produces a skinned mesh with materials, textures,
// skeleton, bind pose and blend shapes from a normalised scene (see scene.js).

import zlib from 'node:zlib';

const FBX_VERSION = 7400;
const HEAD_MAGIC = Buffer.from('Kaydara FBX Binary  \x00\x1a\x00', 'latin1');
const FOOT_ID = Buffer.from('fabcab09d0c8d466b176fb831cf7267e', 'hex');
const FOOT_MAGIC = Buffer.from('f85a8c6adef5d97eece90ce3758f290b', 'hex');
const FILE_ID = Buffer.from('28b32aebb624ccc2bfc8b02aa92bfcf1', 'hex');
const CREATION_TIME = '1970-01-01 10:00:00:000';
const SENTINEL = Buffer.alloc(13);
const CREATOR = 'MMD Canvas';

// ---------- typed property constructors ----------
const I = (v) => ({ t: 'I', v });
const L = (v) => ({ t: 'L', v: BigInt(v) });
const D = (v) => ({ t: 'D', v });
const S = (v) => ({ t: 'S', v });
const R = (v) => ({ t: 'R', v });
const C = (v) => ({ t: 'C', v });
const Ad = (v) => ({ t: 'd', v: v instanceof Float64Array ? v : Float64Array.from(v) });
const Ai = (v) => ({ t: 'i', v: v instanceof Int32Array ? v : Int32Array.from(v) });

function node(name, props = [], children = []) {
  return { name, props, children };
}
/** "Name::Class" in binary form */
const nameClass = (name, cls) => S(`${name}\x00\x01${cls}`);

function encodeProp(p) {
  switch (p.t) {
    case 'I': { const b = Buffer.alloc(5); b[0] = 0x49; b.writeInt32LE(p.v | 0, 1); return b; }
    case 'L': { const b = Buffer.alloc(9); b[0] = 0x4c; b.writeBigInt64LE(p.v, 1); return b; }
    case 'D': { const b = Buffer.alloc(9); b[0] = 0x44; b.writeDoubleLE(p.v, 1); return b; }
    case 'C': { return Buffer.from([0x43, p.v ? 1 : 0]); }
    case 'S': case 'R': {
      const data = p.t === 'S' ? Buffer.from(p.v, 'utf8') : p.v;
      const b = Buffer.alloc(5 + data.length);
      b[0] = p.t === 'S' ? 0x53 : 0x52;
      b.writeUInt32LE(data.length, 1);
      data.copy(b, 5);
      return b;
    }
    case 'd': case 'i': {
      const raw = Buffer.from(p.v.buffer, p.v.byteOffset, p.v.byteLength);
      const compress = raw.length >= 128;
      const data = compress ? zlib.deflateSync(raw, { level: 6 }) : raw;
      const b = Buffer.alloc(13 + data.length);
      b[0] = p.t.charCodeAt(0);
      b.writeUInt32LE(p.v.length, 1);
      b.writeUInt32LE(compress ? 1 : 0, 5);
      b.writeUInt32LE(data.length, 9);
      data.copy(b, 13);
      return b;
    }
    default: throw new Error(`FBX: unknown property type ${p.t}`);
  }
}

function prepare(n) {
  n._props = n.props.map(encodeProp);
  n._propsLen = n._props.reduce((a, b) => a + b.length, 0);
  n._name = Buffer.from(n.name, 'latin1');
  n.children.forEach(prepare);
}
function childrenSize(n, isLast) {
  let size = 0;
  n.children.forEach((c, i) => { size += nodeSize(c, i === n.children.length - 1); });
  if (n.children.length) size += 13;
  else if (!n.props.length && !isLast) size += 13;
  return size;
}
function nodeSize(n, isLast) {
  n._size = 13 + n._name.length + n._propsLen + childrenSize(n, isLast);
  return n._size;
}
function writeNode(n, isLast, out, offset) {
  const head = Buffer.alloc(13);
  head.writeUInt32LE(offset + n._size, 0);
  head.writeUInt32LE(n.props.length, 4);
  head.writeUInt32LE(n._propsLen, 8);
  head[12] = n._name.length;
  out.push(head, n._name, ...n._props);
  let pos = offset + 13 + n._name.length + n._propsLen;
  n.children.forEach((c, i) => { writeNode(c, i === n.children.length - 1, out, pos); pos += c._size; });
  if (n.children.length) out.push(SENTINEL);
  else if (!n.props.length && !isLast) out.push(SENTINEL);
}

function serialize(topNodes) {
  const root = { name: '', props: [], children: topNodes };
  topNodes.forEach(prepare);
  const out = [HEAD_MAGIC];
  const v = Buffer.alloc(4); v.writeUInt32LE(FBX_VERSION);
  out.push(v);
  let pos = HEAD_MAGIC.length + 4;
  topNodes.forEach((c, i) => { nodeSize(c, i === topNodes.length - 1); });
  topNodes.forEach((c, i) => { writeNode(c, i === topNodes.length - 1, out, pos); pos += c._size; });
  out.push(SENTINEL); pos += 13;
  out.push(FOOT_ID, Buffer.alloc(4)); pos += 20;
  let pad = ((pos + 15) & ~15) - pos;
  if (pad === 0) pad = 16;
  out.push(Buffer.alloc(pad), v, Buffer.alloc(120), FOOT_MAGIC);
  void root;
  return Buffer.concat(out);
}

// ---------- Properties70 helpers ----------
const P = (name, type, label, flags, ...values) => node('P', [S(name), S(type), S(label), S(flags), ...values]);
const pInt = (name, v) => P(name, 'int', 'Integer', '', I(v));
const pDouble = (name, v) => P(name, 'double', 'Number', '', D(v));
const pNumberA = (name, v) => P(name, 'Number', '', 'A', D(v));
const pColorA = (name, c) => P(name, 'Color', '', 'A', D(c[0]), D(c[1]), D(c[2]));
const pColor = (name, c) => P(name, 'ColorRGB', 'Color', '', D(c[0]), D(c[1]), D(c[2]));
const pString = (name, v) => P(name, 'KString', '', '', S(v));
const pBool = (name, v) => P(name, 'bool', '', '', I(v ? 1 : 0));
const pEnum = (name, v) => P(name, 'enum', '', '', I(v));
const pTime = (name, v) => P(name, 'KTime', 'Time', '', L(v));
const pVec = (name, v) => P(name, 'Vector3D', 'Vector', '', D(v[0]), D(v[1]), D(v[2]));
const pLcl = (name, v) => P(name, name, '', 'A', D(v[0]), D(v[1]), D(v[2]));

const translationMatrix = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
const IDENTITY = translationMatrix([0, 0, 0]);

function modelNode(id, name, cls, translation, extraProps = []) {
  return node('Model', [L(id), nameClass(name, 'Model'), S(cls)], [
    node('Version', [I(232)]),
    node('Properties70', [], [
      pLcl('Lcl Translation', translation),
      pLcl('Lcl Rotation', [0, 0, 0]),
      pLcl('Lcl Scaling', [1, 1, 1]),
      pInt('DefaultAttributeIndex', 0),
      pEnum('InheritType', 1),
      ...extraProps,
    ]),
    node('MultiLayer', [I(0)]),
    node('MultiTake', [I(0)]),
    node('Shading', [C(true)]),
    node('Culling', [S('CullingOff')]),
  ]);
}

/**
 * @param scene normalised scene from buildScene()
 * @param {object} textureMap Map<pmx texture path, {absolute, relative, hasAlpha}>
 * @returns {Buffer}
 */
export function writeFbx(scene, textureMap = new Map(), options = {}) {
  let nextId = 1000000n;
  const newId = () => (nextId += 1n);
  const objects = [];
  const connections = [];
  const counts = {};
  const add = (type, n) => { objects.push(n); counts[type] = (counts[type] || 0) + 1; };
  const connect = (child, parent) => connections.push(node('C', [S('OO'), L(child), L(parent)]));
  const connectProp = (child, parent, prop) => connections.push(node('C', [S('OP'), L(child), L(parent), S(prop)]));

  const vCount = scene.vertexCount;
  const idx = scene.indices;
  const triCount = idx.length / 3;
  const hasBones = scene.bones.length > 0;
  const modelName = scene.name || 'Model';

  // ---- root null (armature) + mesh model ----
  const rootId = newId();
  add('Model', modelNode(rootId, modelName, 'Null', [0, 0, 0]));
  connect(rootId, 0n);
  const rootAttrId = newId();
  add('NodeAttribute', node('NodeAttribute', [L(rootAttrId), nameClass(modelName, 'NodeAttribute'), S('Null')], [
    node('TypeFlags', [S('Null')]),
  ]));
  connect(rootAttrId, rootId);

  const meshId = newId();
  add('Model', modelNode(meshId, `${modelName}_mesh`, 'Mesh', [0, 0, 0]));
  connect(meshId, rootId);

  // ---- geometry ----
  const geomId = newId();
  const vertices = Float64Array.from(scene.positions);
  const polyIdx = new Int32Array(idx.length);
  const uvIndex = new Int32Array(idx.length);
  const polyNormals = new Float64Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    const vi = idx[i];
    polyIdx[i] = i % 3 === 2 ? ~vi : vi;
    uvIndex[i] = vi;
    polyNormals[i * 3] = scene.normals[vi * 3];
    polyNormals[i * 3 + 1] = scene.normals[vi * 3 + 1];
    polyNormals[i * 3 + 2] = scene.normals[vi * 3 + 2];
  }
  const matIndex = new Int32Array(triCount);
  scene.materials.forEach((m, mi) => {
    matIndex.fill(mi, m.indexStart / 3, (m.indexStart + m.indexCount) / 3);
  });
  const layerElems = [
    node('LayerElement', [], [node('Type', [S('LayerElementNormal')]), node('TypedIndex', [I(0)])]),
    node('LayerElement', [], [node('Type', [S('LayerElementUV')]), node('TypedIndex', [I(0)])]),
  ];
  const geomChildren = [
    node('GeometryVersion', [I(124)]),
    node('Vertices', [Ad(vertices)]),
    node('PolygonVertexIndex', [Ai(polyIdx)]),
    node('LayerElementNormal', [I(0)], [
      node('Version', [I(101)]),
      node('Name', [S('')]),
      node('MappingInformationType', [S('ByPolygonVertex')]),
      node('ReferenceInformationType', [S('Direct')]),
      node('Normals', [Ad(polyNormals)]),
    ]),
    node('LayerElementUV', [I(0)], [
      node('Version', [I(101)]),
      node('Name', [S('UVMap')]),
      node('MappingInformationType', [S('ByPolygonVertex')]),
      node('ReferenceInformationType', [S('IndexToDirect')]),
      node('UV', [Ad(Float64Array.from(scene.uvs))]),
      node('UVIndex', [Ai(uvIndex)]),
    ]),
  ];
  if (scene.materials.length) {
    geomChildren.push(node('LayerElementMaterial', [I(0)], [
      node('Version', [I(101)]),
      node('Name', [S('')]),
      node('MappingInformationType', [S('ByPolygon')]),
      node('ReferenceInformationType', [S('IndexToDirect')]),
      node('Materials', [Ai(matIndex)]),
    ]));
    layerElems.push(node('LayerElement', [], [node('Type', [S('LayerElementMaterial')]), node('TypedIndex', [I(0)])]));
  }
  geomChildren.push(node('Layer', [I(0)], [node('Version', [I(100)]), ...layerElems]));
  add('Geometry', node('Geometry', [L(geomId), nameClass(`${modelName}_mesh`, 'Geometry'), S('Mesh')], geomChildren));
  connect(geomId, meshId);

  // ---- materials & textures ----
  const textureObjects = new Map(); // pmx path -> texture id
  scene.materials.forEach((m) => {
    const matId = newId();
    const amb = m.ambient;
    add('Material', node('Material', [L(matId), nameClass(m.name, 'Material'), S('')], [
      node('Version', [I(102)]),
      node('ShadingModel', [S('phong')]),
      node('MultiLayer', [I(0)]),
      node('Properties70', [], [
        pString('ShadingModel', 'phong'),
        pColorA('DiffuseColor', m.texture && textureMap.get(m.texture) ? [1, 1, 1] : m.baseColor),
        pNumberA('DiffuseFactor', 1),
        pColorA('AmbientColor', amb),
        pNumberA('AmbientFactor', 1),
        pColorA('EmissiveColor', [0, 0, 0]),
        pNumberA('EmissiveFactor', 0),
        pColorA('SpecularColor', m.specular),
        pNumberA('SpecularFactor', Math.max(...m.specular) > 0 ? 0.25 : 0),
        pNumberA('Shininess', Math.max(m.shininess, 1)),
        pNumberA('ShininessExponent', Math.max(m.shininess, 1)),
        pColorA('TransparentColor', [1, 1, 1]),
        pNumberA('TransparencyFactor', 1 - m.alpha),
        pDouble('Opacity', m.alpha),
        pColorA('ReflectionColor', [1, 1, 1]),
        pNumberA('ReflectionFactor', 0),
      ]),
    ]));
    connect(matId, meshId);

    const tex = m.texture && textureMap.get(m.texture);
    if (!tex) return;
    let texId = textureObjects.get(m.texture);
    if (!texId) {
      texId = newId();
      const vidId = newId();
      const texName = tex.name;
      add('Texture', node('Texture', [L(texId), nameClass(texName, 'Texture'), S('')], [
        node('Type', [S('TextureVideoClip')]),
        node('Version', [I(202)]),
        node('TextureName', [nameClass(texName, 'Texture')]),
        node('Properties70', [], [
          pEnum('CurrentTextureBlendMode', 0),
          pString('UVSet', 'UVMap'),
          pBool('UseMaterial', true),
          pEnum('WrapModeU', 0),
          pEnum('WrapModeV', 0),
        ]),
        node('Media', [nameClass(texName, 'Video')]),
        node('FileName', [S(tex.absolute)]),
        node('RelativeFilename', [S(tex.relative)]),
        node('ModelUVTranslation', [D(0), D(0)]),
        node('ModelUVScaling', [D(1), D(1)]),
        node('Texture_Alpha_Source', [S(tex.hasAlpha ? 'Alpha_Black' : 'None')]),
        node('Cropping', [I(0), I(0), I(0), I(0)]),
      ]));
      add('Video', node('Video', [L(vidId), nameClass(texName, 'Video'), S('Clip')], [
        node('Type', [S('Clip')]),
        node('Properties70', [], [P('Path', 'KString', 'XRefUrl', '', S(tex.absolute))]),
        node('UseMipMap', [I(0)]),
        node('Filename', [S(tex.absolute)]),
        node('RelativeFilename', [S(tex.relative)]),
      ]));
      connect(vidId, texId);
      textureObjects.set(m.texture, texId);
    }
    connectProp(texId, matId, 'DiffuseColor');
    if (tex.hasAlpha) connectProp(texId, matId, 'TransparentColor');
  });

  // ---- skeleton ----
  const boneIds = [];
  if (hasBones) {
    // bone display size: a fraction of the model height keeps viewers readable
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < scene.positions.length; i += 3) {
      if (scene.positions[i] < minY) minY = scene.positions[i];
      if (scene.positions[i] > maxY) maxY = scene.positions[i];
    }
    const boneSize = Number.isFinite(maxY - minY) ? Math.max((maxY - minY) * 0.02, 0.01) : 1;
    scene.bones.forEach((b, bi) => {
      const id = newId();
      boneIds.push(id);
      add('Model', modelNode(id, b.name, 'LimbNode', b.local));
      connect(id, b.parent >= 0 ? boneIds[b.parent] : rootId);
      const attrId = newId();
      add('NodeAttribute', node('NodeAttribute', [L(attrId), nameClass(b.name, 'NodeAttribute'), S('LimbNode')], [
        node('Properties70', [], [pDouble('Size', boneSize)]),
        node('TypeFlags', [S('Skeleton')]),
      ]));
      connect(attrId, id);
      void bi;
    });

    // per-bone weight lists
    const lists = scene.bones.map(() => ({ i: [], w: [] }));
    for (let v = 0; v < vCount; v++) {
      for (let k = 0; k < 4; k++) {
        const wt = scene.skinWeights[v * 4 + k];
        if (wt > 0) { const l = lists[scene.skinIndices[v * 4 + k]]; l.i.push(v); l.w.push(wt); }
      }
    }
    const skinId = newId();
    add('Deformer', node('Deformer', [L(skinId), nameClass(modelName, 'Deformer'), S('Skin')], [
      node('Version', [I(101)]),
      node('Link_DeformAcuracy', [D(50)]),
      node('SkinningType', [S('Linear')]),
    ]));
    connect(skinId, geomId);
    scene.bones.forEach((b, bi) => {
      const cid = newId();
      const children = [node('Version', [I(100)]), node('UserData', [S(''), S('')])];
      if (lists[bi].i.length) {
        children.push(node('Indexes', [Ai(lists[bi].i)]), node('Weights', [Ad(lists[bi].w)]));
      }
      // Transform is stored in bone space: inverse(boneWorld) * meshWorld
      children.push(
        node('Transform', [Ad(translationMatrix([-b.position[0], -b.position[1], -b.position[2]]))]),
        node('TransformLink', [Ad(translationMatrix(b.position))]),
        node('TransformAssociateModel', [Ad(IDENTITY)]),
      );
      add('Deformer', node('Deformer', [L(cid), nameClass(b.name, 'SubDeformer'), S('Cluster')], children));
      connect(cid, skinId);
      connect(boneIds[bi], cid);
    });

    const poseNodes = [
      node('PoseNode', [], [node('Node', [L(meshId)]), node('Matrix', [Ad(IDENTITY)])]),
      node('PoseNode', [], [node('Node', [L(rootId)]), node('Matrix', [Ad(IDENTITY)])]),
      ...scene.bones.map((b, bi) => node('PoseNode', [], [
        node('Node', [L(boneIds[bi])]), node('Matrix', [Ad(translationMatrix(b.position))]),
      ])),
    ];
    add('Pose', node('Pose', [L(newId()), nameClass(modelName, 'Pose'), S('BindPose')], [
      node('Type', [S('BindPose')]),
      node('Version', [I(100)]),
      node('NbPoseNodes', [I(poseNodes.length)]),
      ...poseNodes,
    ]));
  }

  // ---- blend shapes ----
  if (scene.morphs.length) {
    const bsId = newId();
    add('Deformer', node('Deformer', [L(bsId), nameClass(modelName, 'Deformer'), S('BlendShape')], [
      node('Version', [I(100)]),
    ]));
    connect(bsId, geomId);
    for (const m of scene.morphs) {
      const chId = newId();
      add('Deformer', node('Deformer', [L(chId), nameClass(m.name, 'SubDeformer'), S('BlendShapeChannel')], [
        node('Version', [I(100)]),
        node('DeformPercent', [D(0)]),
        node('FullWeights', [Ad([100])]),
      ]));
      connect(chId, bsId);
      const shId = newId();
      const shapeNormals = new Float64Array(m.offsets.length);
      shapeNormals[0] = 1.1e-6; // Unity recalculates normals when every shape normal delta is exactly 0
      add('Geometry', node('Geometry', [L(shId), nameClass(m.name, 'Geometry'), S('Shape')], [
        node('Version', [I(100)]),
        node('Indexes', [Ai(Int32Array.from(m.indices))]),
        node('Vertices', [Ad(Float64Array.from(m.offsets))]),
        node('Normals', [Ad(shapeNormals)]),
      ]));
      connect(shId, chId);
    }
  }

  // ---- file skeleton ----
  const now = options.date || new Date();
  const header = node('FBXHeaderExtension', [], [
    node('FBXHeaderVersion', [I(1003)]),
    node('FBXVersion', [I(FBX_VERSION)]),
    node('EncryptionType', [I(0)]),
    node('CreationTimeStamp', [], [
      node('Version', [I(1000)]),
      node('Year', [I(now.getFullYear())]), node('Month', [I(now.getMonth() + 1)]), node('Day', [I(now.getDate())]),
      node('Hour', [I(now.getHours())]), node('Minute', [I(now.getMinutes())]), node('Second', [I(now.getSeconds())]),
      node('Millisecond', [I(0)]),
    ]),
    node('Creator', [S(CREATOR)]),
    node('SceneInfo', [nameClass('GlobalInfo', 'SceneInfo'), S('UserData')], [
      node('Type', [S('UserData')]),
      node('Version', [I(100)]),
      node('MetaData', [], [
        node('Version', [I(100)]), node('Title', [S(modelName)]), node('Subject', [S('')]), node('Author', [S('')]),
        node('Keywords', [S('')]), node('Revision', [S('')]), node('Comment', [S('')]),
      ]),
      node('Properties70', [], [
        P('DocumentUrl', 'KString', 'Url', '', S(options.fileName || '')),
        P('SrcDocumentUrl', 'KString', 'Url', '', S(options.fileName || '')),
        P('Original|ApplicationName', 'KString', '', '', S('MMD Canvas')),
        P('LastSaved|ApplicationName', 'KString', '', '', S('MMD Canvas')),
      ]),
    ]),
  ]);

  const globalSettings = node('GlobalSettings', [], [
    node('Version', [I(1000)]),
    node('Properties70', [], [
      pInt('UpAxis', 1), pInt('UpAxisSign', 1),
      pInt('FrontAxis', 2), pInt('FrontAxisSign', 1),
      pInt('CoordAxis', 0), pInt('CoordAxisSign', 1),
      pInt('OriginalUpAxis', 1), pInt('OriginalUpAxisSign', 1),
      pDouble('UnitScaleFactor', 1), pDouble('OriginalUnitScaleFactor', 1),
      pColor('AmbientColor', [0, 0, 0]),
      pString('DefaultCamera', 'Producer Perspective'),
      pEnum('TimeMode', 6),
      pTime('TimeSpanStart', 0), pTime('TimeSpanStop', 46186158000n),
      pDouble('CustomFrameRate', 30),
    ]),
  ]);

  const documents = node('Documents', [], [
    node('Count', [I(1)]),
    node('Document', [L(newId()), S('Scene'), S('Scene')], [
      node('Properties70', [], [
        P('SourceObject', 'object', '', ''),
        pString('ActiveAnimStackName', ''),
      ]),
      node('RootNode', [L(0)]),
    ]),
  ]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0) + 1;
  const definitions = node('Definitions', [], [
    node('Version', [I(100)]),
    node('Count', [I(total)]),
    node('ObjectType', [S('GlobalSettings')], [node('Count', [I(1)])]),
    ...Object.entries(counts).map(([type, c]) => node('ObjectType', [S(type)], [node('Count', [I(c)])])),
  ]);

  void pVec;
  return serialize([
    header,
    node('FileId', [R(FILE_ID)]),
    node('CreationTime', [S(CREATION_TIME)]),
    node('Creator', [S(CREATOR)]),
    globalSettings,
    documents,
    node('References', [], []),
    definitions,
    node('Objects', [], objects),
    node('Connections', [], connections),
    node('Takes', [], [node('Current', [S('')])]),
  ]);
}
