// `.shader` data container: a standalone shader asset (metadata + assembled function
// stack layers). Shaders live on disk as `.shader` files (typically in a `shaders/`
// directory beside the `.canvas`); the workspace stores relative-path REFERENCES to
// them plus per-material instance values, not the shader code itself.
//
// v2 layers contain {id,ref,enabled}; code/defaults live in separate .shaderStack
// functions. v1 embedded layers are readable for migration on save. Per-material
// instance values remain in the workspace, keyed by the stable layer IDs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SHADER_FORMAT = 'mmd-canvas-shader';
export const SHADER_VERSION = 2;
const MAX_BYTES = 1024 * 1024;
const MAX_LAYERS = 64;

const fail = (field) => { throw new Error(`올바르지 않은 셰이더 파일 항목: ${field}`); };
const object = (v, field) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail(field);
const string = (v, field, max = 32768) => typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : fail(field);
const bool = (v, field) => typeof v === 'boolean' ? v : fail(field);

const layer = (item, field, version) => {
  const l = object(item, `${field}.layer`);
  return {
    id: string(l.id, `${field}.id`, 64),
    ...(version === 1 ? {
      name: string(l.name, `${field}.name`, 128),
      code: string(l.code, `${field}.code`, 32768),
    } : { ref: string(l.ref, `${field}.ref`, 32768) }),
    enabled: l.enabled === undefined ? true : bool(l.enabled, `${field}.enabled`),
  };
};

const metadata = (v, field) => {
  const m = v === undefined ? {} : object(v, field);
  const out = { tags: Array.isArray(m.tags) ? m.tags.slice(0, 32).filter(x => typeof x === 'string' && x.length <= 64 && !x.includes('\0')) : [] };
  if (typeof m.description === 'string') out.description = m.description.slice(0, 4096);
  if (typeof m.author === 'string') out.author = m.author.slice(0, 128);
  if (typeof m.createdAt === 'string' && m.createdAt.length <= 40) out.createdAt = m.createdAt;
  if (typeof m.modifiedAt === 'string' && m.modifiedAt.length <= 40) out.modifiedAt = m.modifiedAt;
  return out;
};

/** Validate before writing or after reading; only known, inert state is retained. */
export function validateShaderFile(data) {
  const d = object(data, 'shader');
  if (d.format !== SHADER_FORMAT) fail('format');
  if (d.version !== 1 && d.version !== SHADER_VERSION) fail('version');
  if (!Array.isArray(d.layers)) fail('layers');
  if (d.layers.length > MAX_LAYERS) fail('layers.length');
  const layers = d.layers.map((l, i) => layer(l, `layers[${i}]`, d.version));
  if (layers.some(l => !l.id) || new Set(layers.map(l => l.id)).size !== layers.length) fail('layers.id');
  if (d.version === 2 && layers.some(l => !/\.shaderstack$/i.test(l.ref))) fail('layers.ref');
  return {
    format: SHADER_FORMAT, version: d.version,
    name: string(d.name, 'name', 128),
    outline: d.outline === undefined ? false : bool(d.outline, 'outline'),
    metadata: metadata(d.metadata, 'metadata'),
    layers,
  };
}

export async function readShaderFile(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.shader') fail('extension');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_BYTES) fail('size');
  const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  return validateShaderFile(JSON.parse(raw));
}

export async function writeShaderFile(filePath, data) {
  if (path.extname(filePath).toLowerCase() !== '.shader') fail('extension');
  filePath = path.resolve(filePath);
  const validated = validateShaderFile(data);
  validated.metadata = { ...validated.metadata, modifiedAt: new Date().toISOString() };
  const json = JSON.stringify(validated, null, 2) + '\n';
  if (Buffer.byteLength(json) > MAX_BYTES) fail('size');
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, json, { flag: 'wx' }); await fs.rename(tmp, filePath); }
  finally { await fs.rm(tmp, { force: true }); }
  return filePath;
}

/** Build a `.shader` container from a library entry (drops runtime-only fields). */
export function shaderContainer(entry) {
  return {
    format: SHADER_FORMAT, version: SHADER_VERSION,
    name: entry.name, outline: !!entry.outline,
    metadata: entry.metadata || { tags: [] },
    layers: (entry.layers || []).map(l => ({ id: l.id, ref: l.ref, enabled: l.enabled !== false })),
  };
}
