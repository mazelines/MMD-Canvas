// Restore a valid user workspace, otherwise open the bundled example (including old profiles).
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
const profile=fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-first-run-'));
app.setPath('userData', profile);
process.env.MMDCONV_LOCALE = 'ko-KR';
process.env.MMDCONV_SESSION = '1';
delete process.env.MMDCONV_OPEN;
delete process.env.MMDCONV_SHOT;
const root = path.resolve(__dirname, '..');
const example = path.join(root, 'Example', 'Zhuang Fangyi', 'Zhuang Fangyi.canvas');
const userWorkspace=path.join(profile,'User.canvas');
const userData=JSON.parse(fs.readFileSync(example,'utf8'));userData.model.path=path.join(path.dirname(example),'Zhuang Fangyi.pmx');userData.browser.directory=path.dirname(example);
fs.writeFileSync(userWorkspace,JSON.stringify(userData));
const errors = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [userWorkspace] });
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
    const opened = () => run('document.getElementById("workspace-name").textContent === "Zhuang Fangyi.canvas" && window.__viewer.current?.kind === "pmx" && !document.getElementById("workspace-open").disabled && __viewer.dx12?.enabled && !__viewer.dx12.error && !__viewer.dx12.busy && __viewer.dx12.loadedKey.startsWith(__viewer.current.object.uuid)');
    const userOpened = () => run('document.getElementById("workspace-name").textContent === "User.canvas" && !!window.__viewer.current && !document.getElementById("workspace-open").disabled && __viewer.dx12?.enabled && !__viewer.dx12.error && !__viewer.dx12.busy && __viewer.dx12.loadedKey.startsWith(__viewer.current.object.uuid)');
    try {
      await wait(opened, 'example on first launch');
      assert.equal(await run('localStorage.getItem("lastWorkspace")'), null);

      await run('localStorage.setItem("firstRunDone","1")');
      await restart();
      await wait(opened, 'old first-run flag cannot suppress the example');
      await run('localStorage.setItem("lastWorkspace","C:/missing/old-project.canvas")');
      await restart();
      await wait(opened, 'missing previous workspace falls back to bundled project');

      await run('document.getElementById("workspace-open").click()');
      await wait(userOpened, 'workspace opened by the user');
      assert.equal(await run('localStorage.getItem("lastWorkspace")'), userWorkspace);

      await restart();
      await wait(userOpened, 'last workspace takes precedence over bundled project');
      assert.deepEqual(errors, []);
      console.log('First run passed: fresh profile, stale first-run flag, missing workspace fallback, user workspace restored');
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
