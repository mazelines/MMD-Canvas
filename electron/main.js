import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Menu } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertPmxFile, OUTPUT_FORMATS } from '../src/core/convert.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Test hooks: MMDCONV_OPEN=<file> opens a model at startup, MMDCONV_SHOT=<png> saves a screenshot and quits.
const OPEN_AT_START = process.env.MMDCONV_OPEN || process.argv.slice(1).find((a) => /\.[a-z0-9]{2,5}$/i.test(a) && !a.startsWith('-') && !a.endsWith('.js')) || null;
const SHOT_PATH = process.env.MMDCONV_SHOT || null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#16181d',
    title: 'MMD Converter',
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://ui/renderer/index.html');
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

app.whenReady().then(() => {
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

handle('app:startup', async () => ({
  home: app.getPath('documents'),
  openFile: OPEN_AT_START ? path.resolve(OPEN_AT_START) : null,
  formats: OUTPUT_FORMATS,
  testShadow: process.env.MMDCONV_SHADOW || null,
  testGizmo: process.env.MMDCONV_GIZMO || null,
  testConvert: process.env.MMDCONV_TEST_CONVERT ? { output: process.env.MMDCONV_TEST_CONVERT, format: path.extname(process.env.MMDCONV_TEST_CONVERT).slice(1).toLowerCase() } : null,
}));

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
      { name: '3D 모델', extensions: ['pmx', 'fbx', 'glb', 'gltf', 'obj', 'stl', 'ply', 'dae', '3mf', 'usdz', 'usda', 'usd', 'usdc'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
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
  const dom = await win.webContents.executeJavaScript("document.getElementById('convert-result').hidden ? '' : document.getElementById('convert-result').innerText");
  if (dom) console.log('[convert-result]', dom);
  if (process.env.MMDCONV_KEYS) { // e.g. "KeyW": send key presses to the page before the screenshot
    for (const code of process.env.MMDCONV_KEYS.split(',')) {
      await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { code: ${JSON.stringify(code)} })); window.__viewer.lightControls.mode + "/" + window.__viewer.lightControls.space`).then((m) => console.log('[key]', code, '->', m));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (process.env.MMDCONV_BENCH) {
    const bench = await win.webContents.executeJavaScript('JSON.stringify(window.__viewer.benchmark(30))');
    console.log('[bench]', bench);
    await new Promise((r) => setTimeout(r, 500));
  }
  const image = await win.webContents.capturePage();
  await fs.writeFile(SHOT_PATH, image.toPNG());
  console.log('[shot]', SHOT_PATH);
  app.quit();
});
void os;
