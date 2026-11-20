// Standalone AO regression: unoccluded planes/convex meshes must stay open,
// while nearby geometry must still cast contact occlusion.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-ao-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('CORTAO test timed out');app.exit(1)},90000);
const tag=process.env.MMDCONV_AO_CAPTURE||'current';
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  try{
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const wait=async()=>{for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('Startup timed out')};
      await wait();const v=__viewer;v.dx12.enabled=false;v.controls.update=()=>false;
      const THREE=await import('three'),{nativeModel}=await import('./dx12.js');
      const images={},cases=[],lighting=[];let size=512;
      const draw=async({debug=2,radius=0.1,ao=1}={})=>{
        const data=v.dx12.frame(),f=new Float32Array(data,4);f[35]=4;f[39]=4;f[43]=0.8;f[44]=f[45]=size;f[47]=radius;f[48]=100;f[50]=0;f[51]=ao;f[52]=1;f[53]=debug;f[67]=0;f[72]=0;
        await api.dx12Render(data);const c=document.getElementById('dx12-canvas');return c.getContext('2d').getImageData(0,0,size,size).data;
      };
      const shot=name=>{images[name]=document.getElementById('dx12-canvas').toDataURL('image/png')};
      // Capture the current real character before replacing it with controlled surfaces.
      const bounds=new THREE.Box3().setFromObject(v.current.object),center=bounds.getCenter(new THREE.Vector3()),height=bounds.getSize(new THREE.Vector3()).y;
      const head=center.clone().setY(bounds.max.y-height*0.18),offset=v.camera.position.clone().sub(v.controls.target);
      v.camera.position.copy(head).addScaledVector(offset,0.5);v.camera.lookAt(head);v.camera.aspect=1;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
      for(const debug of [2,1]){await draw({debug,radius:v.cortao.modelSize*0.02});shot('character-'+(debug===2?'raw':'filtered'));}
      const material=new THREE.MeshLambertMaterial({color:0xffffff,side:THREE.DoubleSide});
      const camera=(distance=6)=>{v.camera.position.set(0,0,distance);v.camera.up.set(0,1,0);v.camera.lookAt(0,0,0);v.camera.aspect=1;v.camera.near=distance/100;v.camera.far=distance*10;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();};
      const stats=(pixels,mask)=>{
        let count=0,dark=0,total=0,min=255;
        for(let y=8;y<size-8;y++)for(let x=8;x<size-8;x++){
          const i=(y*size+x)*4;
          // Ignore silhouette pixels, where screen-space information is incomplete.
          if(mask[i]<254||mask[i-16]<254||mask[i+16]<254||mask[i-size*16]<254||mask[i+size*16]<254)continue;
          count++;const p=pixels[i];total+=255-p;min=Math.min(min,p);if(p<250)dark++;
        }return{count,dark,darkFraction:dark/Math.max(count,1),meanOcclusion:total/Math.max(count,1),min};
      };
      for(const config of [
        {name:'plane',angle:0}, {name:'slanted-plane',angle:1.1},
        {name:'grazing-plane',angle:1.4}, {name:'tilted-normals',angle:0,tilt:true},
        {name:'interpolated-normals',vary:true}, {name:'normal-map',mapped:true},
        {name:'convex-low-poly',sphere:12}, {name:'convex-smooth',sphere:64},
        {name:'slanted-far',angle:1.1,scale:100}, {name:'slanted-small',angle:1.1,scale:0.001},
        {name:'slanted-2048',angle:1.1,size:2048},
      ]){
        size=config.size||512;const scale=config.scale||1;camera(6*scale);
        const geometry=config.sphere?new THREE.SphereGeometry(1,config.sphere,config.sphere/2):new THREE.PlaneGeometry(4,4,1,1);
        if(config.tilt){const n=geometry.attributes.normal;for(let i=0;i<n.count;i++)n.setXYZ(i,0.6,0,0.8);}
        if(config.vary){const n=geometry.attributes.normal;for(let i=0;i<n.count;i++)n.setXYZ(i,i%2?0.6:-0.6,0,0.8);}
        const mat=material.clone();
        if(config.mapped){mat.normalMap=new THREE.DataTexture(new Uint8Array([204,128,230,255]),1,1);mat.normalMap.needsUpdate=true;}
        const mesh=new THREE.Mesh(geometry,mat);mesh.rotation.y=config.angle||0;mesh.scale.setScalar(scale);
        await api.dx12Model(nativeModel(mesh));const mask=await draw({ao:0});
        for(const debug of [2,1]){const pixels=await draw({debug,radius:0.4*scale});const data=stats(pixels,mask);cases.push({name:config.name,debug,...data});shot(config.name+'-'+(debug===2?'raw':'filtered'));}
        if(config.tilt||config.vary||config.mapped){
          const off=await draw({debug:0,ao:0}),on=await draw({debug:0});let max=0;
          for(let i=0;i<on.length;i+=4)if(mask[i]===255)for(let j=0;j<3;j++)max=Math.max(max,Math.abs(on[i+j]-off[i+j]));
          lighting.push({name:config.name,max});
        }
      }
      // A thin real blocker remains visible above the receiver: increasing a
      // global bias or excluding an entire mesh would erase this contact.
      size=512;camera();const contact=new THREE.Group();
      contact.add(new THREE.Mesh(new THREE.PlaneGeometry(4,4),material));
      const blocker=new THREE.Mesh(new THREE.BoxGeometry(0.02,2,0.5),material);blocker.position.set(-0.5,0,0.26);contact.add(blocker);
      await api.dx12Model(nativeModel(contact));const mask=await draw({ao:0});
      const contactAO=stats(await draw({debug:1,radius:0.4}),mask);shot('thin-contact');
      await api.dx12Stop();return{cases,contactAO,lighting,images};
    })()`);
    const directory=path.resolve('tests/out/cortao',tag);fs.mkdirSync(directory,{recursive:true});
    for(const [name,url] of Object.entries(result.images))fs.writeFileSync(path.join(directory,name+'.png'),Buffer.from(url.split(',')[1],'base64'));
    delete result.images;fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(result,null,2));
    for(const c of result.cases){
      assert.ok(c.count>1000,'Fixture must cover the viewport: '+c.name);
      // CORTAO's quantized depth/mip sampling can reject one of 32 rays at a
      // small number of grazing pixels. The raw budget permits this <= 8/255
      // noise; the filtered surface may not develop visible acne (< 250).
      assert.ok(c.meanOcclusion<0.1&&c.min>=239&&c.darkFraction<(c.debug===2?0.02:0.0001),'Isolated surface must not occlude itself: '+JSON.stringify(c));
      if(['plane','tilted-normals','interpolated-normals','normal-map'].includes(c.name))assert.equal(c.min,255,'Lighting normals cannot create AO on a flat surface: '+c.name);
    }
    assert.ok(result.contactAO.darkFraction>0.05&&result.contactAO.min<200,'Thin contact occlusion must survive: '+JSON.stringify(result.contactAO));
    for(const c of result.lighting)assert.ok(c.max<=1,'AO must preserve the authored shading normal on an open plane: '+JSON.stringify(c));
    console.log('CORTAO surfaces passed:',JSON.stringify(result));clearTimeout(timeout);app.quit();
  }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
}));
import('../electron/main.js');
