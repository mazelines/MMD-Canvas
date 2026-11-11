// PCSS soft shadows for the viewer's main directional light.
//
// One depth map, fitted tightly to the loaded model, is rendered from the light. Lit materials get a
// shadow term injected that does a blocker search + variable-size PCF (percentage-closer soft shadows):
// sharp where the caster touches the receiver, wider the further they are apart. The map is only
// re-rendered when the model or the light changes, so the per-frame cost is a fixed number of taps.

import * as THREE from 'three';

const MAP_SIZE = 4096;
const BLOCKER_TAPS = 16;
const FILTER_TAPS = 32;

const SHADOW_GLSL = /* glsl */`
uniform sampler2D shMap;
uniform mat4 shMatrix;       // world -> shadow map uv + depth
uniform vec3 shLightDir;     // world space, towards the light
uniform float shLightTan;    // tan( angular radius of the light )
uniform float shRange;       // world length of the map's depth range
uniform vec2 shSize;         // world width / height covered by the map
uniform float shMaxRadius;   // world-space cap of the search / filter radius
uniform float shTexel;       // 1 / map resolution
uniform int shOn;
varying vec3 vShWorldPos;

float shNoise( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
vec2 shDisk( int i, int n, float phi ) {
	float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
	float a = float( i ) * 2.39996323 + phi;
	return r * vec2( cos( a ), sin( a ) );
}

// 1 = lit, 0 = fully shadowed
float sunShadow( vec3 P ) {
	if ( shOn == 0 ) return 1.0;
	vec3 L = shLightDir;
	vec3 ng = normalize( cross( dFdx( P ), dFdy( P ) ) );
	if ( dot( ng, L ) < 0.0 ) ng = - ng;
	float ndl = clamp( dot( ng, L ), 0.05, 1.0 );
	float slope = min( sqrt( 1.0 - ndl * ndl ) / ndl, 1.5 );
	float texelWorld = max( shSize.x, shSize.y ) * shTexel;

	vec4 sc = shMatrix * vec4( P + ng * texelWorld * 1.5, 1.0 );
	if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 ) return 1.0;
	float zr = sc.z;
	float zc = min( zr, 1.0 ); // receivers behind the map's far plane: empty texels ( depth 1 ) must not block
	float phi = shNoise( gl_FragCoord.xy ) * 6.2831853;
	// depth bias grows with the tap distance on surfaces tilted away from the light
	float biasBase = texelWorld * 1.5 * slope / shRange + 2e-5;
	float biasPerWorld = slope / shRange;

	// 1. blocker search: average depth of whatever is between this point and the light
	float searchRadius = clamp( max( zr, 0.0 ) * shRange * shLightTan, 2.0 * texelWorld, shMaxRadius );
	float blockerSum = 0.0, blockers = 0.0;
	for ( int i = 0; i < ${BLOCKER_TAPS}; i ++ ) {
		vec2 o = shDisk( i, ${BLOCKER_TAPS}, phi ) * searchRadius;
		float d = textureLod( shMap, sc.xy + o / shSize, 0.0 ).r;
		if ( d < zc - biasBase - length( o ) * biasPerWorld ) { blockerSum += d; blockers += 1.0; }
	}
	if ( blockers < 0.5 ) return 1.0;

	// 2. penumbra width from the receiver-blocker distance, 3. filter with that radius
	float penumbra = ( zr - blockerSum / blockers ) * shRange * shLightTan;
	float filterRadius = clamp( penumbra, 1.5 * texelWorld, shMaxRadius );
	float lit = 0.0;
	for ( int i = 0; i < ${FILTER_TAPS}; i ++ ) {
		vec2 o = shDisk( i, ${FILTER_TAPS}, phi + 1.7 ) * filterRadius;
		float d = textureLod( shMap, sc.xy + o / shSize, 0.0 ).r;
		lit += d < zc - biasBase - length( o ) * biasPerWorld ? 0.0 : 1.0;
	}
	return lit / float( ${FILTER_TAPS} );
}
`;

const DIR_LIGHT_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';
const LIGHTS_CHUNK = THREE.ShaderChunk.lights_fragment_begin.replace(
  DIR_LIGHT_LINE,
  `${DIR_LIGHT_LINE}
		#if ( UNROLLED_LOOP_INDEX == 0 )
		#ifdef TOON
		// Cast shadows converge on the same dark tone as the unlit face.
		// Multiplying visibility directly would introduce a third, darker tone.
		float toonBand = getGradientIrradiance( geometryNormal, directLight.direction ).r;
		#ifdef USE_GRADIENTMAP
		float toonDark = texture2D( gradientMap, vec2( 0.0 ) ).r;
		#else
		float toonDark = 0.7;
		#endif
		directLight.color *= mix( toonDark, toonBand, sunShadow( vShWorldPos ) ) / max( toonBand, 0.00001 );
		#else
		if ( dot( geometryNormal, directLight.direction ) > 0.0 ) directLight.color *= sunShadow( vShWorldPos );
		#endif
		#endif`,
);
if (LIGHTS_CHUNK === THREE.ShaderChunk.lights_fragment_begin) console.warn('shadows: three.js light chunk changed, shadows will not be applied');

// A normal-dependent hemisphere fill would add a continuous gradient over both tones.
const TOON_LIGHTS_CHUNK = LIGHTS_CHUNK.replace(
  'getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )',
  '( hemisphereLights[ i ].skyColor + hemisphereLights[ i ].groundColor ) * 0.5',
);

const WORLD_POS_VERTEX = /* glsl */`
	vec4 shWorldPos = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
	shWorldPos = instanceMatrix * shWorldPos;
	#endif
	vShWorldPos = ( modelMatrix * shWorldPos ).xyz;
`;

const isLit = (m) => m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshStandardMaterial || m.isMeshToonMaterial;
const materialsOf = (o) => (Array.isArray(o.material) ? o.material : [o.material]);

export class SoftShadows {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(MAP_SIZE, MAP_SIZE, {
      format: THREE.RedFormat,
      depthTexture: new THREE.DepthTexture(MAP_SIZE, MAP_SIZE, THREE.FloatType),
    });
    this.target.depthTexture.minFilter = this.target.depthTexture.magFilter = THREE.NearestFilter;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.center = new THREE.Vector3();
    this.box = new THREE.Box3();
    this.radius = 1;
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.uniforms = {
      shMap: { value: this.target.depthTexture },
      shMatrix: { value: new THREE.Matrix4() },
      shLightDir: { value: this.lightDir },
      shLightTan: { value: 0.03 },
      shRange: { value: 1 },
      shSize: { value: new THREE.Vector2(1, 1) },
      shMaxRadius: { value: 0.1 },
      shTexel: { value: 1 / MAP_SIZE },
      shOn: { value: 0 },
    };
    this.enabled = false;
    this.ready = false;            // the map holds the current model
    this.depthMaterials = new Map(); // model material -> { key, material }

    // shadow catcher under the model
    this.groundUniforms = { ...this.uniforms, shFade: { value: 1 }, shDarkness: { value: 0.5 }, shCenter: { value: new THREE.Vector3() } };
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: this.groundUniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */`
          varying vec3 vShWorldPos;
          void main() {
            vec4 wp = modelMatrix * vec4( position, 1.0 );
            vShWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          ${SHADOW_GLSL}
          uniform float shFade;
          uniform float shDarkness;
          uniform vec3 shCenter;
          void main() {
            float fade = 1.0 - smoothstep( 0.55, 1.0, length( vShWorldPos.xz - shCenter.xz ) / shFade );
            if ( fade <= 0.0 ) discard;
            gl_FragColor = vec4( 0.0, 0.0, 0.0, ( 1.0 - sunShadow( vShWorldPos ) ) * shDarkness * fade );
          }`,
      }),
    );
    this.ground.visible = false;
    this.ground.renderOrder = -1;
  }

  /** Inject the shadow term into every lit material of the object (cheap no-op while disabled). */
  patch(object) {
    const uniforms = this.uniforms;
    object.traverse((o) => {
      if (!o.isMesh || !o.material || o.userData.viewportOutline) return;
      for (const m of materialsOf(o)) {
        if (!m || !isLit(m) || m.userData.shPatched) continue;
        m.userData.shPatched = true;
        m.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, uniforms);
          shader.vertexShader = 'varying vec3 vShWorldPos;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_POS_VERTEX}`);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${SHADOW_GLSL}`)
            .replace('#include <lights_fragment_begin>', m.isMeshToonMaterial ? TOON_LIGHTS_CHUNK : LIGHTS_CHUNK);
        };
        m.customProgramCacheKey = () => m.isMeshToonMaterial ? 'pcss-shadow-toon-two-tone-v2' : 'pcss-shadow';
        m.needsUpdate = true;
      }
    });
  }

  setEnabled(on) {
    this.enabled = on;
    this.uniforms.shOn.value = on && this.ready ? 1 : 0;
    this.ground.visible = on && this.ready;
  }

  /** @param {THREE.Vector3} direction towards the light  @param {number} tan tan of its angular radius */
  setLight(direction, tan) {
    this.lightDir.copy(direction).normalize();
    this.uniforms.shLightTan.value = tan;
  }

  /** Fit the shadow map and the shadow catcher to the model's bounds. */
  fit(box) {
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.center);
    this.box.copy(box);
    this.radius = Math.max(size.length() / 2, 1e-4) * 1.06;
    const reach = Math.max(size.x, size.y, size.z) * 3;
    this.ground.position.set(this.center.x, box.min.y, this.center.z);
    this.ground.scale.setScalar(reach * 2);
    this.ground.updateMatrixWorld(true);
    this.groundUniforms.shCenter.value.copy(this.ground.position);
    this.groundUniforms.shFade.value = reach;
  }

  clear() {
    for (const e of this.depthMaterials.values()) e.material.dispose();
    this.depthMaterials.clear();
    this.ready = false;
    this.setEnabled(this.enabled);
  }

  /** Depth-only stand-in for a model material: keeps texture cut-outs, drops everything else. */
  depthMaterial(m) {
    const cutout = !!m.map && (m.transparent || m.alphaTest > 0);
    const opacity = m.transparent ? m.opacity : 1;
    const key = `${cutout ? m.map.uuid : ''}|${opacity}`;
    let e = this.depthMaterials.get(m);
    if (!e || e.key !== key) {
      e?.material.dispose();
      e = {
        key,
        material: new THREE.MeshBasicMaterial({
          map: cutout ? m.map : null,
          opacity,
          alphaTest: cutout || opacity < 1 ? 0.5 : 0,
          side: THREE.DoubleSide,
          colorWrite: false,
        }),
      };
      this.depthMaterials.set(m, e);
    }
    e.material.visible = m.visible && opacity >= 0.5;
    return e.material;
  }

  /** Render the model's depth from the light. Call when the model or the light changed. */
  renderMap(object) {
    // Fit the map to the model as seen from the light (its bounding box in light space), not to a
    // bounding sphere: a tall, narrow model then uses the whole map instead of a strip of it.
    const r = this.radius, cam = this.camera, L = this.lightDir;
    cam.up.set(0, 1, 0);
    if (Math.abs(L.y) > 0.99) cam.up.set(0, 0, 1);
    cam.position.copy(this.center).addScaledVector(L, r * 2);
    cam.lookAt(this.center);
    cam.updateMatrixWorld(true);
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const corner = new THREE.Vector3();
    const b = this.box;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(cam.matrixWorldInverse);
      lo.min(corner); hi.max(corner);
    }
    // margin: morphs may push vertices slightly past the measured bounds
    const padX = (hi.x - lo.x) * 0.03 + r * 0.01, padY = (hi.y - lo.y) * 0.03 + r * 0.01, padZ = r * 0.05;
    cam.left = lo.x - padX; cam.right = hi.x + padX;
    cam.bottom = lo.y - padY; cam.top = hi.y + padY;
    cam.near = Math.max(-hi.z - padZ, r * 0.01); cam.far = -lo.z + padZ;
    cam.updateProjectionMatrix();
    this.uniforms.shMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.uniforms.shRange.value = cam.far - cam.near;
    this.uniforms.shSize.value.set(cam.right - cam.left, cam.top - cam.bottom);
    this.uniforms.shMaxRadius.value = r * 0.1;
    this.coverage = { width: cam.right - cam.left, height: cam.top - cam.bottom, sphere: r * 2 };

    // swap in depth materials, hide non-mesh helpers of the model (points, lines)
    const swapped = [], hidden = [];
    object.traverse((o) => {
      if (o.userData.viewportOutline) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
      if (!o.material) return;
      if (!o.isMesh) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
      swapped.push(o, o.material);
      o.material = Array.isArray(o.material) ? o.material.map((m) => this.depthMaterial(m)) : this.depthMaterial(o.material);
    });
    const renderer = this.renderer;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, true);
    renderer.render(object, cam);
    renderer.setRenderTarget(prev);
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    hidden.forEach((o) => { o.visible = true; });

    this.ready = true;
    this.setEnabled(this.enabled);
  }
}
