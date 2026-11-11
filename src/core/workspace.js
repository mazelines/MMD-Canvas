import { t } from '../i18n/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const WORKSPACE_FORMAT = 'mmd-canvas-workspace';
export const WORKSPACE_VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const fail = (field) => { throw new Error(t`올바르지 않은 워크스페이스 항목: ${field}`); };
const object = (v, field) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail(field);
const string = (v, field, max = 32768) => typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : fail(field);
const bool = (v, field) => typeof v === 'boolean' ? v : fail(field);
const number = (v, field, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(field);
const choice = (v, field, choices) => choices.includes(v) ? v : fail(field);
const vector = (v, field) => Array.isArray(v) && v.length === 3 ? v.map((n) => number(n, field, -1e15, 1e15)) : fail(field);
const list = (v, field, fn) => Array.isArray(v) && v.length <= 100000 ? v.map(fn) : fail(field);
const nullablePath = (v, field) => v === null ? null : string(v, field);

/** Validate before changing the UI or writing a file; only known, inert state is retained. */
export function validateWorkspace(value) {
  const d = object(value, t('파일'));
  if (d.format !== WORKSPACE_FORMAT) throw new Error(t('MMD Canvas 워크스페이스 파일이 아닙니다.'));
  if (d.version !== WORKSPACE_VERSION) throw new Error(t`지원하지 않는 .canvas 버전입니다: ${d.version}`);
  const b = object(d.browser, 'browser'), v = object(d.viewport, 'viewport');
  const c = object(d.conversion, 'conversion'), i = object(d.inspector, 'inspector');
  const camera = object(v.camera, 'camera'), outline = object(v.outline, 'outline'), flags = object(v.flags, 'flags');
  const result = {
    format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION,
    browser: { directory: nullablePath(b.directory, 'directory'), filter: string(b.filter, 'filter', 4096), only3d: bool(b.only3d, 'only3d') },
    model: null,
    viewport: {
      mode: choice(v.mode, 'mode', ['lambert', 'toon']),
      outline: { width: number(outline.width, 'outline.width', 0, 8), color: /^#[0-9a-f]{6}$/i.test(outline.color) ? outline.color : fail('outline.color') },
      flags: Object.fromEntries(['grid', 'skeleton', 'wireframe'].map((key) => [key, bool(flags[key], key)])),
      lightIntensity: number(v.lightIntensity, 'lightIntensity', 0, 3), lightDirection: vector(v.lightDirection, 'lightDirection'),
      shadowEnabled: bool(v.shadowEnabled, 'shadowEnabled'), shadowSoftness: number(v.shadowSoftness, 'shadowSoftness', 0, 0.12),
      gizmo: bool(v.gizmo, 'gizmo'), gizmoSpace: choice(v.gizmoSpace, 'gizmoSpace', ['local', 'world']),
      gizmoMode: choice(v.gizmoMode, 'gizmoMode', ['translate', 'rotate']), gizmoPosition: vector(v.gizmoPosition, 'gizmoPosition'),
      camera: {
        position: vector(camera.position, 'camera.position'), target: vector(camera.target, 'camera.target'), up: vector(camera.up, 'camera.up'),
        fov: number(camera.fov, 'camera.fov', 1, 179), zoom: number(camera.zoom, 'camera.zoom', 1e-6, 1e6),
        near: number(camera.near, 'camera.near', 1e-12, 1e15), far: number(camera.far, 'camera.far', 1e-12, 1e15),
        maxDistance: number(camera.maxDistance, 'camera.maxDistance', 1e-12, 1e15),
      },
    },
    conversion: {
      mode: choice(c.mode, 'conversion.mode', ['single', 'batch']), format: choice(c.format, 'conversion.format', ['fbx', 'usda', 'usdz']),
      output: string(c.output, 'output'), source: nullablePath(c.source, 'conversion.source'), scale: choice(c.scale, 'scale', [1, 8, 10, 100]),
      nameMode: choice(c.nameMode, 'nameMode', ['original', 'english']),
      ...Object.fromEntries(['morphs', 'copyTextures', 'asciiNames', 'recursive'].map((key) => [key, bool(c[key], key)])),
    },
    inspector: {
      tab: choice(i.tab, 'inspector.tab', ['overview', 'materials']),
      selectedMaterial: Number.isInteger(i.selectedMaterial) ? number(i.selectedMaterial, 'selectedMaterial', 0, 100000) : fail('selectedMaterial'),
      filter: string(i.filter, 'material filter', 4096),
      soloVisibility: i.soloVisibility === null ? null : list(i.soloVisibility, 'soloVisibility', (v) => bool(v, 'soloVisibility')),
    },
  };
  if (d.model !== null) {
    const m = object(d.model, 'model');
    result.model = {
      path: string(m.path, 'model.path'),
      materials: list(m.materials, 'materials', (item) => ({ name: string(object(item, 'material').name, 'material.name', 4096), visible: bool(item.visible, 'visible') })),
      morphs: list(m.morphs, 'morphs', (item) => ({ name: string(object(item, 'morph').name, 'morph.name', 4096), weight: number(item.weight, 'weight', 0, 1) })),
    };
    if (!result.model.path) fail('model.path');
  }
  if (camera.far <= camera.near || Math.hypot(...result.viewport.lightDirection) < 1e-12 || Math.hypot(...result.viewport.camera.up) < 1e-12) fail('camera / lightDirection');
  if (camera.position.every((value, index) => value === camera.target[index])) fail('camera.target');
  return result;
}

function mapPaths(data, fn) {
  data.browser.directory = data.browser.directory ? fn(data.browser.directory) : null;
  if (data.model) data.model.path = fn(data.model.path);
  if (data.conversion.output) data.conversion.output = fn(data.conversion.output);
  if (data.conversion.source) data.conversion.source = fn(data.conversion.source);
  return data;
}

export function encodeWorkspace(data, filePath, paths = path) {
  const directory = paths.dirname(filePath);
  return mapPaths(validateWorkspace(data), (target) => {
    const absolute = paths.resolve(target);
    const relative = paths.relative(directory, absolute);
    return (paths.isAbsolute(relative) ? absolute : relative || '.').split(paths.sep).join('/');
  });
}

export function decodeWorkspace(data, filePath, paths = path) {
  return mapPaths(validateWorkspace(data), (target) => paths.resolve(paths.dirname(filePath), target));
}

/**
 * UNC paths a decoded workspace would make the app contact. Paths on the server the workspace file
 * itself was opened from are not listed: opening it already reached that server.
 */
export function networkPaths(data, filePath = '') {
  const host = (p) => /^[\\/]{2}([^\\/]+)/.exec(p)?.[1].toLowerCase() || null;
  const own = host(filePath);
  const paths = [data.browser.directory, data.model?.path, data.conversion.output, data.conversion.source];
  return [...new Set(paths.filter((p) => typeof p === 'string' && host(p) && host(p) !== own))];
}

export async function readWorkspace(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.canvas') throw new Error(t('.canvas 파일을 선택하세요.'));
  if ((await fs.stat(filePath)).size > MAX_BYTES) throw new Error(t('.canvas 파일이 너무 큽니다 (최대 8MB).'));
  let data;
  try { data = JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error(t('.canvas 파일을 읽을 수 없습니다. JSON 형식을 확인하세요.')); }
  return decodeWorkspace(data, path.resolve(filePath));
}

export async function writeWorkspace(filePath, data) {
  if (path.extname(filePath).toLowerCase() !== '.canvas') throw new Error(t('워크스페이스는 .canvas 파일로 저장해야 합니다.'));
  filePath = path.resolve(filePath);
  const encoded = encodeWorkspace(data, filePath);
  const text = JSON.stringify({ ...encoded, savedAt: new Date().toISOString() }, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(t('워크스페이스가 너무 큽니다 (최대 8MB).'));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filePath);
  } finally { await fs.rm(temporary, { force: true }); }
  return filePath;
}
