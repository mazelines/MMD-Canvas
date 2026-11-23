// Built-in catalog -> controls -> saved assets, plus real GPU math and mask data.
const {app, BrowserWindow, Menu, dialog} = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-function-library-'));
app.setPath('userData', path.join(project, 'profile'));
const shaderPath = path.join(project, 'Library.shader'), maskPath = path.join(project, 'mask with space.png');
dialog.showOpenDialog = async () => ({canceled:false, filePaths:[maskPath]});
dialog.showSaveDialog = async () => ({canceled:false, filePath:shaderPath});
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout = setTimeout(() => { console.error('Function library test timed out'); app.exit(1); }, 180000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (window, code) => window.webContents.executeJavaScript(code);
let started = false;
app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', async () => {
  if (started) return; started = true;
  try {
    await run(win, `(async()=>{for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw v.dx12.error;if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('startup timeout')})()`);
    const maskPNG = await run(win, `(()=>{const c=document.createElement('canvas');c.width=c.height=16;const x=c.getContext('2d');x.fillStyle='black';x.fillRect(0,0,16,16);x.fillStyle='white';x.fillRect(0,0,16,8);return c.toDataURL()})()`);
    fs.writeFileSync(maskPath, Buffer.from(maskPNG.split(',')[1], 'base64'));
    await run(win, `api.shaderStackSetDir(${JSON.stringify(project)})`);
    Menu.getApplicationMenu().getMenuItemById('shader-stack-editor').click();
    let sw;
    for (let i=0; i<300; i++) {
      sw = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('shader-stack.html'));
      if (sw && await run(sw, '!!window.__shaderPanel').catch(()=>false)) break;
      await sleep(20);
    }
    assert.ok(sw, 'editor opened');
    const ui = await run(sw, `(async()=>{
      const p=__shaderPanel;await p.addStack();p.library[p.selectedStack-1].name='Library';
      for(const name of ['VerticalTwoColorBlending','SelfEmission']) {
        p.openCatalog(p.stack.length,document.getElementById('shader-add-function'));
        const button=[...document.querySelectorAll('.shader-popup-item')].find(b=>b.textContent===name);
        if(!button)throw new Error('Missing catalog function '+name);button.click();
        if(!await p.applyTask)throw new Error('Compile failed '+document.getElementById('shader-error').textContent);
      }
      const findRow=name=>[...document.querySelectorAll('#shader-properties .shader-prop-row')].find(r=>r.dataset.property===name);
      const mask=findRow('emissionMask');mask.querySelector('button').click();
      for(let i=0;i<100&&!p.previewValues[p.stack[1].id]?.emissionMask?.texture;i++)await new Promise(r=>setTimeout(r,20));
      const selected=p.previewValues[p.stack[1].id]?.emissionMask?.texture;
      if(!selected)throw new Error('Texture picker did not commit');
      const chosenLabel=mask.querySelector('button').textContent;
      const dx=__shaderPreview.dx12;
      for(let i=0;i<500;i++) {
        if(dx.error)throw dx.error;
        if(!dx.busy&&dx.shaderTextureIds.get(selected)?.index>=0)break;
        await new Promise(r=>setTimeout(r,20));
      }
      if(!(dx.shaderTextureIds.get(selected)?.index>=0))throw new Error('Real preview flush did not upload the mask');
      mask.querySelectorAll('button')[1].click();
      const cleared=p.previewValues[p.stack[1].id].emissionMask.texture;
      const toggle=findRow('useDiffuseColor').querySelector('input');toggle.click();
      const mode=p.previewValues[p.stack[1].id].useDiffuseColor;
      const range=findRow('topShare').querySelector('input');range.value=75;range.dispatchEvent(new Event('input',{bubbles:true}));
      const share=p.previewValues[p.stack[0].id].topShare;
      await p.saveStack();
      return {selected,chosenLabel,cleared,mode,share,layers:p.stack.map(l=>({name:l.name,ref:l.ref})),error:document.getElementById('shader-error').textContent};
    })()`);
    assert.equal(ui.selected, maskPath); assert.equal(ui.chosenLabel, path.basename(maskPath));
    assert.equal(ui.cleared, null); assert.equal(ui.mode, 0); assert.equal(ui.share, 75);
    const saved = JSON.parse(fs.readFileSync(shaderPath,'utf8'));
    assert.equal(saved.version,2); assert.equal(saved.layers.length,2);
    for(const layer of saved.layers) assert.ok(fs.existsSync(path.resolve(project,layer.ref)));
    assert.ok(ui.layers.every(l=>l.ref&&!l.ref.includes('app.asar')));

    // Use the main host with a deterministic front-facing test plane. Pixel
    // expectations are compared to constant-color reference renders through the
    // same exposure/GT7 transform, not to un-tonemapped RGB values.
    const gpu = await run(win, `(async()=>{
      const v=__viewer,d=v.dx12;d.enabled=false;v.controls.update=()=>false;
      while(d.busy)await new Promise(r=>setTimeout(r,10));
      const THREE=await import('three');
      const {nativeModel}=await import('./dx12.js');
      const {packMaterialParams,parseStack}=await import('../src/core/shader-stack.js');
      const {ShaderTextures}=await import('./shader-textures.js');
      const state=await api.shaderStackLibraryGet(),gradient={...state.builtinFunctions.find(f=>f.name==='VerticalTwoColorBlending'),id:'gradient'},emission={...state.builtinFunctions.find(f=>f.name==='SelfEmission'),id:'emission'};
      const root=new THREE.Group(),material=new THREE.MeshLambertMaterial({color:new THREE.Color(0,1,0),side:THREE.DoubleSide});
      const plane=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);root.add(plane);v.current={object:root};
      v.camera=new THREE.OrthographicCamera(-1.2,1.2,1.2,-1.2,0.1,100);v.camera.position.set(0,0,4);v.camera.lookAt(0,0,0);v.camera.updateProjectionMatrix();
      const textures=new ShaderTextures();await textures.prepare([${JSON.stringify(maskPath)}],1);if(textures.errors.length)throw new Error(textures.errors.join());
      const ids=new Map();
      const upload=async()=>{await api.dx12Model(nativeModel(root,false,null,null,null,textures.entries,ids));await api.dx12MaterialStacks([0]);};
      await upload();
      const draw=async(legacy=false)=>{
        const packet=d.frame(),f=new Float32Array(packet,4);f[44]=f[45]=256;f[48]=100;f[50]=f[51]=f[63]=f[67]=f[72]=0;f[35]=f[39]=0;f[59]=0;
        await api.dx12Render(legacy?packet.slice(0,308):packet);
        const c=document.getElementById('dx12-canvas');return {data:c.getContext('2d').getImageData(0,0,c.width,c.height).data,width:c.width,height:c.height};
      };
      const pixel=(image,x,y)=>[...image.data.slice((Math.floor(y)*image.width+Math.floor(x))*4,(Math.floor(y)*image.width+Math.floor(x))*4+3)];
      const sample=(image,h)=>{const point=new THREE.Vector3(0,h*2-1,0).applyMatrix4(root.matrixWorld).project(v.camera);return pixel(image,(point.x+1)*image.width/2,(1-point.y)*image.height/2);};
      const near=(a,b,tolerance=4)=>a.every((c,i)=>Math.abs(c-b[i])<=tolerance);
      const params=async(layers,values)=>{const stride=parseStack(layers).slotCount;await api.dx12Params(packMaterialParams([{layers}],[{stackId:1,params:values}],[0],stride,1,ids).buffer);};
      const reset={id:'reset',name:'Reset',code:'void Reset(inout ShadingContext ctx){ctx.color=0;}'};
      const input={id:'input',name:'Input',code:'//@property color inputColor = (0.8,0.4,0.6) "Input"\\nvoid Input(inout ShadingContext ctx){ctx.color=inputColor;}'};
      await api.dx12Shader([input]);
      const reference=async color=>{await params([input],{input:{inputColor:color}});return sample(await draw(),0.5);};
      const heights=[0.25,0.5,0.75],refs=[];
      for(const h of heights)refs.push(await reference([0.8*h,0,0.6*(1-h)]));
      const strengths=[0,0.5,1],strengthRefs=[];
      for(const strength of strengths)strengthRefs.push(await reference([0.8*(1-0.5*strength),0.4*(1-strength),0.6*(1-0.5*strength)]));
      const gradientLayers=[input,gradient],gradientParams=values=>params(gradientLayers,{gradient:values});
      await api.dx12Shader(gradientLayers);
      const gradientValues={topColor:[1,0,0],bottomColor:[0,0,1],topShare:50};
      await gradientParams(gradientValues);const linear=await draw();
      for(const [i,h] of heights.entries()) {
        const ref=refs[i];
        if(!near(sample(linear,h),ref))throw new Error('Default gradient not linear at '+h+': '+JSON.stringify([sample(linear,h),ref]));
      }
      const blendSamples=[];
      for(const [i,strength] of strengths.entries()) {
        await gradientParams({...gradientValues,strength});const actual=sample(await draw(),0.5);blendSamples.push(actual);
        if(!near(actual,strengthRefs[i]))throw new Error('Multiplicative blend strength '+strength+': '+JSON.stringify([actual,strengthRefs[i]]));
      }
      await gradientParams({...gradientValues,topShare:75});const expanded=sample(await draw(),0.5);
      if(expanded[0]<=sample(linear,0.5)[0]||expanded[2]>=sample(linear,0.5)[2])throw new Error('Top occupancy did not expand');
      for(const share of [0,100]) {
        await gradientParams({...gradientValues,topShare:share});const img=await draw();
        if(!near(sample(img,0.2),sample(img,0.8),1))throw new Error('Endpoint not constant');
      }
      root.position.set(2,-3,1);root.rotation.set(0.3,0.2,0.5);root.scale.set(1.1,0.7,1.8);root.updateMatrixWorld(true);
      v.camera.position.copy(new THREE.Vector3(0,0,5).applyMatrix4(root.matrixWorld));v.camera.up.copy(new THREE.Vector3(0,1,0).transformDirection(root.matrixWorld));v.camera.lookAt(root.position);v.camera.updateMatrixWorld();
      await upload();await gradientParams(gradientValues);const transformed=await draw();
      for(const [i,h] of [0.25,0.5,0.75].entries())if(!near(sample(transformed,h),refs[i],5))throw new Error('Object transform changed gradient');
      const legacy=await draw(true);if(!near(sample(legacy,0.2),sample(legacy,0.8)))throw new Error('Legacy frame packet fallback failed');
      root.position.set(0,0,0);root.rotation.set(0,0,0);root.scale.set(1,1,1);root.updateMatrixWorld(true);
      v.camera.position.set(0,0,4);v.camera.up.set(0,1,0);v.camera.lookAt(0,0,0);v.camera.updateMatrixWorld();await upload();
      await api.dx12Shader([reset,emission]);
      const ev={intensity:1,useDiffuseColor:1,emissionColor:[1,0,0],emissionMask:{texture:${JSON.stringify(maskPath)}}};
      await params([reset,emission],{emission:ev});const diffuse=await draw(),lit=sample(diffuse,0.75),dark=sample(diffuse,0.25);
      if(!(lit[1]>100&&lit[0]<5&&lit[2]<5&&dark.every(c=>c<5)))throw new Error('Diffuse mask/color/orientation incorrect '+JSON.stringify({lit,dark}));
      await params([reset,emission],{emission:{...ev,useDiffuseColor:0}});const custom=sample(await draw(),0.75);
      if(!(custom[0]>100&&custom[1]<5&&custom[2]<5))throw new Error('Emission color toggle failed');
      await params([reset,emission],{emission:{...ev,emissionMask:{texture:null}}});const clear=sample(await draw(),0.25);
      if(clear[1]<100)throw new Error('Unassigned mask must be white');
      await params([reset,emission],{emission:{...ev,emissionMask:{texture:'missing.png'}}});const missing=sample(await draw(),0.75);
      if(missing.some(c=>c>5))throw new Error('Missing mask must block emission');
      // A diffuse texture changes emission tint, but its flipped/offset UVs must
      // not change the independent mask orientation.
      const tex=new THREE.DataTexture(new Uint8Array([0,0,255,255]),1,1);tex.flipY=false;tex.offset.y=0.5;
      material.color.setRGB(1,1,1);material.map=tex;await upload();await params([reset,emission],{emission:ev});
      const mapped=await draw(),mappedLit=sample(mapped,0.75),mappedDark=sample(mapped,0.25);
      if(!(mappedLit[2]>100&&mappedLit[0]<5&&mappedLit[1]<5&&mappedDark.every(c=>c<5)))throw new Error('Diffuse texture or mask independence failed');
      return {linear:refs,blendSamples,expanded,lit,dark,custom,clear,missing,mappedLit};
    })()`);
    fs.mkdirSync('tests/out/function-library', {recursive:true});
    fs.writeFileSync('tests/out/function-library/editor.png', (await sw.webContents.capturePage()).toPNG());
    console.log('Function library UI/GPU passed:', JSON.stringify({ui,gpu}));
    clearTimeout(timeout);app.quit();
  } catch(error) { console.error(error);clearTimeout(timeout);app.exit(1); }
}));
import('../electron/main.js');
