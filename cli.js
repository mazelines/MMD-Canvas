#!/usr/bin/env node
// Command line converter:  node cli.js <input.pmx | folder> [-o output] [-f fbx|usda|usdz] [options]

import fs from 'node:fs/promises';
import path from 'node:path';
import { convertPmxFile, inspectPmxFile, OUTPUT_FORMATS } from './src/core/convert.js';

const HELP = `MMD Converter - PMX -> FBX / USD

사용법:
  node cli.js <input.pmx>            [-o out.fbx|out.usda|out.usdz] [옵션]
  node cli.js <폴더>                 [-o 출력폴더] [-f fbx|usda|usdz] [-r] [옵션]
  node cli.js info <input.pmx>

옵션:
  -o, --out <경로>       출력 파일(단일) 또는 출력 폴더(일괄)
  -f, --format <형식>    fbx (기본) | usda | usdz
  -s, --scale <배율>     스케일 (기본 8 = 1 MMD 단위를 8cm로, 출력 단위 cm)
  -n, --names <모드>     original (기본) | english  (본/재질/모프 이름)
      --no-morphs        모프(블렌드셰이프) 제외
      --no-copy-textures 텍스처를 복사하지 않고 원본 경로 참조
      --ascii            USD prim 이름을 ASCII로 강제
  -r, --recursive        폴더 일괄 변환 시 하위 폴더 포함
`;

function parseArgs(argv) {
  const a = { inputs: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${t} 옵션에 값이 필요합니다.`);
      return argv[++i];
    };
    if (t === '-o' || t === '--out') a.out = next();
    else if (t === '-f' || t === '--format') a.format = next().toLowerCase();
    else if (t === '-s' || t === '--scale') a.options.scale = Number(next());
    else if (t === '-n' || t === '--names') a.options.nameMode = next();
    else if (t === '--no-morphs') a.options.morphs = false;
    else if (t === '--no-copy-textures') a.options.copyTextures = false;
    else if (t === '--ascii') a.options.asciiNames = true;
    else if (t === '-r' || t === '--recursive') a.recursive = true;
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t.startsWith('-')) throw new Error(`알 수 없는 옵션: ${t}`);
    else a.inputs.push(t);
  }
  return a;
}

async function findPmx(dir, recursive) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) out.push(...await findPmx(p, true)); }
    else if (e.name.toLowerCase().endsWith('.pmx')) out.push(p);
  }
  return out;
}

function printResult(r) {
  const s = r.stats;
  console.log(`✔ ${r.output}  (${(r.size / 1024).toFixed(0)} KB)`);
  console.log(`   정점 ${s.vertices} / 삼각형 ${s.triangles} / 재질 ${s.materials} / 본 ${s.bones} / 모프 ${s.morphs} / 텍스처 ${s.textures}` +
    (s.missingTextures ? ` (누락 ${s.missingTextures})` : ''));
  for (const w of r.warnings) console.log(`   ⚠ ${w}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.inputs.length) { console.log(HELP); return args.help ? 0 : 1; }

  if (args.inputs[0] === 'info') {
    if (!args.inputs[1]) throw new Error('info 명령에는 PMX 파일 경로가 필요합니다.');
    console.log(JSON.stringify(await inspectPmxFile(args.inputs[1]), null, 2));
    return 0;
  }
  if (args.format && !OUTPUT_FORMATS[args.format]) throw new Error(`알 수 없는 형식: ${args.format}`);
  if (args.options.scale !== undefined && !(args.options.scale > 0)) throw new Error('scale은 0보다 큰 숫자여야 합니다.');
  if (args.options.nameMode && !['original', 'english'].includes(args.options.nameMode)) throw new Error('names는 original 또는 english여야 합니다.');

  const input = path.resolve(args.inputs[0]);
  const stat = await fs.stat(input);
  let failed = 0;

  if (stat.isDirectory()) {
    const format = args.format || 'fbx';
    const files = await findPmx(input, args.recursive);
    if (!files.length) { console.log('PMX 파일을 찾지 못했습니다.'); return 1; }
    const outRoot = args.out ? path.resolve(args.out) : null;
    for (const file of files) {
      const rel = path.relative(input, file);
      const target = path.join(outRoot ? path.join(outRoot, path.dirname(rel)) : path.dirname(file),
        path.basename(file, path.extname(file)) + OUTPUT_FORMATS[format].ext);
      try { printResult(await convertPmxFile(file, target, { ...args.options, format })); }
      catch (e) { failed++; console.error(`✘ ${file}\n   ${e.message}`); }
    }
    console.log(`\n${files.length - failed}/${files.length}개 변환 완료`);
  } else {
    const format = args.format || 'fbx';
    const out = args.out || path.join(path.dirname(input), path.basename(input, path.extname(input)) + OUTPUT_FORMATS[format].ext);
    printResult(await convertPmxFile(input, out, { ...args.options, format: args.format }));
  }
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`오류: ${e.message}`); process.exitCode = 1; });
