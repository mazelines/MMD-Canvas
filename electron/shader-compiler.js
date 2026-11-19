import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStack, injectDeclarations } from '../src/core/shader-stack.js';

// Repo root in dev (matches electron/main.js ROOT); app.asar when packaged.
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Compiles user-authored shader stacks into the character color pass at runtime.
// Electron main owns compilation (asar-aware fs gathers the HLSL sources; the
// bundled DXC redistributable compiles them). The native renderer only receives
// the resulting DXIL blobs and hot-swaps its color PSOs.
//
// A stack is an ordered list of layers: { name, code, enabled }. Each layer's
// code defines `void <name>(inout ShadingContext ctx)`. The generated shader is
// the standard viewport.hlsl with the user functions injected and runUserStack
// replaced by sequential calls, so the fixed base shading is unchanged and the
// build-time and runtime paths share a single source of truth.

const RUN_STACK = 'void runUserStack(inout ShadingContext ctx) { }';

export function generateStackSource(baseSource, layers, stride = 1) {
  const { layers: parsed } = parseStack(layers, 0);
  // Inject each active layer's property declarations (reading per-material
  // userParams slots: materialId*stride + localSlot), then call layers in order.
  const functions = parsed
    .map((l, i) => (l.enabled && l.name ? injectDeclarations(layers[i].code, l, stride) : null))
    .filter(Boolean).join('\n\n');
  const calls = parsed.filter(l => l.enabled && l.name).map(l => `    ${l.name}(ctx);`).join('\n');
  const body = `void runUserStack(inout ShadingContext ctx) {\n${calls}\n}`;
  const decl = 'StructuredBuffer<float4> userParams : register(t149);\n\n';
  if (!baseSource.includes(RUN_STACK)) throw new Error('viewport.hlsl에 runUserStack 삽입 지점이 없습니다.');
  return baseSource.replace(RUN_STACK, `${decl}${functions}\n\n${body}`);
}

function resolvePaths() {
  const sourceRoot = app.isPackaged ? app.getAppPath() : MODULE_ROOT;
  const hlslDir = path.join(sourceRoot, 'native/dx12');
  const cortaoDir = path.join(sourceRoot, 'renderer/vendor/cortao');
  const dxcDir = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'native/dx12')
    : path.join(MODULE_ROOT, 'out/dx12');
  return { hlslDir, cortaoDir, dxcDir };
}

function runDxc(dxcDir, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(dxcDir, 'dxc.exe'), args, { cwd, windowsHide: true });
    let stderr = '', stdout = '';
    child.stderr.on('data', b => { stderr += b; });
    child.stdout.on('data', b => { stdout += b; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `dxc exited (${code})`).trim()));
    });
  });
}

// Returns { color: Buffer, aa: Buffer } DXIL blobs for colorMain / aaColorMain.
// Throws with the compiler diagnostic on failure.
export async function compileShaderStack(layers, stride = 1) {
  const { hlslDir, cortaoDir, dxcDir } = resolvePaths();
  const dxc = path.join(dxcDir, 'dxc.exe');
  if (!fs.existsSync(dxc)) throw new Error('런타임 셰이더 컴파일러(dxc.exe)가 없습니다. npm run build:dx12로 빌드해 주세요.');
  const baseSource = fs.readFileSync(path.join(hlslDir, 'viewport.hlsl'), 'utf8');
  const generated = generateStackSource(baseSource, layers, stride);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-shader-'));
  try {
    // Extract the color pass's include graph to disk for DXC. Native HLSL at the
    // temp root; CORTAO headers in a subdir matched by the second -I.
    for (const name of fs.readdirSync(hlslDir)) {
      if (name.endsWith('.hlsl')) fs.writeFileSync(path.join(temp, name), fs.readFileSync(path.join(hlslDir, name)));
    }
    const cortaoTemp = path.join(temp, 'cortao');
    fs.mkdirSync(cortaoTemp, { recursive: true });
    for (const name of fs.readdirSync(cortaoDir)) {
      if (name.endsWith('.h')) fs.writeFileSync(path.join(cortaoTemp, name), fs.readFileSync(path.join(cortaoDir, name)));
    }
    fs.writeFileSync(path.join(temp, 'viewport.hlsl'), generated);

    const blobs = {};
    for (const [key, entry] of [['color', 'colorMain'], ['aa', 'aaColorMain']]) {
      const out = path.join(temp, `${entry}.cso`);
      await runDxc(dxcDir, ['-E', entry, '-T', 'ps_6_6', '-I', temp, '-I', cortaoTemp, '-Fo', out, path.join(temp, 'viewport.hlsl')], dxcDir);
      blobs[key] = fs.readFileSync(out);
    }
    return blobs;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
