// Real-DOM UI test for the separated shader stack editor window: open it from the
// menu, add a layer (CodeMirror + auto-properties), apply so the MAIN viewport's
// PSO hot-swaps, verify pixels with deterministic MSAA renders, and reset.
const {app,BrowserWindow,Menu}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-stackui-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('Shader stack UI test timed out');app.exit(1)},180000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function shaderWindow(){
  for(let i=0;i<200;i++){
    const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('shader-stack.html'));
    if(w){await w.webContents.executeJavaScript(`(async()=>{for(let i=0;i<200;i++){if(document.getElementById('shader-stack'))return;await new Promise(r=>setTimeout(r,20));}throw new Error('editor not ready')})()`);return w;}
    await sleep(50);
  }
  throw new Error('shader window did not open');
}
// Deterministic MSAA render + pixel grab in the main viewport (pauses the flush).
const renderGrab=`(async()=>{const v=__viewer;v.dx12.enabled=false;v.dx12.dirty=false;for(let i=0;i<100&&v.dx12.busy;i++)await new Promise(r=>setTimeout(r,20));for(let i=0;i<40;i++){const data=v.dx12.frame(),f=new Float32Array(data,4);f[67]=0;await window.api.dx12Render(data);}const c=document.getElementById('dx12-canvas');return Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);})()`;
const diff=(a,b)=>{let s=0,m=0;for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);s+=d;m=Math.max(m,d);}return{mean:s/(a.length*0.75),max:m};};
async function runTest(win){
  await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('no convergence')})()`);
  await win.webContents.executeJavaScript(`(()=>{const v=__viewer;v.controls.update=()=>false;v.camera.position.set(0,1.5,4);v.camera.lookAt(0,1,0);v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();})()`);
  const baseline=await win.webContents.executeJavaScript(renderGrab);
  // Open the editor window from the application menu and add a rim-light layer.
  Menu.getApplicationMenu().getMenuItemById('shader-stack-editor').click();
  const sw=await shaderWindow();
  const added=await sw.webContents.executeJavaScript(`(async()=>{
    document.getElementById('shader-add').click();
    for(let i=0;i<300;i++){if(document.querySelectorAll('#shader-stack li').length&&!document.getElementById('shader-status').textContent.includes('컴파일'))break;await new Promise(r=>setTimeout(r,20));}
    await new Promise(r=>setTimeout(r,500));
    return{rows:document.querySelectorAll('#shader-stack li').length,hasEditor:!!document.querySelector('#shader-editor-host .CodeMirror'),props:document.querySelectorAll('#shader-properties .shader-prop-row').length,errorHidden:document.getElementById('shader-error').hidden};
  })()`);
  const rimmed=await win.webContents.executeJavaScript(renderGrab);
  const rimError=diff(baseline,rimmed);
  const stored=await win.webContents.executeJavaScript(`window.api.shaderStackGet()`);
  // Reset from the editor window; the main viewport must return to baseline.
  await sw.webContents.executeJavaScript(`(async()=>{document.getElementById('shader-reset').click();for(let i=0;i<300;i++){if(!document.querySelectorAll('#shader-stack li').length&&!document.getElementById('shader-status').textContent.includes('컴파일'))break;await new Promise(r=>setTimeout(r,20));}await new Promise(r=>setTimeout(r,500));})()`);
  const restored=await win.webContents.executeJavaScript(renderGrab);
  const restoreError=diff(baseline,restored);
  const storedAfter=await win.webContents.executeJavaScript(`window.api.shaderStackGet()`);
  return{added,rimError,restoreError,storedLen:stored.length,storedAfterLen:storedAfter.length,firstName:stored[0]?.name};
}
app.on('browser-window-created',(_e,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    if(!win.webContents.getURL().includes('index.html'))return;
    try{
      const r=await runTest(win);
      assert.equal(r.added.rows,1,'Adding an example must create one stack row');
      assert.ok(r.added.hasEditor,'CodeMirror must render in the editor window');
      assert.ok(r.added.props>=3,'RimLight must auto-generate property controls');
      assert.ok(r.added.errorHidden,'Apply must succeed without a compile error');
      assert.ok(r.rimError.mean>0.2&&r.rimError.max>20,'Applying from the editor window must change the MAIN viewport: '+JSON.stringify(r.rimError));
      assert.equal(r.storedLen,1,'Main-process store must hold the applied stack');
      assert.equal(r.firstName,'RimLight');
      assert.ok(r.restoreError.mean<0.1,'Reset must restore the main viewport (not rimmed): '+JSON.stringify(r.restoreError));
      assert.equal(r.storedAfterLen,0,'Reset must clear the store');
      console.log('Shader stack window UI passed:',JSON.stringify({rows:r.added.rows,props:r.added.props,rimError:r.rimError,restoreError:r.restoreError}));
      clearTimeout(timeout);app.quit();
    }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
  });
});
import('../electron/main.js');
