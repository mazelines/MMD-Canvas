// Image tests isolate ambient directionality from direct sunlight and validate
// bent-normal orientation at known world-space points, including camera motion.
export async function runDirectionalAmbientCases({viewer:v,THREE,nativeModel,render,difference,check}) {
  const camera=(x=0)=>{
    v.camera.position.set(x,0,6);v.camera.up.set(0,1,0);v.camera.lookAt(0,0,0);
    v.camera.aspect=1;v.camera.near=0.1;v.camera.far=100;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();
  };
  camera();
  const options={width:256,height:256,sun:0,ambient:4,exposure:30,skyDirectionality:1,radius:1.5,background:[0,0,0]};
  const draw=o=>render({...options,...o});
  const sample=(pixels,point=[0,0,0])=>{
    const p=new THREE.Vector3(...point).project(v.camera),x=Math.round((p.x*0.5+0.5)*256-0.5),y=Math.round((0.5-p.y*0.5)*256-0.5);
    const rgb=[0,0,0];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(let c=0;c<3;c++)rgb[c]+=pixels[((y+dy)*256+x+dx)*4+c]/9;
    return rgb;
  };
  const images={},shot=name=>{images[name]=document.getElementById('dx12-canvas').toDataURL('image/png');};
  const material=new THREE.MeshLambertMaterial({color:0xffffff,side:THREE.DoubleSide});
  const receiver=new THREE.Mesh(new THREE.PlaneGeometry(4,4),material);
  await api.dx12Model(nativeModel(receiver));await api.dx12MaterialStacks(new Array(256).fill(0));
  const toward=await draw({direction:[0,0,1]}),away=await draw({direction:[0,0,-1]});
  const sunResponse=sample(toward)[0]-sample(away)[0];
  check(sunResponse>25,'Directional sky must respond to the sun with direct lux zero: '+sunResponse);
  check(difference(await draw({direction:[0,0,1],skyDirectionality:0}),await draw({direction:[0,0,-1],skyDirectionality:0})).max===0,'Zero sky directionality must remove sun dependence');
  // The same field reaches the built-in ToonFill layer, which used to replace it.
  await api.dx12MaterialStacks(new Array(256).fill(1));
  const toonResponse=sample(await draw({direction:[0,0,1]}))[0]-sample(await draw({direction:[0,0,-1]}))[0];
  check(toonResponse>25,'Default Toon must retain directional sky: '+toonResponse);
  await api.dx12MaterialStacks(new Array(256).fill(0));
  const scene=new THREE.Group();scene.add(receiver);
  const wall=new THREE.Mesh(new THREE.BoxGeometry(0.25,3,1.5),material);wall.position.set(-0.9,0,0.8);scene.add(wall);
  await api.dx12Model(nativeModel(scene));
  const near=[-0.45,0,0],far=[1.4,0,0];
  const raw=await draw({ao:1,debug:2,direction:[1,0,0]});
  check(difference(raw,await draw({ao:1,debug:2,direction:[-1,0,0]})).max===0,'Geometry-only AO must not rotate with sunlight');
  const normals=await draw({ao:0,debug:3});
  const bent=await draw({ao:1,debug:3});shot('bent-normal');
  const normalNear=sample(normals,near),bentNear=sample(bent,near),bentFar=sample(bent,far);
  check(bentNear[0]>normalNear[0]+5,'Bent normal must point away from the wall toward open +X: '+JSON.stringify({normalNear,bentNear,bentFar}));
  check(Math.abs(bentFar[0]-128)<5&&bentFar[2]>250,'Open surface must retain its exact normal: '+bentFar);
  check(difference(bent,await draw({ao:1,debug:3,direction:[-1,0,0],exposure:1})).max===0,'Bent debug must be independent of light and exposure');
  camera(0.8);
  const movedBent=sample(await draw({ao:1,debug:3}),near);
  check(movedBent[0]>normalNear[0]+5&&Math.abs(movedBent[0]-bentNear[0])<25,'Bent normal must remain in world space across camera rotation: '+JSON.stringify({bentNear,movedBent}));
  camera();
  // Compare to a scalar-AO oracle using the same geometry, visibility and sky.
  // Only the direction used to evaluate indirect light changes in this shader.
  const directional=await draw({ao:1,direction:[1,0,0]});
  await api.dx12Shader([{name:'ScalarAOReference',enabled:true,code:`void ScalarAOReference(inout ShadingContext ctx) {
    float3 scalarFill = evaluateAmbient(ctx.normal, ctx.normal.y * 0.5 + 0.5);
    ctx.color += ctx.albedo * (scalarFill - ctx.fill) * ctx.ao / 3.141592653589793;
}`}]);
  const scalar=await draw({ao:1,direction:[1,0,0]});
  const bentLightingGain=sample(directional,near)[0]-sample(scalar,near)[0];
  check(bentLightingGain>1,'The open +X direction must actually affect shaded ambient light: '+bentLightingGain);
  await api.dx12Shader([]);
  const direct=await draw({sun:10,ambient:0}),directAO=await draw({sun:10,ambient:0,ao:1});
  check(difference(direct,directAO).max===0,'Bent normals must leave direct lighting unchanged');
  check(difference(await draw({ao:0}),await draw({ao:1,intensity:0})).max===0,'AO strength zero must also disable bent-normal lighting');
  material.emissive.setRGB(1,0.3,0.1);material.emissiveIntensity=2;await api.dx12Model(nativeModel(scene));
  check(difference(await draw({ambient:0}),await draw({ambient:0,ao:1})).max===0,'Directional occlusion must preserve emission');
  material.emissive.setRGB(0,0,0);await api.dx12Model(nativeModel(scene));
  await draw({ao:1,skyDirectionality:0});shot('uniform-sky');
  await draw({ao:1,direction:[1,0,0]});shot('sun-right');
  await draw({ao:1,direction:[-1,0,0]});shot('sun-left');
  // Resolve/upscale exercises the wider AO texture and view/world conversion
  // under jitter, including light edits that reset reconstruction history.
  const aa=[];
  if(v.dx12.capabilities?.dlss)for(const mode of [1,2,3]){
    let a,b;
    for(let frame=0;frame<8;frame++)a=await draw({ao:1,aa:mode,direction:[1,0,0]});
    for(let frame=0;frame<8;frame++)b=await draw({ao:1,aa:mode,direction:[-1,0,0]});
    const diff=difference(a,b);check(diff.changed>100,'Directional sky must survive DLAA/DLSS mode '+mode+': '+JSON.stringify(diff));aa.push({mode,...diff});
  }
  await draw({ao:1});
  return{sunResponse,toonResponse,bentNear,bentFar,movedBent,bentLightingGain,aa,images};
}
