// Repeatable real-GPU benchmark; timings are descriptive, not a hardware-specific CI gate.
const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mmd-zoom-')));
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_DX12_VALIDATION;
delete process.env.MMDCONV_SHOT;
const timer = setTimeout(() => {console.error('Zoom profile timed out');app.exit(1);}, 180000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<1500;i++) {
          const v=window.__viewer;
          if(v?.current && v.dx12.lastFrame && !v.dx12.busy && v.dx12.loadedKey.startsWith(v.current.object.uuid))break;
          await new Promise(r=>setTimeout(r,20));
        }
        const v=__viewer;v.dx12.enabled=false;v.controls.update=()=>false;
        const THREE=await import('three');
        const bounds=new THREE.Box3().setFromObject(v.current.object);
        window.__zoom={target:v.controls.target.clone(),offset:v.camera.position.clone().sub(v.controls.target),head:bounds.getCenter(new THREE.Vector3()).setY(bounds.max.y-bounds.getSize(new THREE.Vector3()).y*0.18)};
      })()`);
      const rows=[];
      const cases=[['full',0,0],['full',4,0],['full',64,0],['full',128,0],['portrait',4,0],['portrait',128,0],['close',0,0],['close',1,0],['close',2,0],['close',4,0],['close',64,0],['close',128,0],['close',4,1],['close-half',4,0]];
      for (const [view,rays,ao] of cases) {
        const row=await win.webContents.executeJavaScript(`(async()=>{
          const v=__viewer,z=__zoom,close=${view!=='full'},w=${view==='close-half'?640:1280},h=${view==='close-half'?450:900};
          v.camera.position.copy(close?z.head:z.target).addScaledVector(z.offset,close?${view==='portrait'?0.35:0.16}:1);
          v.camera.lookAt(close?z.head:z.target);v.camera.aspect=w/h;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
          const native=[],total=[];
          for(let i=0;i<48;i++){
            const data=v.dx12.frame(),f=new Float32Array(data,4);f[44]=w;f[45]=h;f[50]=${rays>0?1:0};f[51]=${ao};f[53]=0;f[54]=${rays||1};f[67]=0;
            const started=performance.now(),result=await api.dx12Render(data);
            if(i>=36){native.push(result.renderMs);total.push(performance.now()-started);}
          }
          native.sort((a,b)=>a-b);total.sort((a,b)=>a-b);
          return{view:${JSON.stringify(view)},rays:${rays},ao:${ao},width:w,height:h,nativeMedian:native[6],nativeMax:native.at(-1),totalMedian:total[6],gpu:v.dx12.capabilities.gpu};
        })()`);
        rows.push(row);console.log(JSON.stringify(row));
        const capture=await win.webContents.executeJavaScript("document.getElementById('dx12-canvas').toDataURL('image/png')");
        const folder=path.resolve('tests/out/dx12-zoom');fs.mkdirSync(folder,{recursive:true});
        fs.writeFileSync(path.join(folder,view+'-'+rays+'-'+ao+'.png'),Buffer.from(capture.split(',')[1],'base64'));
      }
      fs.writeFileSync(path.resolve('tests/out/dx12-zoom-profile.json'),JSON.stringify(rows,null,2));
      clearTimeout(timer);app.quit();
    } catch(e) {console.error(e);clearTimeout(timer);app.exit(1);}
  });
});
import('../electron/main.js');
