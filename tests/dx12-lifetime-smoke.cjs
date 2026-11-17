// Real example, changing camera and viewport size, without pixel readbacks in the
// render loop (readbacks flush Canvas2D and can conceal retained shared frames).
const { app, sharedTexture } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mmd-lifetime-')));
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
delete process.env.MMDCONV_DX12_VALIDATION;
const originalImport = sharedTexture.importSharedTexture.bind(sharedTexture);
const outstanding = new Set();
let maxOutstanding = 0, created = 0, released = 0;
sharedTexture.importSharedTexture = options => {
  const token = ++created;
  const imported = originalImport({ ...options, allReferencesReleased: () => {
    outstanding.delete(token); released++; options.allReferencesReleased?.();
  } });
  outstanding.add(token); maxOutstanding = Math.max(maxOutstanding, outstanding.size);
  return imported;
};
const gpuExits = [];
app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU') gpuExits.push(details); });
const timer = setTimeout(() => { console.error('Lifetime test timed out', { created, released, maxOutstanding, gpuExits }); app.exit(1); }, 240000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const run = code => win.webContents.executeJavaScript(code);
    try {
      await run(`(async()=>{for(let i=0;i<1000;i++){if(window.__viewer?.current && __viewer.dx12.lastFrame && !__viewer.dx12.busy && __viewer.dx12.loadedKey.startsWith(__viewer.current.object.uuid))return;await new Promise(r=>setTimeout(r,20));}throw new Error('Example startup failed');})()`);
      await run('__viewer.dx12.enabled=false; __viewer.controls.enableDamping=false');
      const phases = [];
      for (const size of [[1440,900],[1920,1080],[1100,760]]) {
        win.setSize(...size);
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = await run(`(async()=>{
          const v=__viewer, target=v.controls.target.clone(), radius=v.camera.position.distanceTo(target), times=[];
          for(let i=0;i<400;i++) {
            const a=i*0.015;v.camera.position.set(target.x+Math.sin(a)*radius,target.y+Math.sin(a*0.5)*radius*0.15,target.z+Math.cos(a)*radius);
            v.camera.lookAt(target);v.camera.updateMatrixWorld();
            const data=v.dx12.frame();new Float32Array(data,4)[67]=v.dx12.capabilities.dlss?1+Math.floor(i/100)%3:0;
            const start=performance.now();await api.dx12Render(data);times.push(performance.now()-start);
          }
          times.sort((a,b)=>a-b);return{frames:times.length,median:times[200],p95:times[380],max:times.at(-1)};
        })()`);
        phases.push(result);
        console.log('Lifetime phase:', JSON.stringify({ size, ...result, created, released, maxOutstanding, gpuExits:gpuExits.length }));
        assert.equal(gpuExits.length, 0, 'Camera movement must not restart the GPU process');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.ok(outstanding.size<=3, `Shared frames must be returned, still held: ${outstanding.size}`);
      assert.ok(maxOutstanding<=4, `Presentation must bound retained frames, peak: ${maxOutstanding}`);
      const rect = await run('(()=>{const r=document.getElementById("canvas-host").getBoundingClientRect();return{x:Math.ceil(r.x+4),y:Math.ceil(r.y+4),width:Math.floor(r.width-8),height:Math.floor(r.height-8)}})()');
      const shot=await win.webContents.capturePage(rect), pixels=shot.toBitmap();
      let colored=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>35)colored++;
      assert.ok(colored>1000, 'The final example frame must be visible');
      fs.mkdirSync(path.resolve('tests/out'),{recursive:true});fs.writeFileSync('tests/out/dx12-lifetime.png',shot.toPNG());
      console.log('DX12 lifetime passed:', JSON.stringify({ phases, created, released, maxOutstanding, outstanding:outstanding.size, gpuExits }));
      clearTimeout(timer);app.quit();
    } catch(error) { console.error(error,{created,released,maxOutstanding,outstanding:outstanding.size,gpuExits});clearTimeout(timer);app.exit(1); }
  });
});
import('../electron/main.js');
