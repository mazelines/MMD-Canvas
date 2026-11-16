// npm test first; MMDCONV_APP_ROOT=<app.asar> tests the packaged app.
// Only the OS file picker is stubbed: renderer, preload, IPC and loaders are real.
const { app, dialog, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-open-file-')));
process.env.MMDCONV_LOCALE = 'ko-KR';
delete process.env.MMDCONV_OPEN;
delete process.env.MMDCONV_SHOT;
const root = path.resolve(process.env.MMDCONV_APP_ROOT || path.join(__dirname, '..'));
const errors = [];
let selected = null, calls = 0;
dialog.showOpenDialog = async (_win, options) => {
  assert.deepEqual(options.properties, ['openFile']);
  calls++;
  return { canceled: !selected, filePaths: selected ? [selected] : [] };
};
const timeout = setTimeout(() => { console.error('File open timed out', errors); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 3) errors.push(event.message);
  });
  win.webContents.once('did-finish-load', async () => {
    const run = code => win.webContents.executeJavaScript(code);
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 10000;
      while (!await predicate()) {
        if (errors.length) throw new Error(errors.join('\n'));
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    try {
      await wait(() => run('!!window.__viewer && !!document.getElementById("path-input").value'), 'startup');
      await run('document.getElementById("btn-open").click()');
      await wait(() => calls === 1, 'cancel picker');
      assert.equal(await run('window.__viewer.current'), null);

      selected = path.resolve(__dirname, 'sample/complex.pmx');
      await run('document.getElementById("btn-open").click()');
      await wait(() => run('window.__viewer.current?.kind === "pmx" && !document.getElementById("btn-convert").disabled'), 'PMX via toolbar');
      assert.equal(calls, 2);

      selected = path.resolve(__dirname, 'out/complex.fbx');
      const openItem = Menu.getApplicationMenu().items[0].submenu.items[0];
      openItem.click(openItem, win);
      await wait(() => run('window.__viewer.current?.info.format === "FBX" && document.getElementById("loading").hidden'), 'FBX via menu');
      assert.equal(calls, 3);

      selected = null;
      await run('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyO", key: "o", ctrlKey: true, bubbles: true }))');
      await wait(() => calls === 4, 'Ctrl+O');
      assert.equal(await run('window.__viewer.current.info.format'), 'FBX');
      assert.deepEqual(errors, []);
      console.log(`File open passed: cancel, toolbar PMX, menu FBX, Ctrl+O (${root})`);
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error, errors);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
import(pathToFileURL(path.join(root, 'electron/main.js')).href).catch(error => {
  console.error(error); app.exit(1);
});
