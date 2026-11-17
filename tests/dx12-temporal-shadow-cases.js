// Compare reconstruction against independent 128-ray renders of the same scene.
export async function runTemporalShadowCases({viewer:v,THREE,nativeModel,render,check}) {
  const {api}=window;
  const model=new THREE.Group(),material=new THREE.MeshLambertMaterial({color:0xc0c0c0,side:THREE.DoubleSide});
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(6,6),material);floor.rotation.x=-Math.PI/2;floor.position.y=-1;model.add(floor);
  const ball=new THREE.Mesh(new THREE.SphereGeometry(0.8,32,20),material);model.add(ball);
  const camera=(step=0)=>{v.camera.position.set(3+step*0.04,2.7,5);v.camera.up.set(0,1,0);v.camera.lookAt(0,0,0);v.camera.aspect=1;v.camera.near=0.1;v.camera.far=100;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld();};
  const options={shadow:1,softness:0.12,ambient:1,ground:-100,diagonal:9};
  const stats=(actual,expected,unshadowed)=>{
    let sum=0,max=0,ghost=0;
    for(let i=0;i<actual.length;i+=4){const d=Math.abs(actual[i]-expected[i]);sum+=d;max=Math.max(max,d);
      if(unshadowed&&Math.abs(unshadowed[i]-expected[i])<=2&&expected[i]-actual[i]>24)ghost++;
    }
    return{mean:sum/(actual.length/4),max,ghost};
  };
  const settle=async(extra={})=>{let image;for(let i=0;i<36;i++)image=await render({...options,rays:4,...extra});return image;};
  camera();await api.dx12Model(nativeModel(model));
  const reference=await render({...options,rays:128});
  const staticCases=[];
  for(const rays of [1,2,4]) {
    const image=await settle({rays}),error=stats(image,reference);
    check(!v.testFrame.shadowAccumulating,'A static view must finish progressive accumulation');
    check(error.mean<2,'Converged low-ray shadows must match the reference: '+JSON.stringify({rays,...error}));
    const next=await render({...options,rays}),stability=stats(next,image);
    check(stability.mean<0.7,'Converged shadows must remain stable: '+JSON.stringify({rays,...stability}));
    staticCases.push({rays,error,stability});
  }
  // Oracle sequence is rendered first, so reference-mode resets cannot hide bad reprojection.
  const oracle=[];
  for(let i=1;i<=8;i++){camera(i);oracle.push(await render({...options,rays:128}));}
  camera();await api.dx12Model(nativeModel(model));await settle();
  const cameraErrors=[];
  for(let i=1;i<=8;i++) {
    camera(i);const error=stats(await render({...options,rays:4}),oracle[i-1]);
    check(error.mean<2.5,'Camera reprojection must retain shadow quality: '+JSON.stringify(error));cameraErrors.push(error);
  }
  // Moving an occluder must clear its old shadow on an otherwise stationary floor.
  camera();ball.position.x=1.8;await api.dx12Pose(nativeModel(model,true));
  const moved=await render({...options,rays:128}),movedLit=await render({...options,shadow:0,rays:128});
  ball.position.x=0;await api.dx12Model(nativeModel(model));await settle();
  ball.position.x=1.8;await api.dx12Pose(nativeModel(model,true));
  const motion=[];
  for(let i=0;i<4;i++)motion.push(stats(await render({...options,rays:4}),moved,movedLit));
  check(motion[0].ghost<35&&motion[3].ghost<15,'A moving occluder must not leave an old shadow trail: '+JSON.stringify(motion));
  check(motion[3].mean<2,'Posed geometry must converge to its new shadow');
  await settle();
  const changedLight={...options,direction:[-0.35,0.7,0.62]};
  const light=await render({...changedLight,rays:4});check(v.testFrame.shadowAccumulating,'Light changes must reset shadow history');
  const lightError=stats(light,await render({...changedLight,rays:128}));check(lightError.mean<3,'New light must not reuse stale shadows');
  await settle();await render({...options,rays:4,width:161});check(v.testFrame.shadowAccumulating,'Resize must reset shadow history');
  camera();await settle();await render({...options,rays:4,exposure:50});check(!v.testFrame.shadowAccumulating,'Exposure must not invalidate scene-linear shadow history');
  const hard={...options,softness:0,rays:4,ambient:0};
  check(stats(await render(hard),await render({...hard,ao:1})).max===0,'AO must preserve direct light in the temporal path');
  floor.geometry.dispose();ball.geometry.dispose();material.dispose();
  return{staticCases,cameraErrors,motion,lightError,resizeReset:true,exposureIndependent:true};
}
