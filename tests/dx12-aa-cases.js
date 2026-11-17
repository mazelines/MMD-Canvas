// GPU image oracles are rendered before the temporal sequence, so oracle renders
// cannot inadvertently reset the history being tested.
export async function runAACases(v) {
  const THREE=await import('three'),{nativeModel}=await import('../renderer/dx12.js');
  const check=(ok,message)=>{if(!ok)throw new Error(message)};
  const camera=(x=0)=>{v.camera.position.set(x,0,6);v.camera.up.set(0,1,0);v.camera.lookAt(x,0,0);v.camera.aspect=1;v.camera.near=0.1;v.camera.far=100;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();};
  const draw=async(o={})=>{
    const data=v.dx12.frame(),f=new Float32Array(data,4);
    f.set([0.3481553,0.6963106,0.6270597,o.sun??0,1,1,1,o.ambient??0,1,1,1,0],32);
    f.set([o.size??256,o.size??256,0.08,1,o.exposure??100,o.toon??0,o.shadow??0,o.ao??0,1,o.debug??0,o.rays??4,o.wire??0],44);
    f.set([...(o.background??[0,0,0]),0,-100,10,10,0,0,0,0,o.mode??1],56);
    f[72]=(o.sharpen??0)/100;
    const frame=await api.dx12Render(data),c=document.getElementById('dx12-canvas');
    return{frame,pixels:c.getContext('2d').getImageData(0,0,c.width,c.height).data};
  };
  const settle=async(o={},count=36)=>{let result;for(let i=0;i<count;i++)result=await draw(o);return result};
  const difference=(a,b)=>{let sum=0,max=0,large=0;for(let i=0;i<a.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(a[i+j]-b[i+j]);sum+=d;max=Math.max(max,d);if(d>32)large++}return{mean:sum/(a.length*0.75),max,large}};
  const downsample=p=>{const result=new Uint8ClampedArray(256*256*4);for(let y=0;y<256;y++)for(let x=0;x<256;x++)for(let c=0;c<4;c++){let sum=0;for(let j=0;j<4;j++)for(let i=0;i<4;i++)sum+=p[((y*4+j)*1024+x*4+i)*4+c];result[(y*256+x)*4+c]=sum/16}return result};
  camera();await api.dx12Model(nativeModel(new THREE.Group()));
  const backgrounds=[];
  for(const background of [[0.02,0.025,0.03],[0.2,0.4,0.8],[1,1,1],[1,0,0],[0,1,0],[0,0,1]]) {
    const expected=await draw({mode:0,background});
    for(const exposure of [1,100,10000]) {
      const actual=await settle({background,exposure},4),error=difference(actual.pixels,expected.pixels);
      check(error.max<=2,'Background color must survive AA and exposure: '+JSON.stringify({background,exposure,error}));
      backgrounds.push({background,exposure,error});
    }
  }
  // NVSharpen adds a directional luma detail term; a flat field detects no edges,
  // so the background must survive unchanged (±1 for float rounding).
  const flatBase=await draw({mode:0,background:[0.2,0.4,0.8]});
  const flatSharp=await draw({mode:0,background:[0.2,0.4,0.8],sharpen:100});
  check(difference(flatBase.pixels,flatSharp.pixels).max<=1,'Flat background must survive sharpening: '+JSON.stringify(difference(flatBase.pixels,flatSharp.pixels)));
  const material=new THREE.MeshLambertMaterial({color:0,emissive:0xffffff,emissiveIntensity:3,side:THREE.DoubleSide});
  const scene=new THREE.Group(),bars=new THREE.Group();scene.add(bars);
  for(let i=0;i<8;i++){const bar=new THREE.Mesh(new THREE.PlaneGeometry(0.018+i*0.003,3),material);bar.position.x=(i-3.5)*0.3;bar.rotation.z=0.32;bars.add(bar)}
  await api.dx12Model(nativeModel(scene));
  const reference=downsample((await draw({mode:0,size:1024})).pixels);
  const msaaError=difference((await draw({mode:0})).pixels,reference),aaErrors=[];
  for(const mode of [1,2,3]) {
    const staticImage=await settle({mode}),error=difference(staticImage.pixels,reference);
    const next=await draw({mode}),stability=difference(staticImage.pixels,next.pixels);
    check(!next.frame.aaReset&&!next.frame.aaAccumulating,'Static AA must finish convergence');
    check(error.mean<msaaError.mean,'Reconstruction must improve thin edges against a supersampled oracle: '+JSON.stringify({mode,error,msaaError}));
    // This adversarial scene contains mostly subpixel-width isolated strips. Keep
    // its image-wide temporal change below 1% of 8-bit range; the real-model
    // portrait has a separate, much tighter 0.2-level stability requirement.
    check(stability.mean<2,'Subpixel geometry must stay within the stability budget: '+JSON.stringify({mode,stability}));
    aaErrors.push({mode,error,stability});
  }
  // Combined rigid pose and camera motion, then an abrupt disocclusion.
  const positions=Array.from({length:8},(_,i)=>({camera:(i+1)*0.025,object:(i+1)*0.045}));positions.push({camera:0.2,object:1.8});
  const oracles=[];
  for(const step of positions){camera(step.camera);bars.position.x=step.object;await api.dx12Pose(nativeModel(scene,true));oracles.push(downsample((await draw({mode:0,size:1024})).pixels))}
  const motion=[];
  for(const mode of [1,2,3]) {
    camera();bars.position.x=0;await api.dx12Model(nativeModel(scene));await settle({mode});const errors=[];
    for(let i=0;i<positions.length;i++) {
      camera(positions[i].camera);bars.position.x=positions[i].object;await api.dx12Pose(nativeModel(scene,true));
      const actual=await draw({mode}),error=difference(actual.pixels,oracles[i]);
      check(!actual.frame.aaReset,'Ordinary pose/camera motion must reproject without resetting AA');
      check(error.mean<2.5,'Moving thin geometry must track its supersampled oracle: '+JSON.stringify({mode,i,error}));errors.push(error);
    }
    motion.push({mode,errors});
  }
  check((await draw({mode:1})).frame.aaReset,'Mode change must reset history');
  check((await draw({mode:1,size:257})).frame.aaReset,'Resize must reset history');
  await settle({mode:1});check((await draw({mode:1,exposure:50})).frame.aaReset,'Exposure edits must reset history');
  check((await draw({mode:1,debug:1})).frame.antialiasing==='MSAA 4x','AO debug must bypass temporal AA');
  check((await draw({mode:1,wire:1})).frame.antialiasing==='MSAA 4x','Wireframe must bypass temporal AA');
  check((await draw({mode:1})).frame.aaReset,'Returning from debug must reset history');
  // NVSharpen post-process on the finished composite, independent of reconstruction
  // history. MSAA is deterministic frame-to-frame, so per-pixel properties are
  // verified against a same-session unsharpened capture.
  camera();bars.position.x=0;await api.dx12Pose(nativeModel(scene,true));
  const plain=await settle({mode:1});
  const sharp50=await draw({mode:1,sharpen:50}),sharp100=await draw({mode:1,sharpen:100});
  check(!sharp50.frame.aaReset&&!sharp100.frame.aaReset,'Sharpen edits must not reset reconstruction history');
  check(sharp50.frame.sharpen===50&&sharp100.frame.sharpen===100,'Frame must report the sharpen amount');
  const edge50=difference(plain.pixels,sharp50.pixels),edge100=difference(plain.pixels,sharp100.pixels);
  check(edge100.mean>0.5,'Sharpening must visibly crisp thin edges: '+JSON.stringify(edge100));
  check(edge50.mean<edge100.mean,'Sharpen strength must scale monotonically: '+JSON.stringify({edge50,edge100}));
  const msaaPlain=await draw({mode:0}),msaaSharp=await draw({mode:0,sharpen:100});
  check(difference(msaaPlain.pixels,msaaSharp.pixels).mean>0.5,'Sharpening must also apply to the MSAA path');
  // NVSharpen's 5x5 luma support detects no edge inside a locally flat 5x5 RGB
  // neighborhood, so the detail term must vanish there (no halos in flat areas).
  let flatDrift=0;const sw=256;
  for(let y=0;y<sw;y++)for(let x=0;x<sw;x++)for(let c=0;c<3;c++){
    let mn=255,mx=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const v=msaaPlain.pixels[(Math.min(sw-1,Math.max(0,y+dy))*sw+Math.min(sw-1,Math.max(0,x+dx)))*4+c];
      mn=Math.min(mn,v);mx=Math.max(mx,v);
    }
    if(mn===mx&&Math.abs(msaaSharp.pixels[(y*sw+x)*4+c]-mn)>1)flatDrift++;
  }
  check(flatDrift===0,'Sharpening must not disturb locally flat neighborhoods: '+flatDrift);
  const debugPlain=await draw({mode:1,debug:1}),debugSharp=await draw({mode:1,debug:1,sharpen:100});
  check(difference(debugPlain.pixels,debugSharp.pixels).max===0,'AO debug must bypass sharpening');
  const sharpening={edge50,edge100,flatDrift,msaa:true,debugBypass:true};
  const shaded=new THREE.Group(),diffuse=new THREE.MeshLambertMaterial({color:0xb8bdcc,side:THREE.DoubleSide});
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(6,6),diffuse);floor.rotation.x=-Math.PI/2;floor.position.y=-1;shaded.add(floor);
  shaded.add(new THREE.Mesh(new THREE.SphereGeometry(1,32,20),diffuse));
  v.camera.position.set(3,2.7,5);v.camera.lookAt(0,0,0);v.camera.updateMatrixWorld();
  await api.dx12Model(nativeModel(shaded));const shading=[];
  for(const toon of [0,1]) {
    const direct=(await settle({toon,sun:10})).pixels,directAO=(await settle({toon,sun:10,ao:1})).pixels;
    check(difference(direct,directAO).max<=1,'DLAA CORTAO must preserve direct light');
    const ambient=(await settle({toon,ambient:10})).pixels,ambientAO=(await settle({toon,ambient:10,ao:1})).pixels;
    let darker=0;for(let i=0;i<ambient.length;i+=4)if(ambient[i]-ambientAO[i]>2)darker++;
    check(darker>100,'Jittered CORTAO must still darken indirect light');
    const shadowed=(await settle({toon,sun:10,shadow:1})).pixels,reference=(await settle({toon,sun:10,shadow:1,rays:128})).pixels;
    const shadowError=difference(shadowed,reference);
    check(shadowError.mean<3,'Jittered temporal shadows must match the high-ray reference: '+JSON.stringify(shadowError));
    check(difference(direct,shadowed).mean>0.5,'DLAA must retain visible DXR shadows');
    shading.push({toon,ambientDarkened:darker,shadowError});
  }
  return{backgrounds,msaaError,aaErrors,motion,sharpening,shading,modeResizeExposureReset:true,debugBypass:true};
}
