// Windows 11 + DX12 Ultimate GPU. Faults affect only this test's Electron process.
const { app, sharedTexture } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mmd-presentation-')));
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag);
process.env.MMDCONV_OPEN = path.resolve('tests/sample/complex.pmx');
delete process.env.MMDCONV_DX12_VALIDATION;
delete process.env.MMDCONV_SHOT;
const importTexture = sharedTexture.importSharedTexture.bind(sharedTexture);
const diagnostics = [], warn = console.warn;
console.warn = (...args) => { if (args[0] === '[DX12 presentation]') diagnostics.push(args[1]); else warn(...args); };
let transientFailures = 3, permanentFailure = false, unavailable = false, imports = 0;
let delayReleases = false, delayed = 0, maxDelayed = 0;
sharedTexture.importSharedTexture = options => {
  imports++;
  if (permanentFailure) throw new Error('Injected unsupported shared texture');
  if (unavailable || transientFailures-- > 0) throw new Error('Failed to import shared texture: GPU is not available');
  return importTexture({ ...options, allReferencesReleased: () => {
    if (!delayReleases) { options.allReferencesReleased?.(); return; }
    delayed++; maxDelayed=Math.max(maxDelayed,delayed);
    setTimeout(() => { delayed--; options.allReferencesReleased?.(); }, 150);
  } });
};
const timeout = setTimeout(() => { console.error('DX12 presentation test timed out'); app.exit(1); }, 60000);
let gpuExits = 0;
app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU') gpuExits++; });
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const run = code => win.webContents.executeJavaScript(code);
    const wait = async (predicate, label) => {
      for (let i = 0; i < 500; i++) { if (await run(predicate)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('Timed out: ' + label + ' ' + await run('document.getElementById("renderer-status").textContent'));
    };
    try {
      await wait('__viewer?.current && __viewer.dx12?.lastFrame && !__viewer.dx12.busy', 'startup recovery');
      assert.ok(imports >= 4, 'Startup must recover after transient GPU unavailability');
      await run('__viewer.scene.background.setRGB(0,1,0); __viewer.requestRender()');
      await wait('!__viewer.dx12.busy', 'green background');
      await run('__viewer.dx12.enabled=false');
      const render = () => run('api.dx12Render(__viewer.dx12.frame())');
      const beforeSteadyFrames = gpuExits;
      for (let i=0; i<600; i++) await render();
      assert.equal(gpuExits, beforeSteadyFrames, 'Continuous frame presentation must not crash the GPU process');
      delayReleases = true;
      for (let i=0; i<20; i++) await render();
      delayReleases = false;
      assert.ok(maxDelayed>0 && maxDelayed<=3, `Producer must wait for consumers instead of exhausting the native pool (${maxDelayed})`);
      // More failures than the native 8-slot pool: failed imports must release
      // their slot, and non-transient failures must not spin in the retry loop.
      for (let i = 0; i < 12; i++) {
        permanentFailure = true;
        const before = imports;
        await assert.rejects(render, /Injected unsupported shared texture/);
        assert.equal(imports, before + 1);
        permanentFailure = false;
        await render();
      }
      unavailable = true;
      const started = Date.now();
      await assert.rejects(render, /GPU is not available/);
      assert.ok(Date.now() - started >= 4500 && Date.now() - started < 9000, 'GPU recovery must have a bounded timeout');
      unavailable = false;
      await run('document.getElementById("renderer-retry").click()');
      await wait('__viewer.dx12.enabled && !__viewer.dx12.busy && !__viewer.dx12.error', 'manual retry after timeout');
      const displayed = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const rect = await run('(()=>{const r=document.getElementById("canvas-host").getBoundingClientRect();return{x:Math.ceil(r.x+4),y:Math.ceil(r.y+4),width:Math.floor(r.width-8),height:Math.floor(r.height-8)}})()');
        const pixels = (await win.webContents.capturePage(rect)).toBitmap();
        let green = 0;
        for (let i=0; i<pixels.length; i+=4) if (pixels[i+1]>200 && pixels[i]<30 && pixels[i+2]<30) green++;
        assert.ok(green>10000, `Compositor must display the actual native frame (${green} green pixels)`);
      };
      await displayed();
      // Kill only this application's own GPU utility process. Chromium restarts
      // it; the DX12 renderer/device remains intact and must present another frame.
      await run('__viewer.dx12.enabled=false');
      const gpu = app.getAppMetrics().find(metric => metric.type === 'GPU');
      assert.ok(gpu?.pid, 'A hardware compositing process must exist');
      process.kill(gpu.pid);
      const result = await render();
      assert.equal(await run('Number(document.getElementById("dx12-canvas").dataset.frame)'), result.id);
      await run('window.__beforeRecoveryFrame=__viewer.dx12.lastFrame.id; __viewer.dx12.enabled=true; __viewer.requestRender()');
      await wait('__viewer.dx12.lastFrame.id>window.__beforeRecoveryFrame && !__viewer.dx12.busy && !__viewer.dx12.error', 'GPU process recovery');
      await run('__viewer.dx12.enabled=false');
      for (let i=0; i<120; i++) await render();
      await displayed();
      const screenshot = await win.webContents.capturePage();
      fs.mkdirSync(path.resolve('tests/out'), { recursive: true });
      fs.writeFileSync(path.resolve('tests/out/dx12-presentation-recovery.png'), screenshot.toPNG());
      console.log('DX12 presentation passed: startup retry, 600 continuous frames, delayed-consumer backpressure, 12 failed-import releases, bounded timeout, manual retry, real GPU-process restart.');
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error, diagnostics.join('\n')); clearTimeout(timeout); app.exit(1); }
  });
});
import('../electron/main.js');
