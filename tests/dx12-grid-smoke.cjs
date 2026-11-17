// Requires npm run build:dx12 and an RTX GPU. Tests analytic editor-grid AA.
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mmd-grid-')));
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
if (process.argv.includes('--validation')) process.env.MMDCONV_DX12_VALIDATION = '1';
const timeout = setTimeout(() => { console.error('Grid test timed out'); app.exit(1); }, 120000);
app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', async () => {
  try {
    await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<1500;i++){
        const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);
        if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy){if(!v.dx12.capabilities.dlss)throw new Error('RTX GPU required');return;}
        await new Promise(r=>setTimeout(r,20));
      }throw new Error('Startup did not converge');
    })()`);
    const result = await win.webContents.executeJavaScript(`(async()=>{const {runGridCases}=await import('../tests/dx12-grid-cases.js');return runGridCases(__viewer)})()`);
    const directory = path.resolve(process.env.MMDCONV_GRID_RESULTS || 'tests/out/grid');
    fs.mkdirSync(directory, { recursive: true });
    for (const image of result.images) fs.writeFileSync(path.join(directory, image.name + '.png'), Buffer.from(image.png.split(',')[1], 'base64'));
    delete result.images;
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result, null, 2));
    console.log('Grid results:', JSON.stringify(result));
    assert.equal(result.skyMax, 0, 'Grid must not leak above the horizon');
    for (const pose of result.results) {
      assert.equal(pose.offMax, 0, 'Grid toggle must remove the complete overlay');
      for (const mode of pose.modes) {
        assert.equal(mode.antialiasing, ['MSAA 4x', 'DLAA', 'DLSS Quality', 'DLSS Balanced'][mode.mode]);
        assert.equal(mode.modeDifference.max, 0, 'Output grid must not depend on internal resolution or jitter');
        assert.equal(mode.staticDifference.max, 0, 'Stationary grid must not shimmer');
        for (const width of mode.widths) assert.ok(width > 0.75 && width < 1.25, `${pose.name}: minor grid width ${width} must stay near one output pixel`);
      }
      for (const widths of pose.moving) for (const width of widths) assert.ok(width > 0.7 && width < 1.3, `${pose.name}: moving grid width ${width} must remain stable`);
    }
    console.log('Grid GPU regression passed'); clearTimeout(timeout); app.quit();
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
}));
(async () => {
  // An isolated compiled renderer lets us compare a shader fix against an older
  // renderer without modifying the app or racing another native build.
  if (process.env.MMDCONV_GRID_NATIVE) {
    const { Dx12Host } = await import('../electron/dx12.js');
    Object.defineProperty(Dx12Host.prototype, 'executable', { get: () => path.resolve(process.env.MMDCONV_GRID_NATIVE) });
  }
  await import('../electron/main.js');
})();
