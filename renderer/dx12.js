import * as THREE from 'three';
import { gt7InverseDisplay } from './gt7-tonemapping.js';
import { nativeTexture } from './native-textures.js';
import { collectMaterials } from './material-info.js';
import { packMaterialParams } from '../src/core/shader-stack.js';

function bytes(array) { return new Uint8Array(array.buffer, array.byteOffset, array.byteLength); }
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)); let at = 0;
  for (const p of parts) { out.set(bytes(p), at); at += p.byteLength; } return out.buffer;
}
/** Export the currently posed scene, preserving loader/material ownership in the editor. */
// materialAssign (panel material index -> stackId) + stackIdsOut (filled parallel
// to native material records) enable per-material shader stacks. Default callers
// pass neither and get the plain model packet as before.
export function nativeModel(object, poseOnly = false, materialAssign = null, stackIdsOut = null, panelIndicesOut = null) {
  object.updateMatrixWorld(true);
  const vertices = [], triangles = [], records = [], textures = [], materialIds = new Map(), textureIds = new Map();
  const textureId = texture => {
    if (!texture) return -1;
    if (textureIds.has(texture)) return textureIds.get(texture);
    const image = nativeTexture(texture); if (!image) return -1;
    if (textures.length >= 128) throw new Error('DX12 뷰포트는 현재 텍스처 128개까지 지원합니다.');
    const id = textures.length; image.srgb=texture.colorSpace===THREE.SRGBColorSpace; textures.push(image); textureIds.set(texture, id); return id;
  };
  // Global panel index by material identity (same order as collectMaterials), so
  // multi-mesh scenes map nativeId->panel index correctly (local group slots differ).
  const panelOf = new Map(collectMaterials(object).map((e, i) => [e.material, i]));
  const materialId = (m, panelIndex = 0) => {
    if (materialIds.has(m)) return materialIds.get(m);
    if(m.displacementMap || (m.normalMap && m.normalMapType===THREE.ObjectSpaceNormalMap)) throw new Error('DX12에서 아직 지원하지 않는 재질입니다: 변위·Object-space Normal.');
    const id = records.length, buffer = new ArrayBuffer(128), f = new Float32Array(buffer), u = new Int32Array(buffer);
    if (stackIdsOut) stackIdsOut[id] = materialAssign?.[panelIndex] ?? 0;
    if (panelIndicesOut) panelIndicesOut[id] = panelIndex;
    f.set([m.color?.r ?? 1, m.color?.g ?? 1, m.color?.b ?? 1, m.opacity ?? 1]);
    f.set([m.emissive?.r * (m.emissiveIntensity ?? 1) || 0, m.emissive?.g * (m.emissiveIntensity ?? 1) || 0, m.emissive?.b * (m.emissiveIntensity ?? 1) || 0, 0], 4);
    u.set([textureId(m.map), textureId(m.alphaMap), textureId(m.emissiveMap), textureId(m.aoMap)], 8);
    f.set([m.alphaTest || 0, m.transparent ? 1 : 0, m.side === THREE.DoubleSide ? 1 : m.side === THREE.BackSide ? 2 : 0, m.aoMapIntensity ?? 1], 12);
    f.set([m.map?.repeat.x ?? 1, m.map?.repeat.y ?? 1, m.map?.offset.x ?? 0, m.map?.offset.y ?? 0], 16);
    f[20] = m.map?.flipY ? 1 : 0;
    f[23] = m.depthWrite ? 1 : 0;
    f[21]=textureId(m.normalMap);f[22]=textureId(m.bumpMap);
    f.set([m.normalScale?.x??1,m.normalScale?.y??1,m.bumpScale??1,m.flatShading?1:0],24);
    f.set([m.normalMap?.flipY?1:0,m.bumpMap?.flipY?1:0,m.map?.colorSpace===THREE.SRGBColorSpace?1:0,m.emissiveMap?.colorSpace===THREE.SRGBColorSpace?1:0],28);
    records.push(new Uint8Array(buffer)); materialIds.set(m, id); return id;
  };
  const p = new THREE.Vector3(), n = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
  const baseNormal = new THREE.Vector3(), morphNormal = new THREE.Vector3(), skinNormal = new THREE.Vector4(), weightedNormal = new THREE.Vector4(), bone = new THREE.Matrix4();
  object.traverseVisible(mesh => {
    if (mesh.isPoints || mesh.isLine) throw new Error('DX12 모델 렌더링은 현재 삼각형 메시를 지원합니다.');
    if (!mesh.isMesh || mesh.userData.viewportOutline || !mesh.geometry.attributes.position) return;
    if(mesh.isInstancedMesh||mesh.isBatchedMesh)throw new Error('DX12에서 아직 지원하지 않는 메시입니다: Instanced/Batched Mesh.');
    const geometry = mesh.geometry, position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
    const base = vertices.length / 8;
    normalMatrix.getNormalMatrix(mesh.matrixWorld); if (mesh.isSkinnedMesh) mesh.skeleton.update();
    for (let i = 0; i < position.count; i++) {
      mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld);
      if (normal) {
        n.fromBufferAttribute(normal, i); baseNormal.copy(n);
        geometry.morphAttributes.normal?.forEach((attribute, index) => {
          const influence = mesh.morphTargetInfluences?.[index] || 0;
          if (influence) { morphNormal.fromBufferAttribute(attribute, i); if (!geometry.morphTargetsRelative) morphNormal.sub(baseNormal); n.addScaledVector(morphNormal, influence); }
        });
        if (mesh.isSkinnedMesh) {
          const indices = geometry.attributes.skinIndex, weights = geometry.attributes.skinWeight;
          skinNormal.set(n.x,n.y,n.z,0).applyMatrix4(mesh.bindMatrix); weightedNormal.set(0,0,0,0);
          for(let k=0;k<4;k++) {
            const weight=weights.getComponent(i,k); if(!weight)continue;
            bone.fromArray(mesh.skeleton.boneMatrices,indices.getComponent(i,k)*16);
            const x=skinNormal.x,y=skinNormal.y,z=skinNormal.z,e=bone.elements;
            weightedNormal.x+=(e[0]*x+e[4]*y+e[8]*z)*weight;
            weightedNormal.y+=(e[1]*x+e[5]*y+e[9]*z)*weight;
            weightedNormal.z+=(e[2]*x+e[6]*y+e[10]*z)*weight;
          }
          weightedNormal.applyMatrix4(mesh.bindMatrixInverse);n.set(weightedNormal.x,weightedNormal.y,weightedNormal.z);
        }
        n.applyNormalMatrix(normalMatrix);
      } else n.set(0,1,0);
      vertices.push(p.x,p.y,p.z,n.x,n.y,n.z,uv?.getX(i)||0,uv?.getY(i)||0);
    }
    if (poseOnly) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: geometry.index?.count ?? position.count, materialIndex: 0 }];
    for (const group of groups) {
      const m = mats[group.materialIndex]; if (!m || !m.visible || m.opacity <= 0) continue;
      if(m.isShaderMaterial)throw new Error('사용자 GLSL 셰이더는 DX12에서 지원하지 않습니다.');
      const mat = materialId(m, panelOf.get(m) ?? group.materialIndex), start = Math.max(group.start, geometry.drawRange.start);
      const end = Math.min(group.start + group.count, geometry.drawRange.start + geometry.drawRange.count, geometry.index?.count ?? position.count);
      for (let i = start; i + 2 < end; i += 3) triangles.push(base + (geometry.index?.getX(i) ?? i), base + (geometry.index?.getX(i+1) ?? i+1), base + (geometry.index?.getX(i+2) ?? i+2), mat);
    }
  });
  if (poseOnly) return new Float32Array(vertices.length ? vertices : [0,0,0,0,1,0,0,0]).buffer;
  // Empty/hidden scenes still render their background and grid with DX12.
  if (!triangles.length) {
    if (!vertices.length) vertices.push(0,0,0,0,1,0,0,0);
    triangles.push(0,0,0,materialId(new THREE.MeshLambertMaterial({opacity:0,transparent:true}), 0));
  }
  const parts = [new Uint32Array([vertices.length/8,triangles.length/4,records.length,textures.length]), new Float32Array(vertices),new Uint32Array(triangles),...records];
  for (const t of textures) {
    parts.push(new Uint32Array([t.width,t.height,t.srgb?1:0,t.encoding,t.mips.length]));
    for (const mip of t.mips) parts.push(new Uint32Array([mip.byteLength]),mip);
  }
  return join(parts);
}

export class Dx12Viewport {
  constructor(viewer, status) {
    this.viewer = viewer; this.status = status; this.enabled = false; this.busy = false; this.dirty = false; this.loadedKey = ''; this.id = 0; this.shadowSamples = 4;
    this.materialAssign = []; // panel material index -> shader stackId (synced from main)
    this.library = []; this.instances = []; this.stride = 1; // per-material shader state (synced from main)
    this.panelIndices = []; this.loadedParamKey = '';
    this.selectionPanel = -1; // selected mesh (panel index), -1 = none; per-mesh outline
    // Published pick state: native generation + panelIndices snapshot of the last VALID
    // render, updated atomically. Null while a model/mapping rebuild is in flight.
    this.pickState = null;
    const savedAA=Number(localStorage.getItem('viewportAA')??1);this.aaMode=[0,1,2,3].includes(savedAA)?savedAA:1;
    // Use a mild default; stored choices always win over the default.
    const savedSharpen=Number(localStorage.getItem('viewportSharpen')??25);this.sharpen=Number.isFinite(savedSharpen)?Math.min(100,Math.max(0,Math.round(savedSharpen))):25;
    this.canvas = viewer.canvas; this.empty = new THREE.Group();
    // Canvas2D loses its pixels when Chromium's GPU process restarts. A static
    // scene otherwise has no camera/animation change to request a fresh frame.
    this.canvas.addEventListener('contextrestored', () => this.viewer.requestRender());
    this.helpers = document.createElement('canvas'); this.helpers.id='dx12-editor-overlay'; this.helpers.hidden=true;
    Object.assign(this.helpers.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none'});viewer.container.append(this.helpers);
  }
  clearError() {
    this.error = null;
    document.getElementById('renderer-error').hidden = true;
  }
  fail(error) {
    this.error = error; this.enabled = false;
    this.status.textContent = 'DX12: ' + error.message;
    const overlay = document.getElementById('renderer-error');
    overlay.querySelector('p').textContent = error.message; overlay.hidden = false;
    this.canvas.hidden = true; this.helpers.hidden = true;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const caps = await window.api.dx12Start();
        this.capabilities = caps; this.loadedKey = ''; this.loadedPoseKey = '';
        const aa=document.getElementById('viewport-aa');
        if(aa){for(const option of aa.options)option.disabled=option.value!=='0'&&!caps.dlss;aa.value=String(caps.dlss?this.aaMode:0);if(!caps.dlss)aa.title=caps.dlssReason;}
        this.enabled = true; this.canvas.hidden = false; this.helpers.hidden = false;
        this.clearError(); this.status.textContent = `DX12 Ultimate · ${caps.gpu}`;
        this.viewer.requestRender();
        return true;
      } catch(error) { this.fail(error); return false; }
      finally { this.starting = null; }
    })();
    return this.starting;
  }
  get object() { return this.viewer.current?.object || this.empty; }
  get library() { return this._library; }
  set library(value) {
    this._library = value || [];
    // New function layouts/defaults need an upload even when instance overrides
    // and the assigned shader ID stay unchanged. The revision also survives an
    // older in-flight parameter upload completing after this assignment.
    this.parameterRevision = (this.parameterRevision || 0) + 1;
  }
  sceneKey(pose = false) {
    const v=this.viewer, values=[this.object.uuid]; if(pose)values.push(v.nativeRevision || 0);
    else values.push(JSON.stringify(this.materialAssign || []));
    this.object.traverseVisible(o => {
      if (!o.isMesh || o.userData.viewportOutline) return;
      values.push(o.uuid, o.geometry.attributes.position.count, o.geometry.index?.count, o.geometry.index?.version);
      if(pose) { values.push(o.geometry.attributes.position.version, ...o.matrixWorld.elements, ...(o.morphTargetInfluences || [])); return; }
      for(const m of Array.isArray(o.material)?o.material:[o.material]) {
        values.push(m.uuid,m.visible,m.opacity,m.transparent,m.alphaTest,m.side,m.color?.getHex(),m.emissive?.getHex(),m.emissiveIntensity);
        values.push(m.normalScale?.x,m.normalScale?.y,m.bumpScale,m.flatShading,m.depthWrite,m.aoMapIntensity,m.normalMapType);
        for(const key of ['map','alphaMap','emissiveMap','aoMap','normalMap','bumpMap','displacementMap']) {
          const tex=m[key];values.push(tex?.id,tex?.version,tex?.image?.width,tex?.image?.complete,tex?.colorSpace,tex?.flipY,tex?.repeat.x,tex?.repeat.y,tex?.offset.x,tex?.offset.y);
        }
      }
    });return values.join('|');
  }
  frame() {
    const v=this.viewer, out=new ArrayBuffer(308), u=new Uint32Array(out), f=new Float32Array(out,4); u[0]=++this.id;
    v.camera.updateMatrixWorld();
    f.set(v.camera.matrixWorldInverse.elements,0);
    const projection = v.camera.projectionMatrix.clone();
    // OpenGL [-1,1] clip depth to Direct3D [0,1], without changing the camera/controls.
    const conversion = new THREE.Matrix4().set(1,0,0,0,0,1,0,0,0,0,0.5,0.5,0,0,0,1);
    projection.premultiply(conversion); f.set(projection.elements,16);
    const sun=v.sun.position.clone().normalize(); f.set([...sun.toArray(),v.lightLevel],32);
    f.set([...v.hemi.color.toArray(),v.ambientLevel],36);f.set([...v.hemi.groundColor.toArray(),v.skyDirectionality],40);
    const ratio=Math.min(window.devicePixelRatio,2),size=new THREE.Vector2(Math.max(1,Math.round(v.container.clientWidth*ratio)),Math.max(1,Math.round(v.container.clientHeight*ratio))); const scale=Math.min(1,2048/Math.max(size.x,size.y));
    f.set([Math.max(1,Math.round(size.x*scale)),Math.max(1,Math.round(size.y*scale)),v.shadow.softness,v.cortao.modelSize*v.cortao.settings.radius/100],44);
    f.set([v.exposureMultiplier,0,v.shadow.enabled?1:0,v.cortao.settings.enabled&&!v.flags.wireframe?1:0],48);
    f.set([v.cortao.settings.intensity,v.cortao.debugView==='bent'?3:v.cortao.debugView==='raw'?2:v.cortao.debugView==='ao'?1:0,this.shadowSamples,v.flags.wireframe?1:0],52);
    f.set([...v.scene.background.toArray(),v.flags.grid?1:0],56);f.set([v.shadow.groundY,10,v.cortao.modelSize,v.outlineSettings.width],60);
    f[63] *= size.x * scale / v.container.clientWidth;
    const outline=new THREE.Color(v.outlineSettings.color);
    f.set(outline.toArray().map(c=>gt7InverseDisplay(c)/v.exposureMultiplier),64);
    f[67]=this.capabilities?.dlss?this.aaMode:0;
    if(!v.grid.geometry.boundingBox)v.grid.geometry.computeBoundingBox();
    const gp=v.grid.geometry.attributes.position;
    f.set([v.grid.position.x,v.grid.position.z,v.grid.geometry.boundingBox.max.x*2,Math.abs(gp.getZ(4)-gp.getZ(0))||1],68);
    f[72]=this.sharpen/100;
    // Per-mesh selection (sharpening.y = selected nativeId+1, 0 = none). The outline
    // is a screen-space post-AA ring in outputMain around the selected mesh's mask
    // region; no per-frame color slots needed.
    const selNative=this.selectionPanel>=0?this.panelIndices.indexOf(this.selectionPanel):-1;
    f[73]=selNative>=0?selNative+1:0;
    return out;
  }
  setSelection(panelIndex) { this.selectionPanel = panelIndex >= 0 ? panelIndex : -1; this.viewer.requestRender(); }
  // GPU picking: read the selection mask at the click's render-res pixel.
  // Returns nativeId+1 (0 = empty space).
  // Returns {panelIndex,hit} for a valid response, or null for a stale/invalid one
  // (caller must NOT treat null as an empty-space click / deselect).
  async pick(clientX, clientY) {
    const snap = this.pickState;
    const rect = this.canvas.getBoundingClientRect();
    if (!snap || !rect.width || !rect.height) return null;
    const fw = this.lastFrame?.renderWidth || rect.width, fh = this.lastFrame?.renderHeight || rect.height;
    const x = Math.round((clientX - rect.left) / rect.width * fw), y = Math.round((clientY - rect.top) / rect.height * fh);
    const r = await window.api.dx12Pick(x, y);
    // Accept only if the response belongs to the same published generation AND the
    // snapshot is still the current valid state (no rebuild/superseding render since).
    if (!r || r.gen !== snap.gen || this.pickState !== snap) return null;
    if (r.id === 0) return { panelIndex: -1, hit: false };
    return { panelIndex: snap.panelIndices[r.id - 1] ?? -1, hit: true };
  }
  drawHelpers() {
    const v=this.viewer,c=this.helpers,ratio=Math.min(window.devicePixelRatio,2),w=Math.max(1,Math.round(v.container.clientWidth*ratio)),h=Math.max(1,Math.round(v.container.clientHeight*ratio));
    if(c.width!==w||c.height!==h){c.width=w;c.height=h;}const ctx=c.getContext('2d');ctx.clearRect(0,0,w,h);
    if(v.cortao.debugView!=='off')return;
    const commands=[],point=new THREE.Vector3();
    const project=(attribute,index,matrix)=>{point.fromBufferAttribute(attribute,index).applyMatrix4(matrix).project(v.camera);return [(point.x+1)*w/2,(1-point.y)*h/2,point.z];};
    for(const root of [v.skeleton,v.lightRig,v.lightGizmo]) {
      if(!root?.visible)continue;root.updateMatrixWorld(true);
      root.traverseVisible(o=>{
        const geometry=o.geometry;if(!geometry?.attributes.position||!o.material)return;
        const position=geometry.attributes.position,colors=geometry.attributes.color,index=geometry.index;
        const mats=Array.isArray(o.material)?o.material:[o.material], groups=Array.isArray(o.material)?geometry.groups:[{start:0,count:index?.count??position.count,materialIndex:0}];
        for(const group of groups){const m=mats[group.materialIndex];if(!m?.visible||m.opacity<=0)continue;
          const color=m.color||new THREE.Color(1,1,1),start=Math.max(group.start,geometry.drawRange.start),end=Math.min(group.start+group.count,geometry.drawRange.start+geometry.drawRange.count,index?.count??position.count);
          const stride=o.isMesh?3:o.isLineSegments?2:1;
          for(let i=start;i<end;i+=stride){const ids=o.isMesh?[i,i+1,i+2]:o.isLine?[i,i+1]:[i];if(ids.at(-1)>=end)continue;
            const vertices=ids.map(j=>project(position,index?.getX(j)??j,o.matrixWorld));if(vertices.some(p=>p[2]<-1||p[2]>1))continue;
            let tint=color;if(m.vertexColors&&colors)tint=new THREE.Color().fromBufferAttribute(colors,index?.getX(i)??i);
            commands.push({vertices,depth:vertices.reduce((s,p)=>s+p[2],0)/vertices.length,color:'#'+tint.getHexString(),alpha:m.opacity??1,size:(m.size||3)*ratio});
          }
        }
      });
    }
    commands.sort((a,b)=>b.depth-a.depth);
    for(const command of commands){ctx.globalAlpha=command.alpha;ctx.strokeStyle=ctx.fillStyle=command.color;ctx.lineWidth=ratio;ctx.beginPath();
      const p=command.vertices;if(p.length===1){ctx.arc(p[0][0],p[0][1],command.size/2,0,Math.PI*2);ctx.fill();}
      else{ctx.moveTo(p[0][0],p[0][1]);for(let i=1;i<p.length;i++)ctx.lineTo(p[i][0],p[i][1]);if(p.length===3){ctx.closePath();ctx.fill();}else ctx.stroke();}
    }ctx.globalAlpha=1;
  }
  request() { this.dirty=true;this.drawHelpers(); if(!this.busy) this.flush(); }
  async flush() {
    if(!this.enabled) return;
    this.busy=true;
    try {
      while(this.enabled && this.dirty) {
        this.dirty=false;this.canvas.hidden=false; this.object.updateMatrixWorld(true);
        const key=this.sceneKey();
        const poseKey=this.sceneKey(true);
        if(key!==this.loadedKey) { this.pickState=null; this.viewer.invalidatePick(); const stackIds=[],panelIndices=[]; await window.api.dx12Model(nativeModel(this.object,false,this.materialAssign,stackIds,panelIndices)); await window.api.dx12MaterialStacks(stackIds); this.panelIndices=panelIndices; this.loadedKey=key;this.loadedPoseKey=poseKey;this.loadedParamKey=''; }
        else if(poseKey!==this.loadedPoseKey) { await window.api.dx12Pose(nativeModel(this.object,true));this.loadedPoseKey=poseKey; }
        const paramKey=JSON.stringify([this.parameterRevision,this.instances]);
        if(paramKey!==this.loadedParamKey && this.panelIndices.length) { const pd=packMaterialParams(this.library,this.instances,this.panelIndices,this.stride,this.panelIndices.length); await window.api.dx12Params(pd.buffer); this.loadedParamKey=paramKey; }
        const result=await window.api.dx12Render(this.frame());
        this.lastFrame=result;
        // Publish a new pick snapshot only when the model/mapping generation changes;
        // ordinary frame advancement (AA convergence/animation) keeps the same object so
        // in-flight clicks are not cancelled by mere frame timing.
        if(!this.pickState||this.pickState.gen!==result.modelGen||this.pickState.panelIndices!==this.panelIndices)
          this.pickState={gen:result.modelGen,panelIndices:this.panelIndices};
        this.status.textContent=`DX12 Ultimate · ${result.antialiasing||'MSAA 4x'} · ${result.renderMs.toFixed(1)} ms`;
        // Finish temporal convergence even when the camera/model becomes still.
        // Presentation acknowledgement already paces frames and bounds GPU leases.
        if(result.shadowAccumulating||result.aaAccumulating)this.dirty=true;
      }
    } catch(e) { this.fail(e);
    } finally {this.busy=false;}
    // A request may have set dirty while this flush was exiting (busy still true,
    // so it did not start a new flush). Pick it up now to avoid a stalled viewport.
    if(this.enabled && this.dirty && !this.busy) this.flush();
  }
}
