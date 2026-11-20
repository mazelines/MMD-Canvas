// Real-DOM UI test for the separated shader system:
//  - the shader-stack EDITOR is a pure library authoring tool (no material selector,
//    shader-centric preview, outline toggle, auto-generated preview properties);
//  - the material INSPECTOR (main window) assigns a shader per material and edits
//    independent per-material instance values, which change the main viewport.
const {app,BrowserWindow,Menu}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-stackui-')));
for(const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
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
  // --- EDITOR: pure library authoring + shader-centric preview + outline toggle ---
  const editor=await sw.webContents.executeJavaScript(`(async()=>{
    const s0=await window.api.shaderStackLibraryGet();
    const builtinNames=s0.library.map(x=>x.name);
    const lib=[...s0.library,{name:'Tint',outline:false,layers:[{id:'t',name:'Tint',code:${JSON.stringify(TINT)},enabled:true}]}];
    await window.api.shaderStackLibrarySet(lib);
    const tintId=lib.length;
    window.__shaderPanel.selectStack(tintId);
    for(let i=0;i<200;i++){const c=document.getElementById('dx12-canvas');if(c&&c.dataset.frame)break;await new Promise(r=>setTimeout(r,30));}
    await new Promise(r=>setTimeout(r,500));
    // Outline toggle on the Tint stack (does not touch Default Toon).
    const cb=document.getElementById('shader-outline');
    const outlineInitial=cb.checked;
    cb.checked=true; cb.dispatchEvent(new Event('change'));
    for(let i=0;i<200;i++){const s=await window.api.shaderStackLibraryGet();if(s.library[tintId-1].outline===true)break;await new Promise(r=>setTimeout(r,30));}
    const outlineOn=(await window.api.shaderStackLibraryGet()).library[tintId-1].outline;
    cb.checked=false; cb.dispatchEvent(new Event('change'));
    for(let i=0;i<200;i++){const s=await window.api.shaderStackLibraryGet();if(s.library[tintId-1].outline===false)break;await new Promise(r=>setTimeout(r,30));}
    const outlineOff=(await window.api.shaderStackLibraryGet()).library[tintId-1].outline;
    return{builtinNames,tintId,
      noMaterialSelector:document.getElementById('shader-material')===null,
      hasOutlineToggle:!!document.getElementById('shader-outline'),
      selectedStack:window.__shaderPanel.selectedStack,
      libRows:document.querySelectorAll('#shader-library li').length,
      propColor:!!document.querySelector('#shader-properties input[type=color]'),
      previewFrame:document.getElementById('dx12-canvas').dataset.frame||null,
      outlineInitial,outlineOn,outlineOff};
  })()`);
  // --- INSPECTOR (main window): per-material assignment + independent instance values ---
  win.focus();
  await win.webContents.executeJavaScript('window.focus()');
  await sleep(300);
  const inspector=await win.webContents.executeJavaScript(`(async()=>{
    const tintId=${editor.tintId};
    const wait=async(f,label)=>{for(let i=0;i<300;i++){if(f())return;await new Promise(r=>setTimeout(r,30));}throw new Error('inspector wait timeout: '+label);};
    // Force a shader-state refresh (broadcasts may be missed while backgrounded).
    window.dispatchEvent(new Event('focus'));
    await wait(()=>__viewer.dx12.library&&__viewer.dx12.library.length>=tintId,'library mirror');
    document.getElementById('tab-materials').click();
    await wait(()=>document.getElementById('materials').children.length>1,'material list');
    document.getElementById('materials').children[0].querySelector('button').click();
    await wait(()=>document.getElementById('material-shader'),'shader dropdown');
    await wait(()=>{const s=document.getElementById('material-shader');return s&&s.options.length>tintId;},'dropdown options');
    const sel=document.getElementById('material-shader');
    const optionCount=sel.options.length;
    sel.value=String(tintId); sel.dispatchEvent(new Event('change'));
    await wait(()=>{const s=document.getElementById('material-shader');return s&&s.value===String(tintId);},'assignment value');
    await wait(()=>document.querySelector('#material-shader-properties input'),'shader properties');
    const hasProps=!!document.querySelector('#material-shader-properties input');
    // Instance values use the same IPC the auto-generated controls commit through.
    await window.api.shaderStackInstanceParams(0,{t:{tint:[1,0,0],strength:1}});
    await window.api.shaderStackAssign(1,tintId);
    await window.api.shaderStackInstanceParams(1,{t:{tint:[0,1,0],strength:1}});
    await window.__refreshShaderState();
    await new Promise(r=>setTimeout(r,700));
    return{optionCount,hasProps};
  })()`);
  const redGreen=await win.webContents.executeJavaScript(renderGrab);
  const assignError=diff(baseline,redGreen);
  // Change material 0 red->green; material 1 must stay green (independent values).
  await win.webContents.executeJavaScript(`(async()=>{await window.api.shaderStackInstanceParams(0,{t:{tint:[0,1,0]}});await window.__refreshShaderState();await new Promise(r=>setTimeout(r,700));})()`);
  const bothGreen=await win.webContents.executeJavaScript(renderGrab);
  const independenceError=diff(redGreen,bothGreen);
  // Deep-merge: a single-prop patch must not wipe the layer's other values.
  await win.webContents.executeJavaScript(`(async()=>{await window.api.shaderStackInstanceParams(0,{t:{strength:0.5}});await new Promise(r=>setTimeout(r,400));})()`);
  const finalState=await win.webContents.executeJavaScript(`window.api.shaderStackLibraryGet()`);
  return{editor,inspector,assignError,independenceError,finalParams0:finalState.instances[0].params,finalParams1:finalState.instances[1].params};
}
app.on('browser-window-created',(_e,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    if(!win.webContents.getURL().includes('index.html'))return;
    const consoleErrors=[];
    win.webContents.on('console-message',(event)=>{if(event.level==='error'||event.level===3)consoleErrors.push(event.message);});
    try{
      const r=await runTest(win);
      assert.ok(r.editor.builtinNames.includes('Default Toon')&&r.editor.builtinNames.includes('Standard'),'Built-in stacks seeded: '+JSON.stringify(r.editor.builtinNames));
      assert.ok(r.editor.noMaterialSelector,'Editor must NOT have a material selector');
      assert.ok(r.editor.hasOutlineToggle,'Editor must have a per-shader outline toggle');
      assert.equal(r.editor.selectedStack,r.editor.tintId,'Editor preview follows the selected library shader');
      assert.ok(r.editor.libRows>=3,'Library list renders built-ins + custom');
      assert.ok(r.editor.propColor,'Editor preview properties auto-generate from the shader');
      assert.ok(r.editor.previewFrame,'Editor sphere previews the selected shader');
      assert.equal(r.editor.outlineInitial,false,'Tint outline starts off');
      assert.equal(r.editor.outlineOn,true,'Outline toggle enables the shader outline');
      assert.equal(r.editor.outlineOff,false,'Outline toggle disables the shader outline');
      assert.ok(r.inspector.optionCount>1,'Inspector shader dropdown lists the library');
      assert.ok(r.inspector.hasProps,'Inspector renders the assigned shader properties');
      assert.ok(r.assignError.mean>0.005&&r.assignError.max>20,'Inspector assignment changes the material pixels: '+JSON.stringify(r.assignError));
      assert.ok(r.independenceError.mean>0.005&&r.independenceError.max>20,'Per-material instance value change alters rendering: '+JSON.stringify(r.independenceError));
      assert.deepEqual(r.finalParams1.t.tint,[0,1,0],'Material 1 value is independent of material 0 edits');
      assert.deepEqual(r.finalParams0.t.tint,[0,1,0],'Deep-merge keeps the previously edited tint');
      assert.equal(r.finalParams0.t.strength,0.5,'Deep-merge keeps the newly edited strength');
      console.log('Shader editor + per-material inspector UI passed:',JSON.stringify({builtins:r.editor.builtinNames,assignError:r.assignError,independenceError:r.independenceError}));
      clearTimeout(timeout);app.quit();
    }catch(error){console.error(error);console.error('MAIN CONSOLE ERRORS:',JSON.stringify(consoleErrors.slice(0,8)));clearTimeout(timeout);app.exit(1)}
  });
});
import('../electron/main.js');
