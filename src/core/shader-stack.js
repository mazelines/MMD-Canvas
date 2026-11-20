// Shared shader-stack model: parses user-authored HLSL layer functions and their
// //@property annotations, lays out parameter buffer slots, and packs values.
// Used by both the renderer (auto-generated property controls) and Electron main
// (HLSL generation + parameter upload). A layer is `void <name>(inout ShadingContext ctx)`.
//
// Annotation grammar (one per line, above the function):
//   //@property <type> <name> = <default> [min,max] "label"
// type: float | float2 | float3 | float4 | int | bool | color
// Each property occupies one float4 slot in the userParams structured buffer.

export const PROPERTY_TYPES = ['float', 'float2', 'float3', 'float4', 'int', 'bool', 'color'];
const TYPE_RE = /^\/\/@property\s+(float4|float3|float2|float|int|bool|color)\s+([A-Za-z_]\w*)\s*=\s*(.*)$/;
const FUNC_RE = /void\s+([A-Za-z_]\w*)\s*\(\s*inout\s+ShadingContext\s+\w+\s*\)/;

// Upgrade only the exact shipped Toon fill, including the older single-layer
// DefaultToon. Edited/custom shader code, IDs and material parameters survive.
export function migrateBuiltinSky(library) {
  const oldFill = 'lerp(ctx.groundColor, ctx.skyColor, 0.5) * ctx.ambientLux';
  const fillBody = `    float3 flatFill = ${oldFill};
    ctx.color += ctx.albedo * (flatFill - ctx.fill) * ctx.ao / 3.141592653589793;`;
  const originals = [
    `void ToonFill(inout ShadingContext ctx) {\n${fillBody}\n}`,
    `//@property float shadowFloor = 0.251 [0,1] "그림자 바닥"
void DefaultToon(inout ShadingContext ctx) {
    float band = ctx.ndl < 0 ? shadowFloor : 1.0;
    float toonDirect = lerp(shadowFloor, band, ctx.shade);
    ctx.color += ctx.albedo * (toonDirect - ctx.direct) * ctx.sunLux / 3.141592653589793;
${fillBody}
}`,
  ];
  return library.map(stack => stack.name !== 'Default Toon' ? stack : {
    ...stack, layers: (stack.layers || []).map(layer => originals.includes(layer.code?.replace(/\r\n/g, '\n').trim())
      ? { ...layer, code: layer.code.replace(oldFill, 'evaluateAmbient(ctx.bentNormal, 0.5)') } : layer),
  });
}

function parseColorHex(str) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(str.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function parseVector(str) {
  const hex = parseColorHex(str);
  if (hex) return hex;
  const inner = str.trim().replace(/^\(/, '').replace(/\)$/, '');
  const parts = inner.split(',').map(s => Number(s.trim()));
  return parts.every(Number.isFinite) ? parts : null;
}
export function parseDefault(type, str) {
  const s = str.trim();
  if (type === 'bool') return s === 'true' ? 1 : 0;
  if (type === 'int' || type === 'float') { const n = Number(s); return Number.isFinite(n) ? n : 0; }
  const v = parseVector(s);
  const width = { float2: 2, float3: 3, float4: 4, color: 3 }[type];
  if (!v) return new Array(width).fill(0);
  while (v.length < width) v.push(0);
  return v.slice(0, width);
}

// Parse a single layer's code. Returns { name, properties, errors }. Properties
// carry a `slot` assigned by parseStack (global across the stack).
export function parseLayer(code) {
  const errors = [];
  const func = FUNC_RE.exec(code || '');
  if (!func) errors.push('함수 시그니처는 void 이름(inout ShadingContext ctx) 형식이어야 합니다.');
  const properties = [];
  for (const line of (code || '').split('\n')) {
    const m = TYPE_RE.exec(line.trim());
    if (!m) continue;
    const [, type, name, restRaw] = m;
    let rest = restRaw;
    let label = '';
    const labelMatch = /"([^"]*)"\s*$/.exec(rest);
    if (labelMatch) { label = labelMatch[1]; rest = rest.slice(0, labelMatch.index); }
    let min = null, max = null;
    const rangeMatch = /\[([^\]]+)\]\s*$/.exec(rest);
    if (rangeMatch) {
      const [a, b] = rangeMatch[1].split(',').map(s => Number(s.trim()));
      if (Number.isFinite(a) && Number.isFinite(b)) { min = a; max = b; }
      rest = rest.slice(0, rangeMatch.index);
    }
    const def = parseDefault(type, rest);
    if (properties.some(p => p.name === name)) errors.push(`중복 프로퍼티 이름: ${name}`);
    properties.push({ type, name, default: def, min, max, label: label || name });
  }
  return { name: func ? func[1] : null, properties, errors };
}

// Assign float4 slots across an ordered stack, starting at baseSlot (so multiple
// stacks can partition the single 256-slot userParams buffer). Returns
// { layers: [{ name, properties:[{...,slot}], errors }], slotCount, baseSlot }.
// slotCount is the local count; absolute slots run baseSlot..baseSlot+slotCount.
export function parseStack(layers, baseSlot = 0) {
  let slot = baseSlot;
  const parsed = (layers || []).map(layer => {
    const info = parseLayer(layer.code);
    info.properties.forEach(p => { p.slot = slot++; });
    return { ...info, enabled: layer.enabled !== false, id: layer.id };
  });
  return { layers: parsed, slotCount: slot - baseSlot, baseSlot };
}

// Pack parameter values into float4 slots for the native buffer.
// values: { [layerId]: { [propName]: number|number[] } }; falls back to defaults.
// baseSlot offsets this stack's slots; totalSlots sizes the (shared) buffer; out
// optionally writes into an existing combined buffer instead of allocating.
export function packParams(layers, values = {}, baseSlot = 0, totalSlots = null, out = null) {
  const { layers: parsed, slotCount } = parseStack(layers, baseSlot);
  const size = (totalSlots ?? (baseSlot + slotCount)) * 4;
  const data = out || new Float32Array(Math.max(1, size));
  for (const layer of parsed) {
    const layerValues = values[layer.id] || {};
    for (const p of layer.properties) {
      const raw = layerValues[p.name] !== undefined ? layerValues[p.name] : p.default;
      const off = p.slot * 4;
      if (Array.isArray(raw)) { for (let i = 0; i < 4; i++) data[off + i] = raw[i] ?? 0; }
      else data[off] = Number(raw) || 0;
    }
  }
  return data;
}

// Max property-slot count across a library (the per-material stride). Each native
// material owns STRIDE consecutive float4 slots; a stack's local slots index into
// its material's region via the b1 `materialId` root constant.
export function libraryStride(library) {
  let stride = 1;
  for (const stack of library || []) stride = Math.max(stride, parseStack(stack.layers || []).slotCount);
  return stride;
}

// HLSL local declarations reading a layer's properties from userParams (t149),
// indexed per material: userParams[materialId*stride + localSlot].
export function hlslDeclarations(layer, stride = 1) {
  return layer.properties.map(p => {
    const s = `userParams[materialId*${stride} + ${p.slot}]`;
    switch (p.type) {
      case 'int': return `    int ${p.name} = (int)${s}.x;`;
      case 'bool': return `    bool ${p.name} = ${s}.x > 0.5;`;
      case 'float2': return `    float2 ${p.name} = ${s}.xy;`;
      case 'float3': case 'color': return `    float3 ${p.name} = ${s}.xyz;`;
      case 'float4': return `    float4 ${p.name} = ${s}.xyzw;`;
      default: return `    float ${p.name} = ${s}.x;`;
    }
  }).join('\n');
}

// Inject a layer's property declarations at the top of its function body so the
// user's code can reference the property names directly.
export function injectDeclarations(code, layer, stride = 1) {
  const decls = hlslDeclarations(layer, stride);
  if (!decls) return code;
  const bodyRe = /(void\s+[A-Za-z_]\w*\s*\(\s*inout\s+ShadingContext\s+\w+\s*\)\s*\{)/;
  return code.replace(bodyRe, `$1\n${decls}\n`);
}

// Pack per-material instance values into the shared userParams buffer. panelIndices
// maps native materialId -> panel material index; instances[panelIndex] =
// { stackId, params:{layerId:{propName:value}} }. Each native material's region
// starts at nativeId*stride and uses its assigned stack's local slot layout.
export function packMaterialParams(library, instances, panelIndices, stride, nativeCount) {
  const data = new Float32Array(Math.max(1, nativeCount * stride) * 4);
  for (let nativeId = 0; nativeId < nativeCount; nativeId++) {
    const panelIndex = panelIndices[nativeId];
    const inst = instances?.[panelIndex];
    const stackId = inst?.stackId || 0;
    if (stackId < 1) continue;
    const stack = library[stackId - 1]; if (!stack) continue;
    const { layers } = parseStack(stack.layers || []);
    const base = nativeId * stride;
    for (const layer of layers) {
      const values = inst?.params?.[layer.id] || {};
      for (const p of layer.properties) {
        const raw = values[p.name] !== undefined ? values[p.name] : p.default;
        const off = (base + p.slot) * 4;
        if (Array.isArray(raw)) { for (let i = 0; i < 4; i++) data[off + i] = raw[i] ?? 0; }
        else data[off] = Number(raw) || 0;
      }
    }
  }
  return data;
}
