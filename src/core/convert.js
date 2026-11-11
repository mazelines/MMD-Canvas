import { t } from '../i18n/index.js';
// File-level conversion pipeline (Node): PMX file -> FBX / USDA / USDZ file + textures.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePmx } from './pmx-parser.js';
import { buildScene, DEFAULT_SCENE_OPTIONS } from './scene.js';
import { writeFbx } from './fbx-writer.js';
import { writeUsda, packUsdz } from './usd-writer.js';
import { textureUsesAlpha } from './texture-alpha.js';

export const OUTPUT_FORMATS = {
  fbx: { ext: '.fbx', label: 'Autodesk FBX (binary 7.4)' },
  usda: { ext: '.usda', label: 'USD (text)' },
  usdz: { ext: '.usdz', label: 'USDZ (package)' },
};

export const DEFAULT_CONVERT_OPTIONS = {
  ...DEFAULT_SCENE_OPTIONS,
  copyTextures: true,
  asciiNames: false, // USD only: force ASCII prim names
};

export function formatFromPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.fbx') return 'fbx';
  if (ext === '.usda' || ext === '.usd') return 'usda';
  if (ext === '.usdz') return 'usdz';
  return null;
}

const USD_TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.exr', '.hdr']);
const USDZ_TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.exr']);

async function exists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

/** PMX texture paths use backslashes and sometimes wrong case or stray whitespace. */
async function resolveTexture(pmxDir, raw) {
  const rel = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel) return null;
  const direct = path.resolve(pmxDir, rel);
  if (await exists(direct)) return direct;
  // case-insensitive walk (matters on case-sensitive filesystems)
  let dir = pmxDir;
  for (const part of rel.split('/')) {
    if (part === '..') { dir = path.dirname(dir); continue; }
    if (part === '.' || !part) continue;
    let entries;
    try { entries = await fs.readdir(dir); } catch { return null; }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    dir = path.join(dir, hit);
  }
  return (await exists(dir)) ? dir : null;
}

/**
 * @param {string} inputPath .pmx file
 * @param {string} outputPath .fbx / .usda / .usd / .usdz file
 * @param {object} options see DEFAULT_CONVERT_OPTIONS
 * @returns {Promise<{output:string, format:string, stats:object, warnings:string[], textures:object[]}>}
 */
export async function convertPmxFile(inputPath, outputPath, options = {}) {
  const opt = { ...DEFAULT_CONVERT_OPTIONS, ...options };
  const format = opt.format || formatFromPath(outputPath);
  if (!format || !OUTPUT_FORMATS[format]) throw new Error(t`지원하지 않는 출력 형식입니다: ${outputPath}`);
  inputPath = path.resolve(inputPath);
  outputPath = path.resolve(outputPath);
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) throw new Error(t('입력 파일과 출력 파일이 같습니다.'));

  const pmx = parsePmx(await fs.readFile(inputPath));
  const scene = buildScene(pmx, opt);
  if (!scene.name || scene.name === 'Model') scene.name = path.basename(inputPath, path.extname(inputPath));
  const warnings = scene.warnings;

  const pmxDir = path.dirname(inputPath);
  const outDir = path.dirname(outputPath);
  const outBase = path.basename(outputPath, path.extname(outputPath));
  await fs.mkdir(outDir, { recursive: true });

  // ---- textures ----
  const isUsd = format !== 'fbx';
  const texDirName = `${outBase}_textures`;
  const textureMap = new Map();
  const usedNames = new Set();
  const report = [];
  const usdzFiles = [];
  for (const raw of scene.textures) {
    const source = await resolveTexture(pmxDir, raw);
    if (!source) {
      warnings.push(t`텍스처를 찾을 수 없습니다: ${raw}`);
      report.push({ source: raw, status: 'missing' });
      continue;
    }
    const ext = path.extname(source).toLowerCase();
    const allowed = format === 'usdz' ? USDZ_TEXTURE_EXT : USD_TEXTURE_EXT;
    if (isUsd && !allowed.has(ext)) {
      warnings.push(t`${format.toUpperCase()}에서 표시되지 않을 수 있는 텍스처 형식입니다 (${ext}): ${raw}`);
    }
    const data = await fs.readFile(source);
    const hasAlpha = textureUsesAlpha(data, ext);
    let fileName = path.basename(source);
    for (let k = 2; usedNames.has(fileName.toLowerCase()); k++) {
      fileName = `${path.basename(source, path.extname(source))}_${k}${path.extname(source)}`;
    }
    usedNames.add(fileName.toLowerCase());

    let absolute = source;
    let relative;
    if (format === 'usdz') {
      relative = `textures/${fileName}`;
      usdzFiles.push({ name: relative, data });
    } else if (opt.copyTextures) {
      absolute = path.join(outDir, texDirName, fileName);
      relative = `${texDirName}/${fileName}`;
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      if (absolute.toLowerCase() !== source.toLowerCase()) await fs.writeFile(absolute, data);
    } else {
      relative = path.relative(outDir, source).replace(/\\/g, '/');
    }
    const entry = {
      name: path.basename(fileName, path.extname(fileName)),
      absolute,
      relative: isUsd && !relative.startsWith('.') && !path.isAbsolute(relative) ? `./${relative}` : relative,
      hasAlpha,
    };
    if (format === 'usdz') entry.relative = relative;
    textureMap.set(raw, entry);
    report.push({ source: raw, status: 'ok', output: relative, hasAlpha });
  }

  // ---- write ----
  if (format === 'fbx') {
    await fs.writeFile(outputPath, writeFbx(scene, textureMap, { fileName: outputPath }));
  } else {
    const usda = writeUsda(scene, textureMap, { asciiNames: opt.asciiNames });
    if (format === 'usdz') {
      await fs.writeFile(outputPath, packUsdz([{ name: `${asciiName(outBase)}.usda`, data: Buffer.from(usda, 'utf8') }, ...usdzFiles]));
    } else {
      await fs.writeFile(outputPath, usda, 'utf8');
    }
  }

  return {
    input: inputPath,
    output: outputPath,
    format,
    size: (await fs.stat(outputPath)).size,
    stats: {
      vertices: scene.vertexCount,
      triangles: scene.triangleCount,
      materials: scene.materials.length,
      bones: scene.bones.length,
      morphs: scene.morphs.length,
      textures: report.filter((t) => t.status === 'ok').length,
      missingTextures: report.filter((t) => t.status === 'missing').length,
    },
    textures: report,
    warnings,
  };
}

function asciiName(s) {
  const out = s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return /[A-Za-z0-9]/.test(out) ? out : 'model';
}

/** Read-only summary used by the viewer's info panel and the CLI `info` command. */
export async function inspectPmxFile(inputPath) {
  const pmx = parsePmx(await fs.readFile(inputPath));
  return {
    name: pmx.name, nameEn: pmx.nameEn, comment: pmx.comment, version: pmx.version, encoding: pmx.encoding,
    vertices: pmx.vertexCount, triangles: pmx.indices.length / 3, materials: pmx.materials.length,
    textures: pmx.textures.length, bones: pmx.bones.length, morphs: pmx.morphs.length,
    rigidBodies: pmx.rigidBodyCount, joints: pmx.jointCount, warnings: pmx.warnings,
  };
}
