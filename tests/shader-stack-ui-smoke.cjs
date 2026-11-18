// Real-DOM UI test for the Unreal-style shader stack editor: material preview
// canvas renders, boundary "+" popup inserts a layer, drag reorder, context-menu
// and Del deletion, auto-properties, main-viewport effect, and persistence.
const {app,BrowserWindow,Menu}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-stackui-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('Shader stack UI test timed out');app.exit(1)},200000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function shaderWindow(){
  for(let i=0;i<200;i++){
    const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('shader-stack.html'));
    if(w){await w.webContents.executeJavaScript(`(async()=>{for(let i=0;i<300;i++){if(document.getElementById('shader-stack')&&window.__shaderPanel)return;await new Promise(r=>setTimeout(r,20));}throw new Error('editor not ready')})()`);return w;}
    await sleep(50);
  }
  throw new Error('shader window did not open');
}
const renderGrab=`(async()=>{const v=__viewer;v.dx12.enabled=false;v.dx12.dirty=false;for(let i=0;i<100&&v.dx12.busy;i++)await new Promise(r=>setTimeout(r,20));for(let i=0;i<40;i++){const data=v.dx12.frame(),f=new Float32Array(data,4);f[67]=0;await window.api.dx12Render(data);}const c=document.getElementById('dx12-canvas');return Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);})()`;
const diff=(a,b)=>{let s=0,m=0;for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);s+=d;m=Math.max(m,d);}return{mean:s/(a.length*0.75),max:m};};
async function runTest(win){
  await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('no convergence')})()`);
  await win.webContents.executeJavaScript(`(()=>{const v=__viewer;v.controls.update=()=>false;v.camera.position.set(0,1.5,4);v.camera.lookAt(0,1,0);v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();})()`);
  const baseline=await win.webContents.executeJavaScript(renderGrab);
  Menu.getApplicationMenu().getMenuItemById('shader-stack-editor').click();
  const sw=await shaderWindow();
  // The material preview must render a frame in the editor window's own canvas.
  const preview=await sw.webContents.executeJavaScript(`(async()=>{for(let i=0;i<300;i++){const c=document.getElementById('dx12-canvas');if(c&&c.dataset.frame)return{frame:c.dataset.frame,w:c.width,h:c.height};await new Promise(r=>setTimeout(r,20));}throw new Error('preview did not render')})()`);
  // Insert RimLight at boundary 0 via the "+" popup.
  const inserted=await sw.webContents.executeJavaScript(`(async()=>{
    document.querySelector('.shader-insert').click();
    for(let i=0;i<100;i++){if(document.querySelector('.shader-popup'))break;await new Promise(r=>setTimeout(r,20));}
    const popup=!!document.querySelector('.shader-popup');
    document.querySelector('.shader-popup-item').click();
    for(let i=0;i<300;i++){if(document.querySelectorAll('#shader-stack li').length&&!document.getElementById('shader-status').textContent.includes('컴파일'))break;await new Promise(r=>setTimeout(r,20));}
    await new Promise(r=>setTimeout(r,400));
    return{popup,rows:document.querySelectorAll('#shader-stack li').length,hasEditor:!!document.querySelector('#shader-editor-host .CodeMirror'),props:document.querySelectorAll('#shader-properties .shader-prop-row').length,errorHidden:document.getElementById('shader-error').hidden,name:window.__shaderPanel.stack[0]?.name};
  })()`);
  const rimmed=await win.webContents.executeJavaScript(renderGrab);
  const rimError=diff(baseline,rimmed);
  // Add a second layer, then drag-reorder via the panel move logic.
  const reordered=await sw.webContents.executeJavaScript(`(async()=>{
    document.getElementById('shader-add').click();
    for(let i=0;i<300;i++){if(window.__shaderPanel.stack.length===2&&!document.getElementById('shader-status').textContent.includes('컴파일'))break;await new Promise(r=>setTimeout(r,20));}
    const before=window.__shaderPanel.getStack().map(l=>l.name);
    window.__shaderPanel.moveLayer(0,1);
    await new Promise(r=>setTimeout(r,400));
    const after=window.__shaderPanel.getStack().map(l=>l.name);
    return{before,after,count:after.length};
  })()`);
  // Delete via right-click context menu.
  const ctxDelete=await sw.webContents.executeJavaScript(`(async()=>{
    const row=document.querySelector('#shader-stack li');
    row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:50,clientY:50}));
    for(let i=0;i<100;i++){if(document.querySelector('.shader-context'))break;await new Promise(r=>setTimeout(r,20));}
    const menu=!!document.querySelector('.shader-context');
    document.querySelector('.shader-context .shader-popup-item').click();
    await new Promise(r=>setTimeout(r,400));
    return{menu,rows:window.__shaderPanel.stack.length};
  })()`);
  // Delete the remaining layer via the Del key.
  const delDelete=await sw.webContents.executeJavaScript(`(async()=>{
    window.__shaderPanel.selected=0;
    document.activeElement?.blur?.();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));
    await new Promise(r=>setTimeout(r,500));
    return{rows:window.__shaderPanel.stack.length};
  })()`);
  const restored=await win.webContents.executeJavaScript(renderGrab);
  const restoreError=diff(baseline,restored);
  const storedAfter=await win.webContents.executeJavaScript(`window.api.shaderStackGet()`);
  return{preview,inserted,rimError,reordered,ctxDelete,delDelete,restoreError,storedAfterLen:storedAfter.length};
}
app.on('browser-window-created',(_e,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    if(!win.webContents.getURL().includes('index.html'))return;
    try{
      const r=await runTest(win);
      assert.ok(r.preview.frame,'Material preview must render a frame in the editor canvas');
      assert.ok(r.inserted.popup,'Boundary + must open the function catalog popup');
      assert.equal(r.inserted.rows,1,'Popup selection must insert one layer');
      assert.equal(r.inserted.name,'RimLight');
      assert.ok(r.inserted.hasEditor&&r.inserted.props>=3&&r.inserted.errorHidden,'Editor + auto-properties must render without error');
      assert.ok(r.rimError.mean>0.2&&r.rimError.max>20,'Applied stack must change the MAIN viewport: '+JSON.stringify(r.rimError));
      assert.equal(r.reordered.count,2);
      assert.deepEqual(r.reordered.after,[r.reordered.before[1],r.reordered.before[0]],'moveLayer must reorder the stack');
      assert.ok(r.ctxDelete.menu&&r.ctxDelete.rows===1,'Context-menu delete must remove a layer');
      assert.equal(r.delDelete.rows,0,'Del key must delete the selected layer');
      assert.ok(r.restoreError.mean<0.1,'Empty stack must restore the main viewport: '+JSON.stringify(r.restoreError));
      assert.equal(r.storedAfterLen,0,'Store must be empty after deletes');
      console.log('Shader stack editor UI passed:',JSON.stringify({preview:r.preview,rows:r.inserted.rows,props:r.inserted.props,rimError:r.rimError,reorder:r.reordered.after,restoreError:r.restoreError}));
      clearTimeout(timeout);app.quit();
    }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
  });
});
import('../electron/main.js');
