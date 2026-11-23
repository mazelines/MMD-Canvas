// Disk assets: a .shader assembles ordered instances of .shaderStack functions.
// Runtime layers retain resolved code, but v2 shader files contain only references.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseLayer } from './shader-stack.js';
import { readShaderFile, writeShaderFile, shaderContainer, validateShaderFile } from './shader-file.js';

export const FUNCTION_FORMAT = 'mmd-canvas-shader-stack';
export const FUNCTION_VERSION = 1;
const MAX_BYTES = 1024 * 1024;
export function validateFunctionAsset(value) {
  if (!value || value.format !== FUNCTION_FORMAT || value.version !== FUNCTION_VERSION)
    throw new Error('올바르지 않은 .shaderStack 포맷입니다.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 || value.name.includes('\0'))
    throw new Error('올바르지 않은 함수 이름입니다.');
  if (typeof value.code !== 'string' || value.code.length > 32768 || value.code.includes('\0'))
    throw new Error('올바르지 않은 함수 코드입니다.');
  const parsed = parseLayer(value.code);
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
  const m = value.metadata || {}, metadata = {};
  for (const key of ['description', 'author', 'createdAt', 'modifiedAt'])
    if (typeof m[key] === 'string') metadata[key] = m[key].slice(0, key === 'description' ? 4096 : 128);
  metadata.tags = Array.isArray(m.tags) ? m.tags.filter(t => typeof t === 'string').slice(0, 32).map(t => t.slice(0, 64)) : [];
  return { format: FUNCTION_FORMAT, version: FUNCTION_VERSION, name: value.name, metadata, code: value.code };
}
export function functionContainer(layer) {
  return validateFunctionAsset({ format: FUNCTION_FORMAT, version: FUNCTION_VERSION,
    name: layer.name || parseLayer(layer.code).name, code: layer.code, metadata: layer.metadata });
}
export async function readFunctionAsset(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.shaderstack') throw new Error('Not a .shaderStack file');
  if ((await fs.stat(filePath)).size > MAX_BYTES) throw new Error('함수 파일이 너무 큽니다.');
  return validateFunctionAsset(JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')));
}
export async function writeFunctionAsset(filePath, value) {
  if (path.extname(filePath).toLowerCase() !== '.shaderstack') throw new Error('Not a .shaderStack file');
  const data = validateFunctionAsset(value);
  data.metadata.modifiedAt = new Date().toISOString();
  const text = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('함수 파일이 너무 큽니다.');
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, text, { flag: 'wx' }); await fs.rename(tmp, filePath); }
  finally { await fs.rm(tmp, { force: true }); }
  return data;
}
export async function loadShaderAsset(filePath) {
  filePath = path.resolve(filePath);
  const data = await readShaderFile(filePath);
  if (data.version === 1) return data; // legacy layers migrate only when saved
  const layers = [];
  for (const layer of data.layers) {
    const ref = path.resolve(path.dirname(filePath), layer.ref);
    try {
      const asset = await readFunctionAsset(ref);
      layers.push({ id: layer.id, enabled: layer.enabled, ref, name: asset.name, code: asset.code, metadata: asset.metadata });
    } catch (error) { throw new Error(`${filePath}\n${ref}: ${error.message}`); }
  }
  return { ...data, layers };
}
export async function discoverFunctionAssets(directory) {
  const assets = [], errors = [];
  const visit = async dir => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') errors.push({ path: dir, message: error.message });
      return [];
    });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile() && /\.shaderstack$/i.test(e.name)) {
        try { assets.push({ ...await readFunctionAsset(full), ref: path.resolve(full) }); }
        catch (error) { errors.push({ path: full, message: error.message }); }
      }
    }
  };
  if (directory) await visit(directory);
  return { assets, errors };
}
export async function saveShaderAsset(filePath, entry) {
  filePath = path.resolve(filePath);
  // Validate every dependency BEFORE writing any of them.
  const prepared = (entry.layers || []).map(layer => ({ layer, asset: functionContainer(layer) }));
  const layers = [], writes = new Map();
  for (const { layer, asset } of prepared) {
    let ref = layer.ref;
    if (ref && !path.isAbsolute(ref)) {
      if (!entry.path) throw new Error('상대 함수 참조의 기준 셰이더 경로가 없습니다.');
      ref = path.resolve(path.dirname(entry.path), ref);
    }
    if (!ref) {
      const stem = asset.name.replace(/[^\w가-힣.-]+/g, '_') || 'Function';
      ref = path.join(path.dirname(filePath), 'stacks', `${stem}-${randomUUID()}.shaderStack`);
    }
    const previous = writes.get(ref);
    if (previous && (previous.code !== asset.code || previous.name !== asset.name))
      throw new Error(`같은 함수에 서로 다른 편집 내용이 있습니다: ${ref}`);
    writes.set(ref, asset);
    layers.push({ ...layer, ref, name: asset.name, code: asset.code, metadata: asset.metadata });
  }
  const container = validateShaderFile(shaderContainer({ ...entry, layers: layers.map(layer => ({ ...layer,
    ref: path.relative(path.dirname(filePath), layer.ref).split(path.sep).join('/') })) }));
  // The parent is committed last; a failed dependency write never publishes dangling refs.
  // Existing missing dependencies are errors, rather than silently recreated assets.
  for (const { layer } of prepared) if (layer.ref) {
    const ref = path.isAbsolute(layer.ref) ? layer.ref : path.resolve(path.dirname(entry.path), layer.ref);
    await fs.access(ref);
  }
  for (const [ref, asset] of writes) {
    await fs.mkdir(path.dirname(ref), { recursive: true });
    await writeFunctionAsset(ref, asset);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeShaderFile(filePath, container);
  return { ...container, layers };
}
