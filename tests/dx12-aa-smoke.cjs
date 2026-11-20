// Real NVIDIA RTX integration test: reconstruction modes, static stability and zoom timings.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-dlss-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
if(process.argv.includes('--validation'))process.env.MMDCONV_DX12_VALIDATION='1';
const timeout=setTimeout(()=>{console.error('DLSS test timed out');app.exit(1)},180000);
async function missingRuntimeFallback(win) {
  const directory=fs.mkdtempSync(path.resolve('.cache/dlss-no-runtime-'));
  for(const name of fs.readdirSync('out/dx12').filter(name=>/\.(exe|cso|bin)$/.test(name)))fs.copyFileSync(path.join('out/dx12',name),path.join(directory,name));
  const packets=await win.webContents.executeJavaScript(`(async()=>{const THREE=await import('three'),{nativeModel}=await import('./dx12.js');const frame=__viewer.dx12.frame(),f=new Float32Array(frame,4);f[44]=f[45]=64;f[67]=1;return{model:Array.from(new Uint8Array(nativeModel(new THREE.Group()))),frame:Array.from(new Uint8Array(frame))}})()`);
  return new Promise((resolve,reject)=>{
    const child=require('node:child_process').spawn(path.join(directory,'mmd-dx12.exe'),['--serve',String(process.pid)],{windowsHide:true});
    let buffer='',result;const timer=setTimeout(()=>{child.kill();reject(new Error('Fallback timed out'))},30000);
    const send=(type,data)=>{const header=Buffer.alloc(8),payload=Buffer.from(data);header.writeUInt32LE(type);header.writeUInt32LE(payload.length,4);child.stdin.write(Buffer.concat([header,payload]))};
    child.on('error',reject);child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);
      if(message.type==='ready'){assert.equal(message.capabilities.dlss,false);assert.match(message.capabilities.dlssReason,/runtime/);send(1,packets.model)}
      else if(message.type==='model')send(2,packets.frame);
      else if(message.type==='frame'){assert.equal(message.antialiasing,'MSAA 4x');result=message;child.stdin.end()}
      else if(message.type==='error')throw new Error(message.error);
    }catch(error){child.kill();reject(error)}}});
    child.on('exit',code=>{clearTimeout(timer);if(code===0&&result)resolve(result);else reject(new Error('Fallback failed: '+code))});
  });
}
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  try {
    const startup=await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<1500;i++){
        const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);
        if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return{caps:v.dx12.capabilities,frame:v.dx12.lastFrame};
        await new Promise(r=>setTimeout(r,20));
      }throw new Error('Startup did not converge');
    })()`);
    assert.ok(startup.caps.dlss,'This test requires DLSS support on an NVIDIA RTX GPU');
    assert.equal(startup.frame.antialiasing,'DLAA');assert.equal(startup.frame.aaAccumulating,false);
    await win.webContents.executeJavaScript(`(async()=>{
      const v=__viewer;v.dx12.enabled=false;v.controls.update=()=>false;
      v.setCortao({enabled:true,intensity:1,radius:2});v.setAmbientIntensity(3);v.setSkyDirectionality(0.8);
      const THREE=await import('three'),b=new THREE.Box3().setFromObject(v.current.object);
      const head=b.getCenter(new THREE.Vector3()).setY(b.max.y-b.getSize(new THREE.Vector3()).y*0.18),offset=v.camera.position.clone().sub(v.controls.target);
      v.camera.position.copy(head).addScaledVector(offset,0.35);v.camera.lookAt(head);v.camera.aspect=1280/900;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
    })()`);
    fs.mkdirSync('tests/out/dlss',{recursive:true});const results=[];
    for(const mode of [0,1,2,3]) {
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const v=__viewer,times=[];let frame;
        // Reconstruction gate: measure reconstruction alone. Sharpening amplifies
        // residual temporal fluctuation and has its own budget below.
        const draw=async()=>{const data=v.dx12.frame(),f=new Float32Array(data,4);f[44]=1280;f[45]=900;f[67]=${mode};f[72]=0;return api.dx12Render(data)};
        for(let i=0;i<44;i++){frame=await draw();if(i>=32)times.push(frame.renderMs);}
        const c=document.getElementById('dx12-canvas'),ctx=c.getContext('2d'),a=ctx.getImageData(0,0,c.width,c.height).data;
        frame=await draw();const b=ctx.getImageData(0,0,c.width,c.height).data;let sum=0,max=0;
        for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const delta=Math.abs(a[i+j]-b[i+j]);sum+=delta;max=Math.max(max,delta);}
        times.sort((a,b)=>a-b);return{mode:${mode},frame,median:times[6],stability:{mean:sum/(a.length/4*3),max},png:c.toDataURL('image/png')};
      })()`);
      assert.equal(result.frame.width,1280);assert.equal(result.frame.height,900);
      assert.equal(result.frame.antialiasing,['MSAA 4x','DLAA','DLSS Quality','DLSS Balanced'][mode]);
      assert.equal(result.frame.aaAccumulating,false);
      assert.equal(result.frame.renderWidth===1280,mode<=1);
      assert.ok(result.stability.mean<0.2,'Static reconstruction must be stable: '+JSON.stringify(result.stability));
      fs.writeFileSync(`tests/out/dlss/mode-${mode}.png`,Buffer.from(result.png.split(',')[1],'base64'));delete result.png;
      results.push(result);console.log('DLSS mode:',JSON.stringify(result));
    }
    const sharpen=await win.webContents.executeJavaScript(`(async()=>{
      const v=__viewer,records=[];let base=null;
      for(const amount of [0,50,100]){
        let frame;const draw=async()=>{const data=v.dx12.frame(),f=new Float32Array(data,4);f[44]=1280;f[45]=900;f[67]=1;f[72]=amount/100;return api.dx12Render(data)};
        for(let i=0;i<44;i++)frame=await draw();
        const c=document.getElementById('dx12-canvas'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let mean=0;if(base){let sum=0;for(let i=0;i<pixels.length;i+=4)for(let j=0;j<3;j++)sum+=Math.abs(pixels[i+j]-base[i+j]);mean=sum/(pixels.length*0.75)}else base=pixels;
        records.push({amount,frame,mean,png:c.toDataURL('image/png')});
      }
      return records;
    })()`);
    for(const record of sharpen){
      assert.equal(record.frame.sharpen,record.amount);
      assert.equal(record.frame.antialiasing,'DLAA');
      assert.equal(record.frame.aaAccumulating,false);
      fs.writeFileSync(`tests/out/dlss/sharpen-${record.amount}.png`,Buffer.from(record.png.split(',')[1],'base64'));delete record.png;
    }
    assert.ok(sharpen[1].mean>0&&sharpen[2].mean>sharpen[1].mean,'Sharpening must scale with strength on the real model: '+JSON.stringify(sharpen.map(r=>({amount:r.amount,mean:r.mean}))));
    console.log('DLSS sharpen:',JSON.stringify(sharpen.map(({amount,mean,frame})=>({amount,mean,renderMs:frame.renderMs}))));
    // Sharpened static output: NVSharpen amplifies residual reconstruction
    // fluctuation (~2x at 50%), so the sharpen-inclusive temporal budget is
    // separate from the reconstruction gate above.
    const sharpenStability=[];
    for(const mode of [1,2,3]) {
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const v=__viewer;const draw=async()=>{const data=v.dx12.frame(),f=new Float32Array(data,4);f[44]=1280;f[45]=900;f[67]=${mode};f[72]=0.5;return api.dx12Render(data)};
        for(let i=0;i<44;i++)await draw();
        const c=document.getElementById('dx12-canvas'),ctx=c.getContext('2d'),a=ctx.getImageData(0,0,c.width,c.height).data;
        await draw();const b=ctx.getImageData(0,0,c.width,c.height).data;let sum=0,max=0;
        for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);sum+=d;max=Math.max(max,d);}
        return{mode:${mode},mean:sum/(a.length/4*3),max};
      })()`);
      assert.ok(result.mean<0.3,'Sharpened static output must stay within the temporal amplification budget: '+JSON.stringify(result));
      sharpenStability.push(result);
    }
    console.log('DLSS sharpen stability:',JSON.stringify(sharpenStability));
    const cases=await win.webContents.executeJavaScript(`(async()=>{const {runAACases}=await import('../tests/dx12-aa-cases.js');return runAACases(__viewer)})()`);
    console.log('DLSS reconstruction cases:',JSON.stringify(cases));
    const fallback=await missingRuntimeFallback(win);console.log('Missing DLSS runtime fallback:',fallback.antialiasing);
    fs.writeFileSync('tests/out/dlss/results.json',JSON.stringify({startup,results,sharpen,sharpenStability,cases,fallback},null,2));
    clearTimeout(timeout);app.quit();
  }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
}));
import('../electron/main.js');
