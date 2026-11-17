// Requires Windows 11, a DX12 Ultimate GPU, and npm run build:dx12.
// Exercises actual DXR acceleration structures / ray queries and shared GPU presentation.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mmd-dx12-test-')));
for(const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
process.env.MMDCONV_OPEN=path.resolve('tests/sample/complex.pmx');process.env.MMDCONV_DX12='1';
const errors=[];const timeout=setTimeout(()=>{console.error('DX12 UI test timed out');app.exit(1)},90000);
app.on('browser-window-created',(_event,win)=>{
  win.webContents.on('console-message',e=>{if(e.level==='error'||/CONTEXT_LOST|GL_INVALID/.test(e.message))errors.push(e.message);});
  win.webContents.once('did-finish-load',async()=>{
    try{
      // Pixel readback alone flushes Canvas2D and can hide a stale compositor surface.
      // Repeatedly switch a green viewport to grayscale AO and verify the displayed image.
      await win.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<1000;i++){if(window.__viewer?.current&&__viewer.dx12?.lastFrame&&!__viewer.dx12.busy)break;await new Promise(r=>setTimeout(r,25));}
        if(!window.__viewer?.dx12?.lastFrame)throw new Error('Native startup failed');
        if(document.getElementById('renderer-backend')||__viewer.renderer)throw new Error('A browser renderer must not remain');
        const THREE=await import('three');if(THREE.WebGLRenderer)throw new Error('The browser renderer bundle must not load');
        window.__dx12TestBackground=__viewer.scene.background.clone();__viewer.scene.background.setRGB(0,1,0);
        for(const e of document.querySelectorAll('.viewport-modes,.exposure-controls'))e.style.visibility='hidden';
      })()`);
      for(let cycle=0;cycle<3;cycle++)for(const debug of ['off','ao']){
        const rect=await win.webContents.executeJavaScript(`(async()=>{
          const v=__viewer,old=v.dx12.lastFrame.id;v.setCortaoDebug('${debug}');
          for(let i=0;i<1000;i++){if(v.dx12.lastFrame.id>old&&!v.dx12.busy)break;await new Promise(r=>setTimeout(r,25));}
          if(v.dx12.lastFrame.id<=old)throw new Error('Native frame did not advance');
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await new Promise(r=>setTimeout(r,100));
          const r=document.getElementById('canvas-host').getBoundingClientRect();return{x:Math.ceil(r.x+2),y:Math.ceil(r.y+2),width:Math.floor(r.width-4),height:Math.floor(r.height-4)};
        })()`);
        const pixels=(await win.webContents.capturePage(rect)).toBitmap();let colored=0;
        for(let i=0;i<pixels.length;i+=4)if(Math.abs(pixels[i]-pixels[i+1])>2||Math.abs(pixels[i+1]-pixels[i+2])>2)colored++;
        if(debug==='ao'&&colored!==0)throw new Error(`AO compositor retained ${colored} colored pixels (cycle ${cycle})`);
        if(debug==='off'&&colored<100)throw new Error('Normal compositor did not display the green background');
      }
      await win.webContents.executeJavaScript(`__viewer.scene.background.copy(window.__dx12TestBackground);__viewer.setCortaoDebug('off');for(const e of document.querySelectorAll('.viewport-modes,.exposure-controls'))e.style.visibility='';`);
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const check=(ok,message)=>{if(!ok)throw new Error(message)};
        const wait=async f=>{for(let i=0;i<1000;i++){if(f())return;const status=document.getElementById('renderer-status').textContent;if(status.startsWith('DX12:'))throw new Error(status);await new Promise(r=>setTimeout(r,25))}throw new Error('DX12 wait timed out: '+document.getElementById('renderer-status').textContent)};
        await wait(()=>window.__viewer?.dx12?.lastFrame&&!__viewer.dx12.busy);
        const v=__viewer;v.dx12.enabled=false;v.controls.enableDamping=false;v.controls.enabled=false;v.controls.target.set(0,0,0);v.controls.update=()=>false;
        const THREE=await import('three'),{nativeModel}=await import('./dx12.js');
        const model=new THREE.Group(),material=new THREE.MeshLambertMaterial({color:0xb8bdcc,side:THREE.DoubleSide});
        const floor=new THREE.Mesh(new THREE.PlaneGeometry(6,6),material);floor.rotation.x=-Math.PI/2;floor.position.y=-1;model.add(floor);
        const sphere=new THREE.Mesh(new THREE.SphereGeometry(1,32,20),material);model.add(sphere);
        const cube=new THREE.Mesh(new THREE.BoxGeometry(1,2,1),material);cube.position.set(-1.3,0,-0.5);model.add(cube);
        v.camera.position.set(3,2.7,5);v.camera.lookAt(0,0,0);v.camera.aspect=1;v.camera.near=0.1;v.camera.far=100;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
        await api.dx12Model(nativeModel(model));
        const render=async(options={})=>{
          const data=v.dx12.frame(),f=new Float32Array(data,4);
          f.set([...(options.direction??[0.3481553,0.6963106,0.6270597]),options.sun??10],32);f.set([1,1,1,options.ambient??4],36);f.set([1,1,1,0],40);
          f.set([options.width??160,options.height??160,options.softness??0.06,1],44);
          f.set([options.exposure??100,options.toon??0,options.shadow??0,options.ao??0],48);
          f.set([1,options.debug??0,options.rays??32,0],52);f.set([...(options.background??[0.03,0.03,0.03]),0],56);f.set([options.ground??-1,10,options.diagonal??7,options.outline??0],60);
          f[67]=options.aa??0;
          v.testFrame=await api.dx12Render(data);const c=document.getElementById('dx12-canvas');return c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        };
        const difference=(a,b)=>{let darker=0,changed=0,max=0;for(let i=0;i<a.length;i+=4){const d=a[i]-b[i];if(d>2)darker++;if(Math.abs(d)>2)changed++;max=Math.max(max,Math.abs(d))}return{darker,changed,max}};
        const lit=await render(),shadowed=await render({shadow:1}),shadow=difference(lit,shadowed);
        check(shadow.darker>100,'DXR must cast real contact shadows: '+JSON.stringify(shadow));
        const hard=await render({shadow:1,softness:0}),soft=difference(hard,shadowed);
        check(soft.changed>100,'Light angular radius must change penumbrae: '+JSON.stringify(soft));
        const direct=await render({ambient:0}),directAO=await render({ambient:0,ao:1});
        check(difference(direct,directAO).max===0,'AO must preserve direct light');
        const indirect=await render({sun:0}),indirectAO=await render({sun:0,ao:1}),ambient=difference(indirect,indirectAO);
        check(ambient.darker>100,'CORTAO must darken indirect light');
        const debug=await render({ao:1,debug:1}),exposedDebug=await render({ao:1,debug:1,exposure:1});
        check(difference(debug,exposedDebug).max===0,'Debug visibility must not depend on EV100');
        const raw=await render({ao:1,debug:2});check(raw.some((x,i)=>i%4===0&&x>36&&x<240),'Raw CORTAO must contain occlusion');
        material.emissive.setRGB(1,1,1);material.emissiveIntensity=3;await api.dx12Model(nativeModel(model));
        const emission=await render({sun:0,ambient:0}),emissionAO=await render({sun:0,ambient:0,ao:1});
        check(difference(emission,emissionAO).max===0,'AO must preserve emission');
        material.emissive.setRGB(0,0,0);await api.dx12Model(nativeModel(model));
        const toon=await render({toon:1}),outline=await render({toon:1,outline:2});
        check(difference(toon,outline).changed>50,'Native Toon hull outline must be visible');
        const oldPose=await render({shadow:1});cube.position.x-=1;await api.dx12Pose(nativeModel(model,true));
        check(difference(oldPose,await render({shadow:1})).changed>100,'A pose update must rebuild DXR geometry and its shadow');
        for(let i=0;i<12;i++)await render({width:160+i%3});
        const visible=await render({shadow:1});cube.material=new THREE.MeshLambertMaterial({color:0xffffff,opacity:0,transparent:true});await api.dx12Model(nativeModel(model));
        check(difference(visible,await render({shadow:1})).changed>100,'Invisible geometry must disappear from DXR');
        const invisible=await render({shadow:1});
        cube.material=new THREE.MeshLambertMaterial({transparent:true,alphaTest:0.5,map:new THREE.DataTexture(new Uint8Array([255,255,255,0]),1,1)});cube.material.map.needsUpdate=true;
        await api.dx12Model(nativeModel(model));
        check(difference(invisible,await render({shadow:1})).max===0,'Texture alpha holes must not cast opaque DXR shadows');
        const thin=new THREE.Group();thin.add(floor.clone());
        const card=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshLambertMaterial({color:0xffffff,side:THREE.FrontSide}));card.rotation.x=-Math.PI/2;thin.add(card);
        await api.dx12Model(nativeModel(thin));
        check(difference(await render(),await render({shadow:1})).darker>100,'A thin single-sided card must cast a shadow from either ray direction');
        const bc=new THREE.CompressedTexture([{width:4,height:4,data:new Uint8Array([0,248,0,248,0,0,0,0])}],4,4,THREE.RGB_S3TC_DXT1_Format);bc.needsUpdate=true;
        const textured=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshLambertMaterial({map:bc}));
        await api.dx12Model(nativeModel(textured));const compressed=await render();
        const rgba=new Uint8Array(4*4*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=255;rgba[i+3]=255;}
        textured.material.map=new THREE.DataTexture(rgba,4,4);textured.material.map.needsUpdate=true;
        await api.dx12Model(nativeModel(textured));check(difference(compressed,await render()).max<=1,'Native BC1 decoding must match RGBA pixels');
        const {runShadowCases}=await import('../tests/dx12-shadow-cases.js');
        const selfIntersection=await runShadowCases({viewer:v,THREE,nativeModel,render,difference,check});
        const temporalSelfIntersection=await runShadowCases({viewer:v,THREE,nativeModel,render:options=>render({...options,rays:4}),difference,check});
        const {runTemporalShadowCases}=await import('../tests/dx12-temporal-shadow-cases.js');
        const temporal=await runTemporalShadowCases({viewer:v,THREE,nativeModel,render,check});
        await api.dx12Model(nativeModel(new THREE.Group()));const clear=await render({background:[0.2,0.4,0.8]});
        check([124,170,231,255].every((value,i)=>Math.abs(clear[i]-value)<=1),'GPU presentation copy must preserve the native sRGB output bytes: '+Array.from(clear.slice(0,4)));
        await api.dx12Stop();return{shadow,penumbra:soft,ambient,selfIntersection,temporalSelfIntersection,temporal,exposureIndependent:true,emissionPreserved:true,poseUpdates:true,compressedDDS:true,emptyScene:true,resizes:12};
      })()`);
      if(errors.length)throw new Error(errors.join('\n'));console.log('DX12 GPU smoke passed:',JSON.stringify(result));clearTimeout(timeout);app.exit(0);
    }catch(e){console.error(e,errors);clearTimeout(timeout);app.exit(1);}
  });
});
import('../electron/main.js');
