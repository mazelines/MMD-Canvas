// Signed-depth regression on overlapping planes, using the shipped example shader.
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mmd-depth-rim-')));
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
const shader = JSON.parse(fs.readFileSync('Example/Zhuang Fangyi/shaders/Default_Toon.shader', 'utf8'));
const layer = shader.layers.find(layer => layer.name === 'DepthRimLight');
const timeout = setTimeout(() => { console.error('Depth rim timed out'); app.exit(1); }, 90000);
app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      for(let i=0;i<1500;i++){
        if(window.__viewer?.dx12.error)throw new Error(__viewer.dx12.error.message);
        if(window.__viewer?.current&&__viewer.dx12.lastFrame&&!__viewer.dx12.busy)break;
        await new Promise(r=>setTimeout(r,20));
      }
      const v=__viewer;v.dx12.enabled=false;v.controls.update=()=>false;
      const THREE=await import('three'),{nativeModel}=await import('./dx12.js');
      const {SHADER_EXAMPLES}=await import('./shader-stack-panel.js');
      const layer=${JSON.stringify(layer)};
      if(SHADER_EXAMPLES.find(x=>x.name==='DepthRimLight').code!==layer.code)throw new Error('Bundled and editor examples differ');
      const {packMaterialParams,parseStack}=await import('../src/core/shader-stack.js');
      const black={name:'Black',code:'void Black(inout ShadingContext ctx){ctx.color=0;}',enabled:true};
      await api.dx12Shader([black,layer]);
      const material=new THREE.MeshLambertMaterial({color:0xffffff,side:THREE.DoubleSide});
      const scene=new THREE.Group();
      const rear=new THREE.Mesh(new THREE.PlaneGeometry(4,4),material);
      const front=new THREE.Mesh(new THREE.PlaneGeometry(1,2),material);front.position.z=1;
      scene.add(rear,front);
      v.camera.position.set(0,0,6);v.camera.lookAt(0,0,0);v.camera.fov=50;v.camera.aspect=1;v.camera.near=.01;v.camera.far=100;
      v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
      await api.dx12Model(nativeModel(scene));await api.dx12MaterialStacks([0,0]);
      const stride=parseStack([layer]).slotCount;
      const params=async width=>api.dx12Params(packMaterialParams([{layers:[layer]}],
        [0,1].map(()=>({stackId:1,params:{[layer.id]:{width,bias:0,fade:.1,intensity:1,rimColor:[1,1,1]}}})),[0,1],stride,2).buffer);
      const draw=async(side=1,size=512)=>{
        const data=v.dx12.frame(),f=new Float32Array(data,4);
        f.set([side,0,side===0?1:0,0],32);f[39]=0;f[44]=f[45]=size;f[48]=100;f[50]=f[51]=f[53]=0;f.set([0,0,0,0],56);f[63]=0;f[67]=0;f[72]=0;
        await api.dx12Render(data);const c=document.getElementById('dx12-canvas');return c.getContext('2d').getImageData(0,0,size,size).data;
      };
      const pixelX=(x,z,size=512)=>Math.round((new THREE.Vector3(x,0,z).project(v.camera).x*.5+.5)*size);
      const brightness=(pixels,x,size=512)=>{
        let sum=0;for(let y=size/2-10;y<size/2+10;y++)sum+=pixels[(y*size+x)*4];return sum/20;
      };
      await params(3);const right=await draw(),left=await draw(-1),axial=await draw(0);
      const results={
        foregroundBlocker:brightness(right,pixelX(-.5,1)-2),
        fartherSurface:brightness(right,pixelX(.5,1)-2),
        background:brightness(right,pixelX(2,0)-2),
        oppositeSide:brightness(right,pixelX(-2,0)+2),
        reversedLight:brightness(left,pixelX(-2,0)+2),
        axial:axial.reduce((max,value,i)=>i%4===0?Math.max(max,value):max,0),
      };
      await params(0);const zero=await draw();results.zeroWidth=zero.reduce((max,value,i)=>i%4===0?Math.max(max,value):max,0);
      results.widths=[];
      for(const size of [512,1024])for(const width of [1,3]){
        await params(width);const pixels=await draw(1,size);let count=0;
        for(let x=pixelX(1.5,0,size);x<pixelX(2,0,size)+2;x++)if(brightness(pixels,x,size)>100)count++;
        results.widths.push({size,width,count});
      }
      rear.scale.x=3;await api.dx12Model(nativeModel(scene));await api.dx12MaterialStacks([0,0]);await params(3);
      results.viewportBorder=brightness(await draw(),510);
      return results;
    })()`);
    console.log('Depth rim GPU:', JSON.stringify(result));
    for (const key of ['foregroundBlocker', 'oppositeSide', 'axial', 'zeroWidth', 'viewportBorder']) assert.ok(result[key] <= 1, `${key} must remain dark`);
    for (const key of ['fartherSurface', 'background', 'reversedLight']) assert.ok(result[key] > 100, `${key} must receive a rim`);
    for (const {size,width,count} of result.widths) assert.ok(Math.abs(count - 3*width*size/1080) <= 1.5, `Linear resolution-scaled width: ${JSON.stringify({size,width,count})}`);
    clearTimeout(timeout); app.quit();
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
}));
import('../electron/main.js');
