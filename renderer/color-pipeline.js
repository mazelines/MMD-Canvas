import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GT7_GLSL } from './gt7-tonemapping.js';
import { normalizeExposure, exposureScale } from '../src/core/lighting.js';

// Linear Rec.709 (Linear-sRGB): the default Unreal working-space primaries.
// Color inputs decode into this space; data textures retain their numeric values.
THREE.ColorManagement.enabled = true;
THREE.ColorManagement.workingColorSpace = THREE.LinearSRGBColorSpace;

/** Keep lighting, transparency and shadow compositing linear until the display pass. */
export class LinearViewportPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: Math.min(4, renderer.capabilities.maxSamples),
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.name = 'Viewport Linear Rec.709 HDR';
    this.exposure = normalizeExposure();
    this.exposureUniform = { value: exposureScale(this.exposure.ev100, this.exposure.compensation) };
    this.backgroundColor = new THREE.Color();
    // No built-in material tone mapping: GT7 runs once, after linear compositing.
    this.outputMaterial = new THREE.RawShaderMaterial({
      name: 'GT7 SDR output',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { tDiffuse: { value: this.target.texture }, viewportExposure: this.exposureUniform },
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float viewportExposure;
        varying vec2 vUv;
        #include <colorspace_pars_fragment>
        ${GT7_GLSL}
        void main() {
          vec4 hdr = texture2D(tDiffuse, vUv);
          gl_FragColor = sRGBTransferOETF(vec4(gt7ToneMap(hdr.rgb * viewportExposure), hdr.a));
        }
      `,
    });
    this.output = new FullScreenQuad(this.outputMaterial);
    this.size = new THREE.Vector2();
    this.resize();
  }

  resize() {
    this.renderer.getDrawingBufferSize(this.size);
    this.target.setSize(Math.max(1, this.size.x), Math.max(1, this.size.y));
  }

  setExposure(ev100, compensation) {
    this.exposure = normalizeExposure(ev100, compensation);
    this.exposureUniform.value = exposureScale(this.exposure.ev100, this.exposure.compensation);
  }

  /** Editor helpers retain their chosen colors while physical model lighting is exposed. */
  protectEditorObject(object) {
    object.traverse(o => {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || m.userData.fixedViewportExposure) continue;
        m.userData.fixedViewportExposure = true;
        const compile = m.onBeforeCompile, cacheKey = m.customProgramCacheKey();
        m.onBeforeCompile = (shader, renderer) => {
          compile.call(m, shader, renderer);
          shader.uniforms.viewportExposure = this.exposureUniform;
          shader.fragmentShader = 'uniform float viewportExposure;\n' + shader.fragmentShader.replace(
            '#include <opaque_fragment>', 'outgoingLight = min(outgoingLight / viewportExposure, vec3(65504.0));\n#include <opaque_fragment>');
        };
        m.customProgramCacheKey = () => `${cacheKey}-editor-exposure-v1`;
        m.needsUpdate = true;
      }
    });
  }

  render(scene, camera) {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    const background = scene.background;
    try {
      if (background?.isColor) {
        scene.background = this.backgroundColor.copy(background).multiplyScalar(1 / this.exposureUniform.value);
        for (const channel of ['r', 'g', 'b']) scene.background[channel] = Math.min(scene.background[channel], 65504);
      }
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
      // GT7 then one Linear -> sRGB transfer, after blending and MSAA resolve.
      renderer.setRenderTarget(null);
      this.output.render(renderer);
    } finally { scene.background = background; renderer.setRenderTarget(previous); }
  }

  dispose() {
    this.target.dispose();
    this.outputMaterial.dispose();
    this.output.dispose();
  }
}
