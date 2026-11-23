// Real editor / main IPC / DXC integration. All disk writes stay in a temp project.
const {app, BrowserWindow, Menu, dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const project=fs.mkdtempSync(path.join(os.tmpdir(),'mmd-function-assets-'));
app.setPath('userData',path.join(project,'profile'));
fs.mkdirSync(path.join(project,'shaders','stacks'),{recursive:true});
const fn=path.join(project,'shaders','stacks','Tint.shaderStack'), a=path.join(project,'shaders','A.shader'), b=path.join(project,'shaders','B.shader');
let saveTarget=null,openTarget=null;
dialog.showSaveDialog=async()=>saveTarget?{canceled:false,filePath:saveTarget}:{canceled:true};
dialog.showOpenDialog=async()=>openTarget?{canceled:false,filePaths:[openTarget]}:{canceled:true,filePaths:[]};
for(const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const code='//@property float gain = 0.8 [0,2] "Gain"\nfloat Scale(float x){return x;}\nvoid Tint(inout ShadingContext ctx){ctx.color *= Scale(gain);}';
const timeout=setTimeout(()=>{console.error('shader assets UI timed out');app.exit(1)},180000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let started=false;
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  if(started)return;started=true;
  const run=(w,s)=>w.webContents.executeJavaScript(s);
  try{
    await run(win,`(async()=>{for(let i=0;i<1500;i++){if(__viewer?.dx12.error)throw __viewer.dx12.error;if(__viewer?.current&&__viewer.dx12.lastFrame&&!__viewer.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('startup timeout')})()`);
    await run(win,`api.shaderStackSetDir(${JSON.stringify(project)})`);
    Menu.getApplicationMenu().getMenuItemById('shader-stack-editor').click();
    let sw;
    for(let i=0;i<300;i++){sw=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('shader-stack.html'));if(sw&&await run(sw,'!!window.__shaderPanel').catch(()=>false))break;await sleep(20);}
    assert.ok(sw,'editor opened');
    await run(sw,`(async()=>{const p=__shaderPanel;await p.addStack();p.library[p.selectedStack-1].name='Shader A';p.insertLayer(0,{name:'Tint',code:${JSON.stringify(code)}});await p.applyTask;window.assetA=p.selectedStack;})()`);
    saveTarget=fn;await run(sw,'__shaderPanel.saveFunction(false)');
    assert.equal(JSON.parse(fs.readFileSync(fn,'utf8')).format,'mmd-canvas-shader-stack');
    // Insert the saved function from the actual + catalog, twice in one shader.
    await run(sw,`(async()=>{const p=__shaderPanel;p.openCatalog(1,document.querySelector('.shader-insert'));const item=[...document.querySelectorAll('.shader-popup-item')].find(e=>e.title===${JSON.stringify(fn)});if(!item)throw new Error('saved function absent from catalog');item.click();await p.applyTask;})()`);
    saveTarget=a;await run(sw,'__shaderPanel.saveStack(false)');
    const ad=JSON.parse(fs.readFileSync(a,'utf8'));
    assert.equal(ad.version,2);assert.equal(ad.layers.length,2);assert.notEqual(ad.layers[0].id,ad.layers[1].id);
    assert.equal(ad.layers[0].ref,ad.layers[1].ref);assert.equal(ad.layers[0].code,undefined);
    // Open the function into a second shader through the file chooser.
    await run(sw,`(async()=>{await __shaderPanel.addStack();__shaderPanel.library[__shaderPanel.selectedStack-1].name='Shader B';window.assetB=__shaderPanel.selectedStack;})()`);
    openTarget=fn;await run(sw,'__shaderPanel.openFunction()');await run(sw,'__shaderPanel.applyTask');
    saveTarget=b;await run(sw,'__shaderPanel.saveStack(false)');
    assert.equal(JSON.parse(fs.readFileSync(b,'utf8')).layers[0].ref,ad.layers[0].ref);
    assert.equal(JSON.parse(fs.readFileSync(b,'utf8')).name,'Shader B');
    await run(sw,"document.querySelector('#shader-stack .shader-select').click()");
    // Shared source edits update all three instances, including namespaced helper code.
    const edited=code.replace('0.8','0.6');
    const shared=await run(sw,`(async()=>{const p=__shaderPanel;p.editor.setValue(${JSON.stringify(edited)});if(!await p.apply())throw new Error(document.getElementById('shader-error').textContent);return (await api.shaderStackLibraryGet()).library.filter(e=>e.path===${JSON.stringify(a)}||e.path===${JSON.stringify(b)}).flatMap(e=>e.layers).map(l=>l.code);})()`);
    assert.equal(shared.length,3);assert.ok(shared.every(c=>c===edited));
    saveTarget=fn;await run(sw,'__shaderPanel.saveFunction(false)');
    assert.equal(JSON.parse(fs.readFileSync(fn,'utf8')).code,edited);
    // Invalid HLSL stays in the editor; committed shader and stride remain valid.
    const failed=await run(sw,`(async()=>{const before=await api.shaderStackLibraryGet(),p=__shaderPanel;p.editor.setValue('void Tint(inout ShadingContext ctx){ syntax error }');const ok=await p.apply();const after=await api.shaderStackLibraryGet();return {ok,error:document.getElementById('shader-error').textContent,before:before.stride,after:after.stride,code:after.library[assetB-1].layers[0].code};})()`);
    assert.equal(failed.ok,false);assert.ok(failed.error);assert.equal(failed.before,failed.after);assert.equal(failed.code,edited);
    await run(sw,`(async()=>{__shaderPanel.editor.setValue(${JSON.stringify(edited)});await __shaderPanel.apply();})()`);
    // Cancelled Save As leaves both the file and reference unchanged.
    saveTarget=null;await run(sw,'__shaderPanel.saveFunction(true)');
    assert.equal(JSON.parse(fs.readFileSync(fn,'utf8')).code,edited);
    const refs=await run(sw,'__shaderPanel.stack.map(l=>l.ref)');assert.deepEqual(refs,[fn]);
    // Save As detaches this instance without changing other users or its layer ID.
    const copy=path.join(project,'shaders','stacks','Copy.shaderStack'), copyCode=edited.replace('0.6','0.9');
    const originalLayer=await run(sw,'__shaderPanel.stack[0].id');
    await run(sw,`__shaderPanel.editor.setValue(${JSON.stringify(copyCode)})`);
    saveTarget=copy;await run(sw,'__shaderPanel.saveFunction(true)');
    const detached=await run(sw,'api.shaderStackLibraryGet()');
    assert.ok(detached.library.find(e=>e.path===a).layers.every(l=>l.ref===fn&&l.code===edited));
    const detachedB=detached.library.find(e=>e.path===b).layers[0];
    assert.equal(detachedB.ref,copy);assert.equal(detachedB.id,originalLayer);assert.equal(detachedB.code,copyCode);
    // A failed file write does not publish the new function reference.
    saveTarget=path.join(project,'does-not-exist','Failed.shaderStack');
    await run(sw,'__shaderPanel.saveFunction(true)');
    assert.equal((await run(sw,'api.shaderStackLibraryGet()')).library.find(e=>e.path===b).layers[0].ref,copy);
    assert.ok(await run(sw,"document.getElementById('shader-error').textContent"));
    saveTarget=b;await run(sw,'__shaderPanel.saveStack(false)');
    // Rebuild the library from disk as workspace restoration does; instance values
    // remain keyed by their stable layer IDs, including repeated function instances.
    const params={ [ad.layers[0].id]:{gain:0.2},[ad.layers[1].id]:{gain:1.4} };
    const restored=await run(win,`api.shaderStackRestore(${JSON.stringify({baseDir:project,shaderFiles:[a,b],instances:[{ref:a,params},{ref:b,params:{}}]})})`);
    assert.deepEqual(restored.instances[0].params,params);
    const loadedA=restored.library.find(e=>e.path===a);assert.deepEqual(loadedA.layers.map(l=>l.id),ad.layers.map(l=>l.id));
    assert.ok(loadedA.layers.every(l=>l.code===edited));
    assert.equal(restored.library.find(e=>e.path===b).layers[0].code,copyCode);
    const packed=await run(win,`(async()=>{const s=await api.shaderStackLibraryGet(),{packMaterialParams}=await import('../src/core/shader-stack.js');return Array.from(packMaterialParams(s.library,s.instances,[0],s.stride,1));})()`);
    assert.ok(Math.abs(packed[0]-.2)<1e-6);assert.ok(Math.abs(packed[4]-1.4)<1e-6);
    await run(sw,"document.querySelector('#shader-stack .shader-select').click()");
    await sleep(500);
    const previewMax=await run(sw,"(()=>{const c=document.getElementById('dx12-canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let max=0;for(let i=0;i<p.length;i+=4)max=Math.max(max,p[i],p[i+1],p[i+2]);return max;})()");
    if(previewMax<=60)console.log('PREVIEW DEBUG',await run(sw,`(async()=>{const v=__shaderPreview,d=v.dx12,{packMaterialParams}=await import('../src/core/shader-stack.js');return {library:d.library.map(e=>({name:e.name,layers:e.layers})),instances:d.instances,panel:d.panelIndices,stride:d.stride,key:d.loadedParamKey,packed:Array.from(packMaterialParams(d.library,d.instances,d.panelIndices,d.stride,d.panelIndices.length)),frame:Array.from(new Float32Array(d.frame(),4)).slice(32),error:d.error?.message,busy:d.busy};})()`));
    assert.ok(previewMax>60,'new function defaults must reach the GPU preview instead of leaving it black: '+previewMax);
    fs.mkdirSync(path.resolve('.cache'),{recursive:true});
    fs.writeFileSync(path.resolve('.cache/shader-assets-editor.png'),(await sw.webContents.capturePage()).toPNG());
    // Missing dependencies are visible and cannot be saved over the original shader.
    const original=fs.readFileSync(a,'utf8');fs.renameSync(fn,`${fn}.missing`);
    const missing=await run(win,`api.shaderStackSetDir(${JSON.stringify(project)})`);
    assert.ok(missing.assetErrors.some(e=>e.path===a));
    const index=missing.library.findIndex(e=>e.path===a)+1;
    await assert.rejects(run(win,`api.shaderStackSaveEntry(${index},false)`));
    assert.equal(fs.readFileSync(a,'utf8'),original);
    console.log('Shader assets editor integration passed: shared source, repeated instances, save/open/restore, failed compile, cancel, missing dependencies');
    clearTimeout(timeout);app.quit();
  }catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
}));
import('../electron/main.js');
