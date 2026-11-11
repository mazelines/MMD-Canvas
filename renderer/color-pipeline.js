import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GT7_GLSL } from './gt7-tonemapping.js';

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
    // No built-in material tone mapping: GT7 runs once, after linear compositing.
    this.outputMaterial = new THREE.RawShaderMaterial({
      name: 'GT7 SDR output',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { tDiffuse: { value: this.target.texture } },
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
        varying vec2 vUv;
        #include <colorspace_pars_fragment>
        ${GT7_GLSL}
        void main() {
          vec4 hdr = texture2D(tDiffuse, vUv);
          gl_FragColor = sRGBTransferOETF(vec4(gt7ToneMap(hdr.rgb), hdr.a));
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

  render(scene, camera) {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
      // GT7 then one Linear -> sRGB transfer, after blending and MSAA resolve.
      renderer.setRenderTarget(null);
      this.output.render(renderer);
    } finally { renderer.setRenderTarget(previous); }
  }

  dispose() {
    this.target.dispose();
    this.outputMaterial.dispose();
    this.output.dispose();
  }
}
