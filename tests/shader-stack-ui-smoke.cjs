// Real-DOM UI test for the Unity-like per-material shader editor: built-in stacks,
// per-material assignment + independent instance property values, preview, and
// persistence. Verifies the main viewport changes per material.
const {app,BrowserWindow,Menu}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-stackui-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('Shader stack UI test timed out');app.exit(1)},200000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const TINT=`//@property float3 tint = (1,1,1) "색조"
//@property float strength = 1.0 [0,1] "강도"
void Tint(inout ShadingContext ctx) { ctx.color *= lerp(float3(1,1,1), tint, strength); }`;
async function shaderWindow(){
  for(let i=0;i<200;i++){
    const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('shader-stack.html'));
    if(w){await w.webContents.executeJavaScript(`(async()=>{for(let i=0;i<300;i++){if(document.getElementById('shader-stack')&&window.__shaderPanel)return;await new Promise(r=>setTimeout(r,20));}throw new Error('editor not ready')})()`);return w;}
    await sleep(50);
  }
  throw new Error('shader window did not open');
}
const renderGrab=`(async()=>{const v=__viewer;v.dx12.enabled=true;v.dx12.aaMode=0;v.requestRender();for(let i=0;i<400;i++){if(v.dx12.lastFrame&&!v.dx12.lastFrame.aaAccumulating&&!v.dx12.busy&&v.dx12.lastFrame.antialiasing==='MSAA 4x')break;await new Promise(r=>setTimeout(r,30));}await new Promise(r=>setTimeout(r,200));const c=document.getElementById('dx12-canvas');return Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);})()`;
const diff=(a,b)=>{let s=0,m=0;for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);s+=d;m=Math.max(m,d);}return{mean:s/(a.length*0.75),max:m};};
async function runTest(win){
  await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('no convergence')})()`);
  await win.webContents.executeJavaScript(`(()=>{const v=__viewer;v.controls.update=()=>false;v.camera.position.set(0,1.5,4);v.camera.lookAt(0,1,0);v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();})()`);
  const baseline=await win.webContents.executeJavaScript(renderGrab);
  Menu.getApplicationMenu().getMenuItemById('shader-stack-editor').click();
  const sw=await shaderWindow();
  const setup=await sw.webContents.executeJavaScript(`(async()=>{
    const s0=await window.api.shaderStackLibraryGet();
    const builtinNames=s0.library.map(x=>x.name);
    // Add a tint stack (id = library.length+1), assign material 0 to it.
    const lib=[...s0.library,{name:'Tint',outline:false,layers:[{id:'t',name:'Tint',code:${JSON.stringify(TINT)},enabled:true}]}];
    await window.api.shaderStackLibrarySet(lib);
    const tintId=lib.length;
    await window.api.shaderStackAssign(0,tintId);
    await window.api.shaderStackInstanceParams(0,{t:{tint:[1,0,0],strength:1}});
    await window.api.shaderStackPreview(0);
    for(let i=0;i<200;i++){const s=await window.api.shaderStackLibraryGet();if(s.instances[0]&&s.instances[0].stackId===tintId)break;await new Promise(r=>setTimeout(r,30));}
    await new Promise(r=>setTimeout(r,800));
    const s=await window.api.shaderStackLibraryGet();
    return{builtinNames,tintId,assign0:s.instances[0].stackId,params0:s.instances[0].params,matOptions:document.getElementById('shader-material').options.length,libRows:document.querySelectorAll('#shader-library li').length};
  })()`);
  const rimmed=await win.webContents.executeJavaScript(renderGrab);
  const tintError=diff(baseline,rimmed);
  const preview=await sw.webContents.executeJavaScript(`(async()=>{for(let i=0;i<200;i++){const c=document.getElementById('dx12-canvas');if(c&&c.dataset.frame)return{frame:c.dataset.frame};await new Promise(r=>setTimeout(r,30));}throw new Error('preview did not render')})()`);
  // Change material 0's instance value (green) — independent per-material value.
  await sw.webContents.executeJavaScript(`(async()=>{await window.api.shaderStackInstanceParams(0,{t:{tint:[0,1,0],strength:1}});await new Promise(r=>setTimeout(r,800));})()`);
  const green=await win.webContents.executeJavaScript(renderGrab);
  const greenError=diff(rimmed,green);
  const finalState=await sw.webContents.executeJavaScript(`window.api.shaderStackLibraryGet()`);
  return{setup,tintError,preview,greenError,finalParams0:finalState.instances[0].params,libLen:finalState.library.length};
}
app.on('browser-window-created',(_e,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    if(!win.webContents.getURL().includes('index.html'))return;
    try{
      const r=await runTest(win);
      assert.ok(r.setup.builtinNames.includes('Default Toon')&&r.setup.builtinNames.includes('Standard'),'Built-in stacks seeded: '+JSON.stringify(r.setup.builtinNames));
      assert.equal(r.setup.assign0,r.setup.tintId,'Material 0 assigned to tint stack');
      assert.ok(r.setup.matOptions>1,'Material selector lists model materials');
      assert.ok(r.setup.libRows>=3,'Library list renders built-ins + custom');
      assert.ok(r.tintError.mean>0.005&&r.tintError.max>20,'Assigned stack changes the material pixels: '+JSON.stringify(r.tintError));
      assert.ok(r.preview.frame,'Preview renders the selected material stack');
      assert.ok(r.greenError.mean>0.005&&r.greenError.max>20,'Per-material instance value change alters rendering: '+JSON.stringify(r.greenError));
      assert.deepEqual(r.finalParams0.t.tint,[0,1,0],'Instance value persists');
      console.log('Shader stack per-material UI passed:',JSON.stringify({builtins:r.setup.builtinNames,tintError:r.tintError,greenError:r.greenError}));
      clearTimeout(timeout);app.quit();
    }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
  });
});
import('../electron/main.js');
