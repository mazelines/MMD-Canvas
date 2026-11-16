// First launch opens the bundled example once; later launches restore the last workspace the user opened.
// A window reload stands in for an app restart: localStorage persists, the renderer starts over.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-first-run-')));
process.env.MMDCONV_LOCALE = 'ko-KR';
process.env.MMDCONV_SESSION = '1';
delete process.env.MMDCONV_OPEN;
delete process.env.MMDCONV_SHOT;
const root = path.resolve(__dirname, '..');
const example = path.join(root, 'Example', 'Zhuang Fangyi', 'Zhuang Fangyi.canvas');
const errors = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [example] });
const timeout = setTimeout(() => { console.error('First run timed out', errors); app.exit(1); }, 180000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 3) errors.push(event.message);
  });
  win.webContents.once('did-finish-load', async () => {
    const run = code => win.webContents.executeJavaScript(code);
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 60000;
      while (!await predicate().catch(() => false)) {
        if (errors.length) throw new Error(errors.join('\n'));
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    const restart = async () => {
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      win.webContents.reload();
      await loaded;
    };
    const opened = () => run('document.getElementById("workspace-name").textContent === "Zhuang Fangyi.canvas" && window.__viewer.current?.kind === "pmx" && !document.getElementById("workspace-open").disabled');
    const empty = () => run('!!window.__viewer && !!document.getElementById("path-input").value && !window.__viewer.current && !document.getElementById("workspace-open").disabled');
    try {
      await wait(opened, 'example on first launch');
      assert.equal(await run('localStorage.getItem("lastWorkspace")'), null);

      await restart();
      await wait(empty, 'second launch starts empty');
      await new Promise(resolve => setTimeout(resolve, 1000));
      assert.equal(await run('window.__viewer.current'), null);
      assert.equal(await run('document.getElementById("workspace-name").textContent'), '저장되지 않은 작업');

      await run('document.getElementById("workspace-open").click()');
      await wait(opened, 'workspace opened by the user');
      assert.equal(await run('localStorage.getItem("lastWorkspace")'), example);

      await restart();
      await wait(opened, 'last workspace restored');
      assert.deepEqual(errors, []);
      console.log('First run passed: example once, empty second launch, last workspace restored');
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
