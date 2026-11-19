import { t, setLanguage } from '../src/i18n/index.js';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Menu } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertPmxFile, OUTPUT_FORMATS } from '../src/core/convert.js';
import { readWorkspace, writeWorkspace, networkPaths } from '../src/core/workspace.js';
import { Dx12Host } from './dx12.js';
import { compileShaderStack } from './shader-compiler.js';
import { libraryStride } from '../src/core/shader-stack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Three.js supplies scene/loader data only; browser 3D rendering is disabled.
app.commandLine.appendSwitch('disable-webgl');

// Test hooks: MMDCONV_OPEN=<file> opens a model at startup, MMDCONV_SHOT=<png> saves a screenshot and quits.
const fileFromArgv = (argv) => argv.slice(1).find((a) => /\.(canvas|[a-z0-9]{2,5})$/i.test(a) && !a.startsWith('-') && !/\.(cjs|mjs|js)$/i.test(a)) || null;
const OPEN_AT_START = process.env.MMDCONV_OPEN || fileFromArgv(process.argv);
let pendingOpenFile = OPEN_AT_START, rendererReady = false;
const SHOT_PATH = process.env.MMDCONV_SHOT || null;
// Bundled sample, shipped beside the executable (electron-builder extraFiles) and opened on the first launch.
const EXAMPLE_WORKSPACE = path.join(app.isPackaged ? path.resolve(process.resourcesPath, '..') : ROOT, 'Example', 'Zhuang Fangyi', 'Zhuang Fangyi.canvas');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let shaderWin = null;
const dx12 = new Dx12Host(ROOT, () => win);
// Independent second host renders the material preview in the shader editor window.
const previewDx12 = new Dx12Host(ROOT, () => shaderWin);
app.on('before-quit', () => { dx12.stop(); previewDx12.stop(); });
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') dx12.logPresentation('gpu-process-exit', { reason: details.reason, exitCode: details.exitCode });
});
// Route presentation acks by sender: each host's presented() filters to its own window.
ipcMain.on('dx12:presented', (event, id, error) => { dx12.presented(event.sender, id, error); previewDx12.presented(event.sender, id, error); });
// Display language the user chose in the OS (the system locale is only the regional format on Windows).
const systemLanguage = () => process.env.MMDCONV_LOCALE || app.getPreferredSystemLanguages?.()[0] || app.getSystemLocale();
// One window per user: opening another file (e.g. double-clicking a .canvas) reuses the running app.
// Automated runs (any MMDCONV_* variable) stay independent so they never hand off to an open app.
const isTestRun = Object.keys(process.env).some((key) => key.startsWith('MMDCONV_'));
const hasInstanceLock = isTestRun || app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', (_event, argv, workingDirectory) => {
  const file = fileFromArgv(argv);
  if (file) {
    const filePath = path.resolve(workingDirectory, file);
    if (rendererReady && win) win.webContents.send('app:open-file', filePath);
    else pendingOpenFile = filePath;
  }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (rendererReady && win) win.webContents.send('app:open-file', filePath);
  else pendingOpenFile = filePath;
});

/**
 * Application menu. The renderer owns the actions, their state and their keyboard shortcuts:
 * accelerators are shown but not registered (registering them too would run each action twice),
 * and checked states are pushed from the renderer through 'menu:state'.
 */
function buildMenu() {
  const send = (command) => () => win?.webContents.send('menu:command', command);
  const item = (label, command, accelerator) => ({ label, accelerator, registerAccelerator: false, click: send(command) });
  const check = (label, id) => ({ id, label, type: 'checkbox', click: send(`toggle:${id}`) });
  const mode = (label, name) => ({ id: `mode-${name}`, label, type: 'radio', checked: name === 'lambert', click: send(`mode:${name}`) });
  return Menu.buildFromTemplate([
    {
      label: t('파일'),
      submenu: [
        item(t('파일 열기…'), 'open-file', 'CmdOrCtrl+O'),
        item(t('워크스페이스 열기…'), 'workspace-open', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        item(t('워크스페이스 저장'), 'workspace-save', 'CmdOrCtrl+S'),
        item(t('다른 이름으로 저장…'), 'workspace-save-as', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        { label: t('끝내기'), role: 'quit' },
      ],
    },
    {
      label: t('변환'),
      submenu: [
        item(t('현재 PMX 변환…'), 'convert', 'CmdOrCtrl+E'),
        item(t('폴더 일괄 변환…'), 'batch'),
      ],
    },
    {
      label: t('보기'),
      submenu: [
        item(t('맞춰 보기'), 'frame', 'F'),
        { type: 'separator' },
        check(t('그리드'), 'flag-grid'),
        check(t('본'), 'flag-skeleton'),
        check(t('와이어프레임'), 'flag-wireframe'),
        { type: 'separator' },
        check(t('그림자'), 'flag-shadow'),
        check(t('광원 기즈모'), 'flag-light-gizmo'),
        item(t('광원 방향 초기화'), 'light-reset'),
        { type: 'separator' },
        { id: 'shader-stack-editor', label: t('셰이더 스택 편집기…'), accelerator: 'CmdOrCtrl+Shift+K', click: () => openShaderWindow() },
        { type: 'separator' },
        { label: t('새로 고침'), accelerator: 'F5', registerAccelerator: false, click: () => win?.webContents.reload() },
        { label: t('개발자 도구'), accelerator: 'F12', registerAccelerator: false, click: () => win?.webContents.toggleDevTools() },
      ],
    },
    {
      label: t('도움말'),
      submenu: [{
        label: t('MMD Canvas 정보'),
        click: () => dialog.showMessageBox(win, { type: 'info', title: t('MMD Canvas 정보'), message: 'MMD Canvas', detail: t`버전 ${app.getVersion()}` + '\n\nNVIDIA RTX™ DLSS / NVIDIA NGX SDK\nCopyright © NVIDIA Corporation. All rights reserved.\nNVIDIA SDK license: licenses/NVIDIA-DLSS.txt' }),
      }],
    },
  ]);
}

ipcMain.on('menu:state', (_event, state) => {
  const menu = Menu.getApplicationMenu();
  if (!menu || !state) return;
  for (const [id, checked] of Object.entries(state)) {
    const entry = menu.getMenuItemById(id);
    if (!entry) continue;
    // a radio item is only ever selected; its siblings clear themselves
    if (entry.type === 'radio') { if (checked) entry.checked = true; } else entry.checked = !!checked;
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#16181d',
    title: 'MMD Canvas',
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // sharedTexture's renderer API is exposed only through the narrow preload bridge.
    },
  });
  Menu.setApplicationMenu(buildMenu());
  win.loadURL('app://ui/renderer/index.html');
  if (process.env.MMDCONV_SHADER_EDITOR) win.webContents.once('did-finish-load', () => openShaderWindow());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F5') win.webContents.reload();
  });
  if (SHOT_PATH || process.env.MMDCONV_LOG) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  }
  win.on('closed', () => { win = null; });
}

// ---------------- shader stack editor window ----------------
// Main process owns a library of shader stacks and a per-material assignment.
// stackId = library index + 1; 0 = base shading. The editor queries/updates it;
// the main viewport renders per-material, the preview shows the selected stack.
// Built-in standard stacks. Default Toon reproduces the MMD toon look (2-band
// hard step + flat fill) as a stack layer on the neutral Lambert base, with the
// hull outline enabled; Standard is the plain Lambert base. Users can edit/add.
const BUILTIN_STACKS = [
  { name: 'Default Toon', outline: true, layers: [{ id: 'toon', name: 'DefaultToon', enabled: true, code:
`//@property float shadowFloor = 0.251 [0,1] "그림자 바닥"
void DefaultToon(inout ShadingContext ctx) {
    float band = ctx.ndl < 0 ? shadowFloor : 1.0;
    float toonDirect = lerp(shadowFloor, band, ctx.shade);
    ctx.color += ctx.albedo * (toonDirect - ctx.direct) * ctx.sunLux / 3.141592653589793;
    float3 flatFill = lerp(ctx.groundColor, ctx.skyColor, 0.5) * ctx.ambientLux;
    ctx.color += ctx.albedo * (flatFill - ctx.fill) * ctx.ao / 3.141592653589793;
}` }] },
  { name: 'Standard', outline: false, layers: [] },
];
let shaderLibrary = BUILTIN_STACKS.map(s => ({ ...s, layers: s.layers.map(l => ({ ...l })) }));
let materialInstances = []; // panel material index -> { stackId, params:{layerId:{propName:value}} }
let materialNames = [];     // display names pushed by the main window
let previewMaterial = 0;    // material whose stack the editor preview sphere shows
let stackCache = new Map(); // stackId -> { color, aa }
let stride = 1;             // per-material userParams stride (max stack slot count)
const previewStackId = () => materialInstances[previewMaterial]?.stackId || 0;
function openShaderWindow() {
  if (shaderWin && !shaderWin.isDestroyed()) { shaderWin.focus(); return; }
  shaderWin = new BrowserWindow({
    width: 1200, height: 820, minWidth: 860, minHeight: 560,
    backgroundColor: '#16181d', title: t('셰이더 스택'), show: true,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  shaderWin.loadURL('app://ui/renderer/shader-stack.html');
  shaderWin.on('closed', () => { previewDx12.stop(); shaderWin = null; });
}
function shaderState() { return { library: shaderLibrary, instances: materialInstances, materialNames, stride, previewMaterial }; }
function notifyShaderApplied() {
  // Direct render kick: reliable across the multi-window setup where the IPC
  // event alone may not restart a converged flush. Kick both viewports.
  for (const w of [win, shaderWin]) {
    if (!w || w.isDestroyed()) continue;
    w.webContents.send('shader-stack:applied', shaderState());
    w.webContents.executeJavaScript('window.__shaderStackRender && window.__shaderStackRender()').catch(() => {});
  }
}
function broadcastShaderUpdated() {
  if (shaderWin && !shaderWin.isDestroyed()) shaderWin.webContents.send('shader-stack:updated', shaderState());
  if (win && !win.isDestroyed()) win.webContents.send('shader-stack:updated', shaderState());
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  if (process.platform !== 'win32' || Number(os.release().split('.')[2]) < 22000) {
    dialog.showErrorBox('MMD Canvas', 'Windows 11 x64 이상이 필요합니다.'); app.quit(); return;
  }
  setLanguage(systemLanguage());
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let filePath;
      if (url.host === 'ui') {
        filePath = path.join(ROOT, decodeURIComponent(url.pathname));
        if (!filePath.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
      } else if (url.host === 'fs') {
        filePath = path.normalize(decodeURIComponent(url.pathname.slice(1)));
      } else {
        return new Response('not found', { status: 404 });
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (e) {
      return new Response(String(e.message || e), { status: 404 });
    }
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---------------- IPC ----------------
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
// Route DX12 calls to the preview host when they come from the editor window,
// otherwise to the main host. The editor's Dx12Viewport uses the same api.dx12*.
const hostFor = (e) => (shaderWin && !shaderWin.isDestroyed() && e.sender === shaderWin.webContents) ? previewDx12 : dx12;
const handleHost = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
  try { return { ok: true, value: await fn(hostFor(e), ...args) }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});
handleHost('dx12:start', async (host) => {
  const caps = await host.start();
  // Apply any library restored before the renderer was ready (both hosts).
  try { await loadShaderLibrary(); notifyShaderApplied(); } catch { /* best-effort */ }
  return caps;
});
handleHost('dx12:model', (host, data) => host.model(data));
handleHost('dx12:pose', (host, data) => host.pose(data));
handleHost('dx12:render', (host, data) => host.render(data));
handleHost('dx12:shader', async (host, layers) => {
  if (!layers || !layers.length) return host.shader(null);
  const blobs = await compileShaderStack(layers, libraryStride([{ layers }]));
  return host.shader(blobs.color, blobs.aa);
});
handleHost('dx12:params', (host, data) => host.setParams(data));
handleHost('dx12:matstacks', (host, stackIds) => host.materialStacks(stackIds));
handleHost('dx12:stop', (host) => host.stop());

// Shader stack editor window: main owns the state, compiles, hot-swap, and
// notifies the main viewport to re-render. The host mutex serializes shader loads
// against renders; parameter uploads are fire-and-forget.
handle('shader-stack:library-get', () => shaderState());
// Compile every library stack at the shared per-material stride, then fan out:
// the main host gets the whole library (opcode 8, with outline flags); the preview
// host gets the selected material's stack as its base shader (opcode 6). Per-material
// parameter values are packed and uploaded by the renderer (nativeModel/flush).
async function compileLibrary() {
  stride = libraryStride(shaderLibrary);
  const cache = new Map();
  for (let i = 0; i < shaderLibrary.length; i++) {
    const blobs = await compileShaderStack(shaderLibrary[i].layers || [], stride);
    cache.set(i + 1, blobs);
  }
  stackCache = cache;
}
async function loadShaderLibrary() {
  const hosts = [dx12, previewDx12].filter(h => h.child && h.capabilities);
  if (!hosts.length) return;
  await compileLibrary();
  const stacks = [...stackCache].map(([stackId, b]) => ({ stackId, outline: shaderLibrary[stackId - 1]?.outline ? 1 : 0, color: b.color, aa: b.aa }));
  for (const host of hosts) {
    if (host === previewDx12) {
      const sel = stackCache.get(previewStackId());
      await host.shader(sel ? sel.color : null, sel ? sel.aa : null);
    } else {
      await host.shaderLibrary(stacks);
    }
  }
}
// Best-effort load: store state first so a workspace restore persists even if the
// renderer is not ready; the load itself must not abort the caller.
async function applyLibrary() {
  let loadError = null;
  try { await loadShaderLibrary(); } catch (e) { loadError = e.message || String(e); }
  notifyShaderApplied();
  return loadError;
}
ipcMain.handle('shader-stack:library-set', async (_e, library) => {
  shaderLibrary = Array.isArray(library) ? library : [];
  for (const inst of materialInstances) if (inst.stackId > shaderLibrary.length) inst.stackId = 0;
  const err = await applyLibrary(); broadcastShaderUpdated();
  return err ? { ok: false, error: err } : { ok: true, value: shaderState() };
});
ipcMain.handle('shader-stack:restore', async (_e, { library, instances }) => {
  if (Array.isArray(library) && library.length) shaderLibrary = library;
  materialInstances = Array.isArray(instances) ? instances.map(i => ({ stackId: (i?.stackId >= 1 && i.stackId <= shaderLibrary.length) ? i.stackId : 1, params: i?.params || {} })) : [];
  const err = await applyLibrary(); broadcastShaderUpdated();
  return err ? { ok: false, error: err } : { ok: true, value: shaderState() };
});
ipcMain.handle('shader-stack:stack-apply', async (_e, { stackId, layers, outline }) => {
  const idx = stackId - 1;
  if (idx < 0 || idx >= shaderLibrary.length) return { ok: false, error: 'Invalid stackId' };
  shaderLibrary[idx].layers = Array.isArray(layers) ? layers : [];
  if (outline !== undefined) shaderLibrary[idx].outline = !!outline;
  const err = await applyLibrary(); broadcastShaderUpdated();
  return err ? { ok: false, error: err } : { ok: true, value: shaderState() };
});
// Per-material instance property values (Unity-style material instances). The
// renderer re-packs userParams on the next flush; no recompile needed.
handle('shader-stack:instance-params', ({ materialIndex, values }) => {
  const inst = materialInstances[materialIndex];
  if (!inst) return { ok: false, error: 'Invalid material' };
  inst.params = { ...(inst.params || {}), ...(values || {}) };
  broadcastShaderUpdated(); notifyShaderApplied();
  return { ok: true };
});
handle('shader-stack:assign', ({ materialIndex, stackId }) => {
  if (materialIndex >= 0) materialInstances[materialIndex] = { stackId, params: materialInstances[materialIndex]?.params || {} };
  broadcastShaderUpdated(); notifyShaderApplied();
  return { ok: true, value: shaderState() };
});
handle('shader-stack:preview', async (materialIndex) => {
  previewMaterial = materialIndex;
  if (previewDx12.child && previewDx12.capabilities) {
    const sel = stackCache.get(previewStackId());
    try { await previewDx12.shader(sel ? sel.color : null, sel ? sel.aa : null); } catch { /* best-effort */ }
  }
  notifyShaderApplied();
  return { ok: true };
});
handle('shader-stack:materials', (names) => {
  materialNames = Array.isArray(names) ? names : [];
  while (materialInstances.length < materialNames.length) materialInstances.push({ stackId: 1, params: {} });
  broadcastShaderUpdated();
  return { ok: true };
});

handle('app:startup', async () => {
  rendererReady = true;
  return {
  home: app.getPath('documents'),
  locale: systemLanguage(),
  openFile: pendingOpenFile ? path.resolve(pendingOpenFile) : null,
  // First-launch example / last-workspace restore. Automated runs start empty unless MMDCONV_SESSION asks for it.
  session: isTestRun && !process.env.MMDCONV_SESSION ? null
    : { example: await fs.access(EXAMPLE_WORKSPACE).then(() => EXAMPLE_WORKSPACE, () => null) },
  formats: OUTPUT_FORMATS,
  testShadow: process.env.MMDCONV_SHADOW || null,
  testGizmo: process.env.MMDCONV_GIZMO || null,
  testConvert: process.env.MMDCONV_TEST_CONVERT ? { output: process.env.MMDCONV_TEST_CONVERT, format: path.extname(process.env.MMDCONV_TEST_CONVERT).slice(1).toLowerCase() } : null,
  };
});

handle('fs:list', async (dir) => {
  dir = path.resolve(dir);
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(dirents.map(async (d) => {
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    let size = 0, mtime = 0;
    try {
      const st = await fs.stat(full);
      isDir = st.isDirectory(); size = st.size; mtime = st.mtimeMs;
    } catch { if (!isDir) return null; }
    return { name: d.name, path: full, isDir, size, mtime, ext: isDir ? '' : path.extname(d.name).toLowerCase() };
  }));
  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? null : parent, entries: entries.filter(Boolean) };
});

handle('fs:drives', async () => {
  if (process.platform !== 'win32') return ['/'];
  const found = [];
  await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (l) => {
    try { await fs.access(`${l}:\\`); found.push(`${l}:\\`); } catch { /* no such drive */ }
  }));
  return found.sort();
});

handle('fs:stat', async (p) => {
  const st = await fs.stat(p);
  return { isDir: st.isDirectory(), size: st.size };
});

handle('dialog:pickFolder', async (defaultPath) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: defaultPath || undefined });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:openFile', async (defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    defaultPath: defaultPath || undefined,
    filters: [
      { name: t('모델 · 워크스페이스'), extensions: ['canvas', 'pmx', 'fbx', 'glb', 'gltf', 'obj', 'stl', 'ply', 'dae', '3mf', 'usdz', 'usda', 'usd', 'usdc'] },
      { name: t('3D 모델'), extensions: ['pmx', 'fbx', 'glb', 'gltf', 'obj', 'stl', 'ply', 'dae', '3mf', 'usdz', 'usda', 'usd', 'usdc'] },
      { name: t('모든 파일'), extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('workspace:open', async (filePath) => {
  if (!filePath) {
    const selected = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: t('MMD Canvas 워크스페이스'), extensions: ['canvas'] }] });
    if (selected.canceled) return null;
    filePath = selected.filePaths[0];
  }
  const data = await readWorkspace(filePath);
  const remote = networkPaths(data, path.resolve(filePath));
  if (remote.length) {
    const answer = await dialog.showMessageBox(win, {
      type: 'warning', buttons: [t('계속'), t('취소')], defaultId: 1, cancelId: 1, title: t('네트워크 경로 확인'),
      message: t`이 워크스페이스는 네트워크 위치의 파일을 참조합니다:\n${remote.join('\n')}\n\n신뢰하는 워크스페이스일 때만 계속하세요.`,
    });
    if (answer.response !== 0) return null;
  }
  if (data.model) {
    const stat = await fs.stat(data.model.path).catch(() => null);
    if (!stat?.isFile()) throw new Error(t`모델 파일을 찾을 수 없습니다: ${data.model.path}\n모델을 원래 위치로 복원한 뒤 다시 열어 주세요.`);
  }
  return { filePath: path.resolve(filePath), data };
});

handle('workspace:save', async (data, currentPath, saveAs) => {
  let filePath = currentPath;
  if (!filePath || saveAs) {
    const defaultPath = currentPath || (data.model?.path ? data.model.path.replace(/\.[^./\\]+$/, '') + '.canvas' : path.join(data.browser?.directory || app.getPath('documents'), 'Workspace.canvas'));
    const selected = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: t('MMD Canvas 워크스페이스'), extensions: ['canvas'] }] });
    if (selected.canceled || !selected.filePath) return null;
    filePath = selected.filePath;
    if (path.extname(filePath).toLowerCase() !== '.canvas') filePath += '.canvas';
  }
  return { filePath: await writeWorkspace(filePath, data) };
});

handle('dialog:saveFile', async (defaultPath, format) => {
  const f = OUTPUT_FORMATS[format];
  const r = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: f.label, extensions: [f.ext.slice(1)] }],
  });
  return r.canceled ? null : r.filePath;
});

handle('convert:file', async (input, output, options) => convertPmxFile(input, output, options));

async function findPmx(dir, recursive, out = []) {
  let dirents;
  try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (recursive) await findPmx(p, true, out); }
    else if (d.name.toLowerCase().endsWith('.pmx')) out.push(p);
  }
  return out;
}

handle('convert:batch', async (dir, outDir, format, recursive, options) => {
  const files = await findPmx(dir, recursive);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = path.relative(dir, file);
    const target = path.join(outDir ? path.join(outDir, path.dirname(rel)) : path.dirname(file),
      path.basename(file, path.extname(file)) + OUTPUT_FORMATS[format].ext);
    win?.webContents.send('convert:progress', { index: i, total: files.length, file });
    try { results.push({ ok: true, ...(await convertPmxFile(file, target, { ...options, format })) }); }
    catch (e) { results.push({ ok: false, input: file, error: e.message || String(e) }); }
  }
  return results;
});

handle('shell:reveal', async (p) => { shell.showItemInFolder(p); });

// ---------------- screenshot test hook ----------------
ipcMain.on('viewer:loaded', async (_e, info) => {
  if (!SHOT_PATH) return;
  console.log('[loaded]', JSON.stringify(info));
  await new Promise((r) => setTimeout(r, Number(process.env.MMDCONV_SHOT_DELAY || 1500)));
  const viewportState = await win.webContents.executeJavaScript(`JSON.stringify({workspace:document.getElementById('workspace-name').title,backend:document.getElementById('renderer-status').textContent,frame:window.__viewer?.dx12?.lastFrame?.id,error:document.getElementById('renderer-error').hidden?null:document.getElementById('renderer-error').innerText})`);
  console.log('[viewport]', viewportState);
  const dom = await win.webContents.executeJavaScript("document.getElementById('convert-result').hidden ? '' : document.getElementById('convert-result').innerText");
  if (dom) console.log('[convert-result]', dom);
  if (process.env.MMDCONV_KEYS) { // e.g. "KeyW": send key presses to the page before the screenshot
    for (const code of process.env.MMDCONV_KEYS.split(',')) {
      await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { code: ${JSON.stringify(code)} })); window.__viewer.lightControls.mode + "/" + window.__viewer.lightControls.space`).then((m) => console.log('[key]', code, '->', m));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (process.env.MMDCONV_BENCH) {
    const bench = await win.webContents.executeJavaScript('JSON.stringify(window.__viewer.benchmark())');
    console.log('[bench]', bench);
    await new Promise((r) => setTimeout(r, 500));
  }
  const image = await win.webContents.capturePage();
  await fs.writeFile(SHOT_PATH, image.toPNG());
  console.log('[shot]', SHOT_PATH);
  app.quit();
});
void os;
