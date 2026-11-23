// Real editor + compiler + GPU: the last enabled row wins when functions
// overwrite the color. Reversing display or execution order fails this check.
const {app, BrowserWindow, Menu, dialog} = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-shader-order-'));
app.setPath('userData', path.join(project, 'profile'));
fs.mkdirSync(path.join(project, 'shaders'), {recursive:true});
const shaderPath = path.join(project, 'shaders', 'Order.shader');
const bluePath = path.join(project, 'shaders', 'SetBlue.shaderStack');
const colorFunction = (name, color) => ({name, code:`void ${name}(inout ShadingContext ctx) { ctx.color = float3(${color}); }`});
fs.writeFileSync(bluePath, JSON.stringify({format:'mmd-canvas-shader-stack', version:1, ...colorFunction('SetBlue', '0,0,1')}));
dialog.showOpenDialog = async () => ({canceled:false, filePaths:[bluePath]});
dialog.showSaveDialog = async () => ({canceled:false, filePath:shaderPath});
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout = setTimeout(() => { console.error('Shader order UI timed out'); app.exit(1); }, 180000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', async () => {
  if (started) return; started = true;
  const run = (w, source) => w.webContents.executeJavaScript(source);
  try {
    await run(win, `(async()=>{for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw v.dx12.error;if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('startup timeout')})()`);
    await run(win, `api.shaderStackSetDir(${JSON.stringify(project)})`);
    Menu.getApplicationMenu().getMenuItemById('shader-stack-editor').click();
    let sw;
    for (let i=0; i<300; i++) {
      sw = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('shader-stack.html'));
      if (sw && await run(sw, '!!window.__shaderPanel').catch(()=>false)) break;
      await sleep(20);
    }
    assert.ok(sw, 'editor opened');
    const readRows = () => run(sw, `Array.from(document.querySelectorAll('#shader-stack .shader-layer-row'),r=>({name:r.querySelector('.shader-select').textContent,number:r.querySelector('.shader-execution-number').textContent,id:r.dataset.layerId}))`);
    const assertRows = async (names, numbers) => {
      const rows = await readRows();
      assert.deepEqual(rows.map(r=>r.name), names);
      assert.deepEqual(rows.map(r=>r.number), numbers);
      const committed = await run(sw, '(async()=>{const s=await api.shaderStackLibraryGet();return s.library[__shaderPanel.selectedStack-1].layers.map(l=>l.id)})()');
      assert.deepEqual(rows.map(r=>r.id), committed, 'visible order matches committed execution order');
    };
    // Wait for a rendered center pixel with the expected dominant channel.
    // Each function overwrites color: the last enabled function must win.
    const assertColor = async channel => {
      const pixel = await run(sw, `(async()=>{__shaderPreview.requestRender();let pixel;for(let i=0;i<200;i++){if(__shaderPreview.dx12.error)throw __shaderPreview.dx12.error;const c=document.getElementById('dx12-canvas');if(c){pixel=Array.from(c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data);if(pixel[${channel}]>100&&pixel.filter((v,j)=>j<3&&j!==${channel}).every(v=>v<60))return pixel;}await new Promise(r=>setTimeout(r,30));}throw new Error('wrong preview color: '+JSON.stringify(pixel))})()`);
      assert.ok(pixel[channel]>100);
    };
    const drag = (from, to, below=false) => run(sw, `(async()=>{const rows=document.querySelectorAll('#shader-stack .shader-layer-row'),source=rows[${from}],target=rows[${to}],dataTransfer=new DataTransfer(),r=target.getBoundingClientRect();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientY:${below?'r.bottom-1':'r.top+1'}}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));if(!await __shaderPanel.applyTask)throw new Error('reorder failed');})()`);
    await run(sw, `(async()=>{const p=__shaderPanel;await p.addStack();p.library[p.selectedStack-1].name='Order';p.insertLayer(0,${JSON.stringify(colorFunction('SetRed','1,0,0'))});await p.applyTask;p.insertLayer(1,${JSON.stringify(colorFunction('SetGreen','0,1,0'))});await p.applyTask;p.selected=0;p.render();})()`);
    // Opening a file appends even while the first row is selected.
    await run(sw, '(async()=>{await __shaderPanel.openFunction();await __shaderPanel.applyTask;})()');
    await assertRows(['SetRed','SetGreen','SetBlue'], ['1','2','3']);
    await assertColor(2);
    await drag(2,0);
    await assertRows(['SetBlue','SetRed','SetGreen'], ['1','2','3']);
    await assertColor(1);
    // Turning the first row off renumbers later calls; turning it back on must
    // also work after apply() replaces the library objects with committed data.
    const toggle = index => run(sw, `(async()=>{document.querySelectorAll('#shader-stack .shader-layer-row input')[${index}].click();if(!await __shaderPanel.applyTask)throw new Error('toggle failed');})()`);
    await toggle(0);
    await assertRows(['SetBlue','SetRed','SetGreen'], ['—','1','2']);
    await assertColor(1);
    await toggle(0);
    await toggle(2);
    await assertRows(['SetBlue','SetRed','SetGreen'], ['1','2','—']);
    await assertColor(0);
    await toggle(2);
    await drag(0,2,true);
    await assertRows(['SetRed','SetGreen','SetBlue'], ['1','2','3']);
    await assertColor(2);
    // Header Add opens the catalog (no implicit function) and appends its choice.
    const before = await readRows();
    await run(sw, "document.getElementById('shader-add').click()");
    assert.deepEqual(await readRows(), before);
    await run(sw, `(async()=>{[...document.querySelectorAll('.shader-popup-item')].find(e=>e.textContent==='Custom').click();await __shaderPanel.applyTask;})()`);
    await assertRows(['SetRed','SetGreen','SetBlue','Custom'], ['1','2','3','4']);
    // The + before the first row inserts before the first execution step.
    await run(sw, `(async()=>{document.querySelector('.shader-insert').click();[...document.querySelectorAll('.shader-popup-item')].find(e=>e.textContent==='Custom').click();await __shaderPanel.applyTask;})()`);
    await assertRows(['Custom_2','SetRed','SetGreen','SetBlue','Custom'], ['1','2','3','4','5']);
    await assertColor(2);
    await run(sw, '__shaderPanel.saveStack(false)');
    const saved = JSON.parse(fs.readFileSync(shaderPath,'utf8'));
    assert.deepEqual(saved.layers.map(l=>l.id), (await readRows()).map(r=>r.id));
    await run(sw, `(async()=>{const state=await api.shaderStackSetDir(${JSON.stringify(project)});__shaderPanel.setState(state);__shaderPanel.selectStack(state.library.findIndex(e=>e.path===${JSON.stringify(shaderPath)})+1);})()`);
    await assertRows(['Custom_2','SetRed','SetGreen','SetBlue','Custom'], ['1','2','3','4','5']);
    await assertColor(2);
    fs.mkdirSync(path.resolve('.cache'), {recursive:true});
    fs.writeFileSync(path.resolve('.cache/shader-order-editor.png'), (await sw.webContents.capturePage()).toPNG());
    console.log('Shader order UI passed: top-to-bottom GPU output, drag both ways, skip/re-enable, append, insert, save/reload.');
    clearTimeout(timeout); app.quit();
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
}));
import('../electron/main.js');
