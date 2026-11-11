// Ray traced soft shadows for the viewer's main directional light.
//
// The scene is still rasterised by three.js; only the light visibility is traced, in the fragment
// shader, against a BVH (three-mesh-bvh) of the loaded model. Each frame shoots a few jittered rays
// towards a disc-shaped light; the viewer accumulates frames while nothing changes, so the penumbra
// converges without a denoiser. Alpha textures / translucent materials are handled stochastically.

import * as THREE from 'three';
import { MeshBVH, MeshBVHUniformStruct, FloatVertexAttributeTexture, BVHShaderGLSL } from 'three-mesh-bvh';

const ALPHA_SIZE = 256;       // resolution of each alpha layer used by shadow rays
const MAX_ALPHA_LAYERS = 128;
const RAYS_PER_FRAME = 4;

const RT_GLSL = /* glsl */`
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}

uniform BVH rtBvh;
uniform sampler2D rtAttr;            // per vertex: uv.xy, alpha layer (-1 = none), material opacity
uniform sampler2DArray rtAlpha;
uniform vec3 rtLightDir;             // world space, towards the light
uniform float rtLightRadius;         // tan( angular radius of the light disc )
uniform float rtBias;
uniform float rtSeed;
uniform int rtOn;
varying vec3 vRtWorldPos;

uint rtState = 1u;
float rtRand() {
	rtState = rtState * 747796405u + 2891336453u;
	uint w = ( ( rtState >> ( ( rtState >> 28u ) + 4u ) ) ^ rtState ) * 277803737u;
	w = ( w >> 22u ) ^ w;
	return float( w >> 8u ) / 16777216.0;
}
void rtInit() {
	rtState = ( uint( gl_FragCoord.x ) * 1973u + uint( gl_FragCoord.y ) * 9277u + uint( rtSeed ) * 26699u ) | 1u;
	rtRand(); rtRand();
}

// 1 = light reaches the point, 0 = blocked
float rtTrace( vec3 origin, vec3 dir ) {
	for ( int i = 0; i < 6; i ++ ) {
		uvec4 faceIndices = uvec4( 0u );
		vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
		vec3 bary = vec3( 0.0 );
		float side = 1.0;
		float dist = 0.0;
		if ( ! bvhIntersectFirstHit( rtBvh, origin, dir, faceIndices, faceNormal, bary, side, dist ) ) return 1.0;
		vec4 a = textureSampleBarycoord( rtAttr, bary, faceIndices.xyz );
		float alpha = a.w;
		if ( a.z > - 0.5 ) alpha *= texture( rtAlpha, vec3( a.xy, floor( a.z + 0.5 ) ) ).r;
		if ( alpha >= 0.98 || rtRand() < alpha ) return 0.0;
		origin += dir * ( dist + rtBias );
	}
	return 1.0;
}

float rtShadow( vec3 P ) {
	if ( rtOn == 0 ) return 1.0;
	vec3 L = rtLightDir;
	vec3 ng = normalize( cross( dFdx( P ), dFdy( P ) ) );
	if ( dot( ng, L ) < 0.0 ) ng = - ng;
	vec3 o = P + ng * rtBias;
	vec3 t = normalize( abs( L.y ) < 0.99 ? cross( L, vec3( 0.0, 1.0, 0.0 ) ) : cross( L, vec3( 1.0, 0.0, 0.0 ) ) );
	vec3 b = cross( L, t );
	float sum = 0.0;
	for ( int s = 0; s < ${RAYS_PER_FRAME}; s ++ ) {
		float r = sqrt( rtRand() ) * rtLightRadius;
		float phi = 6.2831853 * rtRand();
		sum += rtTrace( o, normalize( L + ( t * cos( phi ) + b * sin( phi ) ) * r ) );
	}
	return sum / float( ${RAYS_PER_FRAME} );
}
`;

const DIR_LIGHT_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';
const LIGHTS_CHUNK = THREE.ShaderChunk.lights_fragment_begin.replace(
  DIR_LIGHT_LINE,
  `${DIR_LIGHT_LINE}
		#if ( UNROLLED_LOOP_INDEX == 0 )
		if ( dot( geometryNormal, directLight.direction ) > 0.0 ) directLight.color *= rtShadow( vRtWorldPos );
		#endif`,
);
if (LIGHTS_CHUNK === THREE.ShaderChunk.lights_fragment_begin) console.warn('rt-shadows: three.js light chunk changed, shadows will not be applied');

const WORLD_POS_VERTEX = /* glsl */`
	vec4 rtWorldPos = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
	rtWorldPos = instanceMatrix * rtWorldPos;
	#endif
	vRtWorldPos = ( modelMatrix * rtWorldPos ).xyz;
`;

const isLit = (m) => m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshStandardMaterial || m.isMeshToonMaterial;
const materialsOf = (o) => (Array.isArray(o.material) ? o.material : [o.material]);

export class RtShadows {
  constructor() {
    const emptyAlpha = new THREE.DataArrayTexture(new Uint8Array([255]), 1, 1, 1);
    emptyAlpha.format = THREE.RedFormat;
    emptyAlpha.needsUpdate = true;
    this.emptyAlpha = emptyAlpha;
    this.uniforms = {
      rtBvh: { value: new MeshBVHUniformStruct() },
      rtAttr: { value: new FloatVertexAttributeTexture() },
      rtAlpha: { value: emptyAlpha },
      rtLightDir: { value: new THREE.Vector3(0, 1, 0) },
      rtLightRadius: { value: 0.03 },
      rtBias: { value: 0.001 },
      rtSeed: { value: 0 },
      rtOn: { value: 0 },
    };
    this.ready = false;   // a BVH for the current model is uploaded
    this.stats = null;

    // shadow catcher under the model
    this.groundUniforms = { ...this.uniforms, rtFade: { value: 1 }, rtDarkness: { value: 0.5 } };
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: this.groundUniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */`
          varying vec3 vRtWorldPos;
          void main() {
            vec4 wp = modelMatrix * vec4( position, 1.0 );
            vRtWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          precision highp sampler2DArray;
          precision highp usampler2D;
          ${RT_GLSL}
          uniform float rtFade;
          uniform float rtDarkness;
          uniform vec3 rtCenter;
          void main() {
            rtInit();
            float fade = 1.0 - smoothstep( 0.55, 1.0, length( vRtWorldPos.xz - rtCenter.xz ) / rtFade );
            if ( fade <= 0.0 ) discard;
            gl_FragColor = vec4( 0.0, 0.0, 0.0, ( 1.0 - rtShadow( vRtWorldPos ) ) * rtDarkness * fade );
          }`,
      }),
    );
    this.groundUniforms.rtCenter = { value: new THREE.Vector3() };
    this.ground.material.uniforms = this.groundUniforms;
    this.ground.visible = false;
    this.ground.renderOrder = -1;
  }

  /** Inject the shadow term into every lit material of the object (cheap no-op while disabled). */
  patch(object) {
    const uniforms = this.uniforms;
    object.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of materialsOf(o)) {
        if (!m || !isLit(m) || m.userData.rtPatched) continue;
        m.userData.rtPatched = true;
        m.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, uniforms);
          shader.vertexShader = 'varying vec3 vRtWorldPos;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_POS_VERTEX}`);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${RT_GLSL}`)
            .replace('#include <lights_fragment_begin>', `rtInit();\n${LIGHTS_CHUNK}`);
        };
        m.customProgramCacheKey = () => 'rt-shadow';
        m.needsUpdate = true;
      }
    });
  }

  setLight(direction, radius) {
    this.uniforms.rtLightDir.value.copy(direction).normalize();
    this.uniforms.rtLightRadius.value = radius;
  }

  setEnabled(on) {
    this.uniforms.rtOn.value = on && this.ready ? 1 : 0;
    this.ground.visible = on && this.ready;
  }

  /** Place the shadow catcher under the model. */
  fitGround(box) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const reach = Math.max(size.x, size.y, size.z) * 3;
    this.ground.position.set(center.x, box.min.y, center.z);
    this.ground.scale.setScalar(reach * 2);
    this.ground.updateMatrixWorld(true);
    this.groundUniforms.rtCenter.value.copy(this.ground.position);
    this.groundUniforms.rtFade.value = reach;
    this.uniforms.rtBias.value = Math.max(size.length() * 2e-4, 1e-6);
  }

  clear() {
    this.ready = false;
    this.stats = null;
    this.setEnabled(false);
  }

  /** (Re)build the BVH from the object's current world-space triangles. Returns false if nothing casts. */
  build(object) {
    const started = performance.now();
    object.updateMatrixWorld(true);

    // pass 1: collect casting groups + alpha layers
    const layers = new Map(); // texture -> layer index
    const parts = [];
    let triangles = 0;
    object.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry?.attributes.position) return;
      const g = o.geometry;
      const total = g.index ? g.index.count : g.attributes.position.count;
      const mats = materialsOf(o);
      const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
      for (const grp of groups) {
        const m = mats[Array.isArray(o.material) ? grp.materialIndex : 0];
        if (!m || !m.visible) continue;
        const opacity = m.transparent ? m.opacity : 1;
        if (opacity <= 0.02) continue;
        let layer = -1;
        const map = m.map;
        if (map && (m.transparent || m.alphaTest > 0) && map.image && !map.isCompressedTexture) {
          if (!layers.has(map) && layers.size < MAX_ALPHA_LAYERS) layers.set(map, layers.size);
          layer = layers.has(map) ? layers.get(map) : -1;
        }
        const start = Math.max(0, grp.start);
        const count = Math.floor((Math.min(total, grp.start + grp.count) - start) / 3) * 3;
        if (count <= 0) continue;
        parts.push({ mesh: o, start, count, layer, opacity });
        triangles += count / 3;
      }
    });
    if (!triangles) { this.clear(); return false; }

    // pass 2: world-space, non-indexed triangle soup
    const positions = new Float32Array(triangles * 9);
    const attrs = new Float32Array(triangles * 12);
    const worldCache = new Map();
    const v = new THREE.Vector3();
    let w = 0;
    for (const p of parts) {
      const g = p.mesh.geometry;
      let world = worldCache.get(p.mesh);
      if (!world) {
        const n = g.attributes.position.count;
        world = new Float32Array(n * 3);
        const deforming = p.mesh.isSkinnedMesh || (g.morphAttributes.position && g.morphAttributes.position.length);
        for (let i = 0; i < n; i++) {
          if (deforming) p.mesh.getVertexPosition(i, v); else v.fromBufferAttribute(g.attributes.position, i);
          v.applyMatrix4(p.mesh.matrixWorld);
          world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
        }
        worldCache.set(p.mesh, world);
      }
      const index = g.index, uv = g.attributes.uv;
      for (let i = p.start; i < p.start + p.count; i++, w++) {
        const vi = index ? index.getX(i) : i;
        positions[w * 3] = world[vi * 3]; positions[w * 3 + 1] = world[vi * 3 + 1]; positions[w * 3 + 2] = world[vi * 3 + 2];
        if (uv) { attrs[w * 4] = uv.getX(vi); attrs[w * 4 + 1] = uv.getY(vi); }
        attrs[w * 4 + 2] = p.layer;
        attrs[w * 4 + 3] = p.opacity;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const attr = new THREE.BufferAttribute(attrs, 4);
    const bvh = new MeshBVH(geometry);
    this.uniforms.rtBvh.value.updateFrom(bvh);
    this.uniforms.rtAttr.value.updateFrom(attr);
    this.setAlphaLayers(layers);
    this.ready = true;
    this.stats = { triangles, alphaLayers: layers.size, ms: Math.round(performance.now() - started) };
    return true;
  }

  setAlphaLayers(layers) {
    const old = this.uniforms.rtAlpha.value;
    if (old !== this.emptyAlpha) old.dispose();
    if (!layers.size) { this.uniforms.rtAlpha.value = this.emptyAlpha; return; }
    const S = ALPHA_SIZE;
    const data = new Uint8Array(S * S * layers.size).fill(255);
    const canvas = new OffscreenCanvas(S, S);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const [tex, layer] of layers) {
      const out = data.subarray(layer * S * S, (layer + 1) * S * S);
      const img = tex.image;
      try {
        if (img.data && img.width) { // DataTexture (TGA): RGBA rows
          const ch = Math.round(img.data.length / (img.width * img.height));
          if (ch < 4) continue;
          for (let y = 0; y < S; y++) {
            const row = Math.min(img.height - 1, Math.floor(((y + 0.5) / S) * img.height));
            const sy = tex.flipY ? img.height - 1 - row : row;
            for (let x = 0; x < S; x++) {
              const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) / S) * img.width));
              out[y * S + x] = img.data[(sy * img.width + sx) * 4 + 3];
            }
          }
        } else {
          ctx.clearRect(0, 0, S, S);
          ctx.drawImage(img, 0, 0, S, S);
          const px = ctx.getImageData(0, 0, S, S).data;
          for (let y = 0; y < S; y++) {
            const sy = tex.flipY ? S - 1 - y : y; // texture row 0 is v = 0
            for (let x = 0; x < S; x++) out[y * S + x] = px[(sy * S + x) * 4 + 3];
          }
        }
      } catch { /* unreadable image: layer stays opaque */ }
    }
    const t = new THREE.DataArrayTexture(data, S, S, layers.size);
    t.format = THREE.RedFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    this.uniforms.rtAlpha.value = t;
  }
}

/** Progressive accumulation of full frames (also gives anti-aliasing through sub-pixel jitter). */
export class Accumulator {
  constructor(renderer) {
    this.renderer = renderer;
    this.count = 0;
    this.max = 160;
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.frame = new THREE.WebGLRenderTarget(1, 1, { ...opts, samples: 4 });
    this.accum = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
    this.blend = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this.frame.texture }, weight: { value: 1 } },
      vertexShader,
      fragmentShader: 'uniform sampler2D tex; uniform float weight; varying vec2 vUv; void main() { gl_FragColor = vec4( texture2D( tex, vUv ).rgb, weight ); }',
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.present = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this.accum.texture } },
      vertexShader,
      fragmentShader: 'uniform sampler2D tex; varying vec2 vUv; void main() { gl_FragColor = vec4( texture2D( tex, vUv ).rgb, 1.0 );\n#include <colorspace_fragment>\n}',
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blend);
    this.quad.frustumCulled = false;
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new THREE.Vector2();
  }

  reset() { this.count = 0; }
  get done() { return this.count >= this.max; }

  /** Render one more sample of the scene and show the running average. */
  render(scene, camera, seedUniform) {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = this.size.x, h = this.size.y;
    if (this.frame.width !== w || this.frame.height !== h) {
      this.frame.setSize(w, h);
      this.accum.setSize(w, h);
      this.count = 0;
    }
    const n = this.count;
    if (n > 0) camera.setViewOffset(w, h, halton(n, 2) - 0.5, halton(n, 3) - 0.5, w, h);
    seedUniform.value = n;
    r.setRenderTarget(this.frame);
    r.render(scene, camera);
    if (n > 0) camera.clearViewOffset();

    const autoClear = r.autoClear;
    r.autoClear = false;
    this.blend.uniforms.weight.value = 1 / (n + 1);
    this.quad.material = this.blend;
    r.setRenderTarget(this.accum);
    r.render(this.quad, this.quadCamera);
    this.quad.material = this.present;
    r.setRenderTarget(null);
    r.render(this.quad, this.quadCamera);
    r.autoClear = autoClear;
    this.count++;
  }
}

function halton(i, base) {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
