// Viewport selection regression: object-level selection + GPU-mask picking accuracy +
// stable screen-space outer outline + AA stability + gesture latching + app wiring.
// Auto render loop is disabled so only test-controlled frames run; raw results are
// logged before assertions to preserve failure causes.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-selection-')));
for(const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('selection test timed out');app.exit(1)},180000);
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',async()=>{
  try{
    const r=await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<1500;i++){if(window.__viewer?.dx12.error)throw new Error(__viewer.dx12.error.message);if(window.__viewer?.current&&__viewer.dx12.lastFrame&&!__viewer.dx12.busy)break;await new Promise(r=>setTimeout(r,20));}
      const v=__viewer;v.controls.update=()=>false;v.dx12.enabled=false; // only test-controlled frames
      const appOnPick=v.onPick; // app.js wiring (object select + inspector edit target)
      const THREE=await import('three'),{nativeModel}=await import('./dx12.js'),{collectMaterials}=await import('./material-info.js');
      const {mergeGeometries}=await import('three/addons/utils/BufferGeometryUtils.js');
      const mat=()=>new THREE.MeshLambertMaterial({color:0x444444,side:THREE.DoubleSide});
      v.camera.position.set(0,0,6);v.camera.lookAt(0,0,0);v.camera.fov=50;v.camera.aspect=1;v.camera.near=.01;v.camera.far=100;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
      const out={};
      const setScene=object=>{object.updateMatrixWorld(true);v.current={object,materials:collectMaterials(object)};};
      const loadScene=async object=>{v.dx12.pickState=null;setScene(object);await api.dx12Model(nativeModel(object));const idx=[];nativeModel(object,false,null,null,idx);await api.dx12MaterialStacks(idx.map(()=>0));v.dx12.panelIndices=idx;};
      const draw=async(sel,mode=0)=>{v.dx12.objectSelected=sel;const data=v.dx12.frame(),f=new Float32Array(data,4);f[44]=f[45]=512;f[50]=f[51]=f[53]=0;f[59]=0;f[63]=0;f[67]=mode;f[72]=0;const info=await api.dx12Render(data);v.dx12.lastFrame=info;if(!v.dx12.pickState||v.dx12.pickState.gen!==info.modelGen||v.dx12.pickState.panelIndices!==v.dx12.panelIndices)v.dx12.pickState={gen:info.modelGen,panelIndices:v.dx12.panelIndices};const c=document.getElementById('dx12-canvas');return {info,pixels:c.getContext('2d').getImageData(0,0,512,512).data};};
      const pick=async(x=0,y=0)=>{const rect=v.canvas.getBoundingClientRect();let res={p:-1,h:false};v.onPick=(p,h)=>res={p,h};await v.pickAt(rect.left+rect.width*(x*.5+.5),rect.top+rect.height*(-y*.5+.5));return res;};
      const diff=(a,b)=>{let changed=0,max=0;for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);if(d>2)changed++;max=Math.max(max,d);}return {changed,max};};
      // Ring-geometry stability: XOR of orange-ring pixel sets (ignores DLSS scene
      // reconstruction noise, which is transient and stops once the app settles).
      const isOrange=(d,i)=>d[i]>200&&d[i+1]>90&&d[i+1]<200&&d[i+2]<120;
      const ringDiff=(a,b)=>{let x=0;for(let i=0;i<a.length;i+=4){if(isOrange(a,i)!==isOrange(b,i))x++;}return x;};
      const click=(fx,fy,type='pointerup')=>{const rect=v.canvas.getBoundingClientRect();v.canvas.dispatchEvent(new PointerEvent('pointerdown',{clientX:rect.left+rect.width*fx,clientY:rect.top+rect.height*fy,button:0,pointerId:7}));if(type==='pointerup')v.canvas.dispatchEvent(new PointerEvent('pointerup',{clientX:rect.left+rect.width*fx,clientY:rect.top+rect.height*fy,button:0,pointerId:7}));else v.canvas.dispatchEvent(new PointerEvent(type,{clientX:rect.left+rect.width*fx,clientY:rect.top+rect.height*fy,button:0,pointerId:7}));};
      // multi-mesh: click mesh B -> global panel index 1.
      const group=new THREE.Group(),a=new THREE.Mesh(new THREE.PlaneGeometry(1,2),mat()),b=new THREE.Mesh(new THREE.PlaneGeometry(1,2),mat());a.position.x=-1;b.position.x=1;group.add(a,b);
      await loadScene(group);await draw(false);
      const sb=new THREE.Vector3(1,0,0).project(v.camera);
      out.multiMesh=await pick(sb.x,sb.y);
      // alpha hole: transparent front (alpha 0) over opaque rear -> rear (1).
      const texture=new THREE.DataTexture(new Uint8Array([255,255,255,0]),1,1);texture.needsUpdate=true;
      const transparent=mat();transparent.transparent=true;transparent.map=texture;
      const geometry=mergeGeometries([new THREE.PlaneGeometry(2,2).translate(0,0,1),new THREE.PlaneGeometry(2,2)],true);
      await loadScene(new THREE.Mesh(geometry,[transparent,mat()]));await draw(false);
      out.alphaHole=await pick();
      // visible translucent (opacity .25) must be pickable.
      const semi=mat();semi.transparent=true;semi.opacity=.25;
      await loadScene(new THREE.Mesh(new THREE.PlaneGeometry(2,2),semi));await draw(false);
      out.translucent=await pick();
      // hidden front node not picked; rear (1) wins.
      const hiddenGroup=new THREE.Group();const front=new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat()),rear=new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat());front.position.z=1;front.visible=false;hiddenGroup.add(front,rear);
      await loadScene(hiddenGroup);await draw(false);
      out.hiddenObject=await pick();
      // gizmo release ordering must not leak a pick.
      let pickCalls=0;v.onPick=()=>pickCalls++;const rect=v.canvas.getBoundingClientRect();
      v.canvas.dispatchEvent(new PointerEvent('pointerdown',{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:0,pointerId:991}));
      v.lightControls.dragging=true;v.lightControls.axis='X';v.lightControls.pointerUp({button:0});
      v.canvas.dispatchEvent(new PointerEvent('pointerup',{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:0,pointerId:991}));
      await new Promise(r2=>setTimeout(r2,200));out.gizmoRelease={pickCalls};
      // long drag returning to start must not pick; pointercancel must not pick.
      pickCalls=0;
      v.canvas.dispatchEvent(new PointerEvent('pointerdown',{clientX:rect.left+10,clientY:rect.top+10,button:0,pointerId:992}));
      v.canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+200,clientY:rect.top+150,button:0,pointerId:992}));
      v.canvas.dispatchEvent(new PointerEvent('pointerup',{clientX:rect.left+10,clientY:rect.top+10,button:0,pointerId:992}));
      await new Promise(r2=>setTimeout(r2,200));out.dragReturn={pickCalls};
      pickCalls=0;
      v.canvas.dispatchEvent(new PointerEvent('pointerdown',{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:0,pointerId:993}));
      v.canvas.dispatchEvent(new PointerEvent('pointercancel',{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:0,pointerId:993}));
      await new Promise(r2=>setTimeout(r2,200));out.pointerCancel={pickCalls};
      // front plane + sphere outline visible.
      await loadScene(new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat()));
      const planeOff=await draw(false),planeOn=await draw(true);out.frontPlaneOutline=diff(planeOff.pixels,planeOn.pixels);
      await loadScene(new THREE.Mesh(new THREE.SphereGeometry(1,32,24),mat()));
      const sphereOff=await draw(false),sphereOn=await draw(true);out.sphereOutline=diff(sphereOff.pixels,sphereOn.pixels);
      // consecutive-frame ring stability while selected (non-jittered mask), per AA mode.
      out.stability=[];
      for(const mode of [0,1,2,3]){let prev=await draw(true,mode);let maxDiff=0;for(let i=0;i<8;i++){const cur=await draw(true,mode);maxDiff=Math.max(maxDiff,ringDiff(prev.pixels,cur.pixels));prev=cur;}out.stability.push({mode,maxDiff});}
      // temporal select/deselect ring stability.
      out.temporal=[];
      for(const mode of [1,2,3]){let baseline,settled;for(let i=0;i<36;i++)baseline=await draw(false,mode);const selected=await draw(true,mode);for(let i=0;i<36;i++)settled=await draw(true,mode);const deselected=await draw(false,mode);out.temporal.push({mode,selectedVsSettled:ringDiff(selected.pixels,settled.pixels),deselectedVsBaseline:ringDiff(deselected.pixels,baseline.pixels)});}
      // REAL app wiring: click object -> objectSelected + inspector edit target; Esc/empty clear.
      v.onPick=appOnPick;await loadScene(new THREE.Mesh(new THREE.SphereGeometry(1,32,24),mat()));await draw(false);
      click(.5,.5);await new Promise(r2=>setTimeout(r2,300));
      out.realClick={objectSelected:v.dx12.objectSelected,inspectorSelected:window.__materialPanel?window.__materialPanel.selected:null};
      window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape'}));await new Promise(r2=>setTimeout(r2,100));
      out.esc={objectSelected:v.dx12.objectSelected};
      click(.5,.5);await new Promise(r2=>setTimeout(r2,300));
      click(.02,.02);await new Promise(r2=>setTimeout(r2,300));
      out.emptyClick={objectSelected:v.dx12.objectSelected};
      // stale mask: model B uploaded but not rendered -> pick must read empty, not A's mask.
      await loadScene(new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat()));await draw(false);
      const sideB=new THREE.Mesh(new THREE.PlaneGeometry(.5,.5),mat());sideB.position.x=2;
      await api.dx12Model(nativeModel(sideB));v.dx12.panelIndices=[0]; // no render yet
      out.stalePick=await pick();
      await draw(false);out.afterBFrame=await pick();
      // second material click drives inspector edit target to panel index 1.
      const g2=new THREE.Group(),mA=new THREE.Mesh(new THREE.PlaneGeometry(1,2),mat()),mB=new THREE.Mesh(new THREE.PlaneGeometry(1,2),mat());mA.position.x=-1;mB.position.x=1;g2.add(mA,mB);
      await loadScene(g2);await draw(false);v.onPick=appOnPick;
      const sB=new THREE.Vector3(1,0,0).project(v.camera);
      click(sB.x*.5+.5,.5);await new Promise(r2=>setTimeout(r2,300));
      out.secondMaterial={objectSelected:v.dx12.objectSelected,inspectorSelected:window.__materialPanel.selected};
      // IPC-timing regressions via real viewer.pickAt wiring (3 cases).
      const rectD=v.canvas.getBoundingClientRect();
      const clickAt=fx=>v.pickAt(rectD.left+rectD.width*fx,rectD.top+rectD.height*0.5);
      // 1) unchanged-frame: a normal frame advance must NOT cancel a valid click.
      await loadScene(g2);await draw(false);
      let c1=0,last1;v.onPick=(p,h)=>{c1++;last1={p,h};};
      const rp=draw(false);const pp=clickAt(0.25);await rp;await pp;await new Promise(r2=>setTimeout(r2,100));
      out.unchangedFrame={calls:c1,last:last1};
      // 2) rebuild-before-frame: delayed response during rebuild -> no callback; new frame click ok.
      await loadScene(g2);await draw(false);
      let c2=0;v.onPick=()=>c2++;
      const p2=clickAt(0.25);
      v.dx12.pickState=null;v.invalidatePick();v.dx12.panelIndices=[1];
      await p2;await new Promise(r2=>setTimeout(r2,100));
      const beforeCalls=c2;
      await loadScene(g2);await draw(false);
      let last2b;v.onPick=(p,h)=>{last2b={p,h};};
      await clickAt(0.75);await new Promise(r2=>setTimeout(r2,100));
      out.rebuildBefore={beforeCalls,after:last2b};
      // 3) rebuild-after-frame: rebuild completes a new frame, delayed old response -> no callback.
      await loadScene(g2);await draw(false);
      let c3=0;v.onPick=()=>c3++;
      const p3=clickAt(0.25);
      await loadScene(g2);await draw(false);
      await p3;await new Promise(r2=>setTimeout(r2,100));
      out.rebuildAfter={calls:c3};
      v.onPick=appOnPick;
      // ring width symmetry on center row (left cluster == right cluster), per mode.
      await loadScene(new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat()));
      out.ringWidth=[];
      for(const mode of [0,1,2,3]){const {pixels}=await draw(true,mode);const row=256;const orange=[];for(let x=0;x<512;x++){const i=(row*512+x)*4;orange.push(pixels[i]>200&&pixels[i+1]>90&&pixels[i+1]<200&&pixels[i+2]<120);}
        let L=0,Rt=0;for(let x=0;x<256;x++)if(orange[x])L++;for(let x=256;x<512;x++)if(orange[x])Rt++;
        out.ringWidth.push({mode,left:L,right:Rt});}
      return out;
    })()`);
    console.log('SELECTION RAW:'+JSON.stringify(r));
    assert.equal(r.multiMesh.p,1,'multi-mesh global index 1: '+JSON.stringify(r.multiMesh));
    assert.equal(r.alphaHole.p,1,'alpha hole rear: '+JSON.stringify(r.alphaHole));
    assert.ok(r.translucent.h,'visible translucent pickable: '+JSON.stringify(r.translucent));
    assert.equal(r.hiddenObject.p,1,'hidden front excluded: '+JSON.stringify(r.hiddenObject));
    assert.equal(r.gizmoRelease.pickCalls,0,'gizmo release no pick');
    assert.equal(r.dragReturn.pickCalls,0,'drag return no pick');
    assert.equal(r.pointerCancel.pickCalls,0,'pointercancel no pick');
    assert.ok(r.frontPlaneOutline.changed>100,'plane outline: '+JSON.stringify(r.frontPlaneOutline));
    assert.ok(r.sphereOutline.changed>100,'sphere outline: '+JSON.stringify(r.sphereOutline));
    for(const s of r.stability)assert.ok(s.maxDiff<=8,'ring stable mode '+s.mode+': '+s.maxDiff);
    for(const t of r.temporal){assert.ok(t.selectedVsSettled<=8,'no ghost select mode '+t.mode+': '+t.selectedVsSettled);assert.ok(t.deselectedVsBaseline<=8,'no ghost deselect mode '+t.mode+': '+t.deselectedVsBaseline);}
    assert.ok(r.realClick.objectSelected,'real click selects object');
    assert.equal(r.esc.objectSelected,false,'Esc clears');
    assert.equal(r.emptyClick.objectSelected,false,'empty click clears');
    assert.equal(r.stalePick.h,false,'stale mask before first frame reads empty: '+JSON.stringify(r.stalePick));
    assert.equal(r.afterBFrame.h,false,'side model center empty after frame: '+JSON.stringify(r.afterBFrame));
    assert.ok(r.secondMaterial.objectSelected,'second material click selects object');
    assert.equal(r.secondMaterial.inspectorSelected,1,'inspector edit target = panel 1: '+JSON.stringify(r.secondMaterial));
    assert.equal(r.unchangedFrame.calls,1,'normal frame advance keeps valid click: '+JSON.stringify(r.unchangedFrame));
    assert.ok(r.unchangedFrame.last&&r.unchangedFrame.last.h,'unchanged-frame click hit: '+JSON.stringify(r.unchangedFrame));
    assert.equal(r.rebuildBefore.beforeCalls,0,'rebuild-before-frame delayed response no callback');
    assert.ok(r.rebuildBefore.after&&r.rebuildBefore.after.h&&r.rebuildBefore.after.p===1,'new frame click p=1: '+JSON.stringify(r.rebuildBefore));
    assert.equal(r.rebuildAfter.calls,0,'rebuild-after-frame delayed response no callback');
    for(const w of r.ringWidth){assert.equal(w.left,w.right,'ring symmetric mode '+w.mode+': '+JSON.stringify(w));assert.ok(w.left>=1&&w.right>=1,'ring present both sides mode '+w.mode);}
    console.log('Viewport selection regression passed');
    clearTimeout(timeout);app.quit();
  }catch(e){console.error(e);clearTimeout(timeout);app.exit(1)}
}));
import('../electron/main.js');
