// Real GPU end-to-end test: runtime-compile a user shader stack, hot-swap the
// character color PSOs, verify the pixels change, restore the default, and
// surface compiler errors without killing the renderer.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-stack-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('Shader stack test timed out');app.exit(1)},180000);
const RIM=`//@property float strength = 0.5 [0,1] "강도"
//@property float3 tint = (1,0,0) "색상"
void RimLight(inout ShadingContext ctx) {
    float rim = pow(1 - saturate(dot(ctx.normal, ctx.viewDir)), 3);
    ctx.color += tint * rim * strength;
}`;
const DEPTH_RIM=`//@property float width = 1.0 [0,3] "림 폭"
//@property float bias = 0.1 [0,1] "깊이 임계값"
//@property float fade = 0.3 [0.01,1] "전이 폭"
//@property float intensity = 1.0 [0,2] "강도"
//@property float3 rimColor = (1,1,1) "림 색상"
void DepthRimLight(inout ShadingContext ctx) {
    float2 offsetBase = ctx.lightDirScreen / max(ctx.depth, 0.001);
    float2 offsetUV = offsetBase * (3.0 * width) * (width * width);
    float neighborDepth = sampleSceneDepth(ctx.pixel + offsetUV * ctx.viewportSize);
    float rel = abs(neighborDepth - ctx.depth) / max(ctx.depth, 0.001);
    float mask = saturate((rel - bias) / max(fade, 1e-5));
    ctx.color += rimColor * mask * intensity;
}`;
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  try {
    await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}
      throw new Error('Startup did not converge');
    })()`);
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const v=__viewer;v.dx12.enabled=false;v.controls.update=()=>false;
      const THREE=await import('three'),b=new THREE.Box3().setFromObject(v.current.object);
      const head=b.getCenter(new THREE.Vector3()).setY(b.max.y-b.getSize(new THREE.Vector3()).y*0.18),offset=v.camera.position.clone().sub(v.controls.target);
      v.camera.position.copy(head).addScaledVector(offset,0.5);v.camera.lookAt(head);v.camera.aspect=1;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
      const draw=async()=>{const data=v.dx12.frame(),f=new Float32Array(data,4);f[44]=256;f[45]=256;f[67]=0;f[50]=0;f[51]=0;f[72]=0;await api.dx12Render(data);const c=document.getElementById('dx12-canvas');return c.getContext('2d').getImageData(0,0,c.width,c.height).data;};
      const diff=(a,b)=>{let sum=0,max=0;for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);sum+=d;max=Math.max(max,d);}return{mean:sum/(a.length*0.75),max};};
      const {packMaterialParams,parseStack}=await import('../src/core/shader-stack.js');
      // Route every native material to the base shader (0) so the opcode-6 base
      // hot-swap affects the whole character, and pack params per materialId*stride.
      await api.dx12MaterialStacks(new Array(256).fill(0));
      const packFor=(layer,vals)=>{const stride=parseStack([layer]).slotCount;const lib=[{layers:[layer]}],inst=[],pi=[];for(let i=0;i<256;i++){inst.push({stackId:1,params:{[layer.id]:vals}});pi.push(i);}return packMaterialParams(lib,inst,pi,stride,256).buffer;};
      const layer={id:'rim',name:'RimLight',code:${JSON.stringify(RIM)},enabled:true};
      const baseline=await draw();
      // Apply a user rim-light layer; the color PSOs hot-swap to the compiled stack.
      const load=await api.dx12Shader([layer]);
      await api.dx12Params(packFor(layer,{strength:0.5,tint:[1,0,0]}));
      const rimmed=await draw();
      const rimError=diff(baseline,rimmed);
      // Modulate properties without recompiling: stronger green rim must differ.
      await api.dx12Params(packFor(layer,{strength:1.0,tint:[0,1,0]}));
      const modulated=await draw();
      const paramError=diff(rimmed,modulated);
      // Depth-based rim light: samples neighbor scene depth along the light dir.
      const depthLayer={id:'depth',name:'DepthRimLight',code:${JSON.stringify(DEPTH_RIM)},enabled:true};
      const depthLoad=await api.dx12Shader([depthLayer]);
      await api.dx12Params(packFor(depthLayer,{width:2.0,bias:0.05,fade:0.2,intensity:2.0}));
      const depthRimmed=await draw();
      const depthError=diff(baseline,depthRimmed);
      // Restore the build-time default; pixels must return to baseline.
      const reset=await api.dx12Shader([]);
      const restored=await draw();
      const restoreError=diff(baseline,restored);
      // A compiler error must reject without killing the renderer.
      let compileError=null;
      try{await api.dx12Shader([{name:'Bad',code:'void Bad(inout ShadingContext ctx){ not valid hlsl }',enabled:true}]);}
      catch(e){compileError=e.message;}
      const afterError=await draw();
      const stillWorks=diff(baseline,afterError);
      // Review the actual character with AO, direct DXR shadows and directional
      // sky together, on both built-in material paths (DLAA after convergence).
      const skyImages={},skyDifferences=[];
      for(const stackId of [0,1]){
        await api.dx12MaterialStacks(new Array(256).fill(stackId));
        let previous=null;
        for(const side of [-1,1]){
          const dir=new THREE.Vector3(side*0.8,0.4,0.5).normalize();
          for(let i=0;i<16;i++){
            const data=v.dx12.frame(),f=new Float32Array(data,4);
            f.set([...dir.toArray(),3],32);f[39]=3;f[43]=0.8;
            f[44]=f[45]=640;f[48]=100;f[50]=f[51]=1;f[52]=1;f[53]=0;f[54]=4;f[67]=1;f[72]=0;
            await api.dx12Render(data);
          }
          const c=document.getElementById('dx12-canvas');
          const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          if(previous)skyDifferences.push({stackId,...diff(previous,pixels)});previous=pixels;
          skyImages['character-'+(stackId?'toon':'standard')+'-'+(side>0?'right':'left')]=c.toDataURL('image/png');
        }
      }
      return{load,reset,rimError,paramError,depthLoad,depthError,restoreError,compileError,stillWorks,skyImages,skyDifferences};
    })()`);
    assert.ok(result.load.active===true,'Shader stack must become active');
    assert.ok(result.rimError.mean>0.2&&result.rimError.max>20,'User rim light must visibly change the character: '+JSON.stringify(result.rimError));
    assert.ok(result.paramError.mean>0.2,'Property modulation must change the result without recompiling: '+JSON.stringify(result.paramError));
    assert.ok(result.depthLoad.active===true,'DepthRimLight must compile (sampleSceneDepth helper available)');
    assert.ok(result.depthError.mean>0.2&&result.depthError.max>20,'Depth-based rim must visibly change the silhouette: '+JSON.stringify(result.depthError));
    assert.ok(result.reset.active===false,'Empty stack must restore the default');
    assert.ok(result.restoreError.max<=1,'Restored default must match baseline: '+JSON.stringify(result.restoreError));
    assert.ok(result.compileError,'Invalid HLSL must surface a compiler error');
    assert.ok(result.stillWorks.max<=1,'Renderer must survive a compile error and keep the default: '+JSON.stringify(result.stillWorks));
    for(const d of result.skyDifferences)assert.ok(d.mean>1,'Character lighting must follow sun direction: '+JSON.stringify(d));
    fs.mkdirSync('tests/out/directional-ambient',{recursive:true});
    for(const [name,url] of Object.entries(result.skyImages))fs.writeFileSync('tests/out/directional-ambient/'+name+'.png',Buffer.from(url.split(',')[1],'base64'));
    console.log('Shader stack end-to-end passed:',JSON.stringify({rimError:result.rimError,restoreError:result.restoreError,compileError:result.compileError.slice(0,120)}));
    clearTimeout(timeout);app.quit();
  }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
}));
import('../electron/main.js');
