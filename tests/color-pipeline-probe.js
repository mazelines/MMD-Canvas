import * as THREE from 'three';
import { LinearViewportPipeline } from '../renderer/color-pipeline.js';

export async function probeColorPipeline() {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(32, 32);
  const pipeline = new LinearViewportPipeline(renderer);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); scene.add(plane);
  const linearPixel = new Uint16Array(4), screenPixel = new Uint8Array(4);
  const draw = () => {
    pipeline.render(scene, camera);
    const gl = renderer.getContext();
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, screenPixel);
    renderer.readRenderTargetPixels(pipeline.target, 16, 16, 1, 1, linearPixel);
    return { linear: Array.from(linearPixel.slice(0, 3), THREE.DataUtils.fromHalfFloat), display: [...screenPixel.slice(0, 3)] };
  };
  const near = (a, b, epsilon = 0.001) => Math.abs(a - b) <= epsilon;
  const srgb = x => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
  check(THREE.ColorManagement.enabled && THREE.ColorManagement.workingColorSpace === THREE.LinearSRGBColorSpace, 'Explicit linear Rec.709 working space');
  check(renderer.toneMapping === THREE.NoToneMapping, 'No additional built-in tone mapper');

  material.color.setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace);
  const opaqueHalf = draw();
  check(opaqueHalf.linear.every(x => near(x, 0.5)), 'Linear numeric material color remains 0.5');
  material.color.setRGB(1, 1, 1); material.opacity = 0.5; material.transparent = true; material.needsUpdate = true;
  const blended = draw();
  check(blended.linear.every(x => near(x, 0.5)), '50% white over black composites to 0.5 linear');
  check(blended.display.every((x, i) => x === opaqueHalf.display[i]), 'GT7 runs after transparency blending');
  material.opacity = 1; material.transparent = false; material.needsUpdate = true;

  const texture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
  material.map = texture; material.needsUpdate = true;
  const colorInput = draw();
  check(colorInput.linear.every(x => near(x, 0.2158605)), 'sRGB texture decodes exactly once before lighting');
  texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true; material.needsUpdate = true;
  const dataInput = draw();
  check(dataInput.linear.every(x => near(x, 128 / 255)), 'Data texture values bypass color decoding');
  material.map = null; material.needsUpdate = true;

  const reference = await (await fetch('../tests/gt7-reference.json')).json();
  let maximumByteError = 0;
  for (const sample of reference.samples) {
    material.color.setRGB(...sample.input, THREE.LinearSRGBColorSpace);
    const result = draw();
    if (sample.input.every(x => x === 4)) check(result.linear.every(x => near(x, 4)), 'HDR values survive until the output pass');
    sample.output.forEach((value, channel) => {
      const error = Math.abs(result.display[channel] - srgb(value));
      maximumByteError = Math.max(maximumByteError, error);
      check(error <= 2, `GT7 reference mismatch: ${sample.input}, channel ${channel}, ${result.display[channel]} vs ${srgb(value)}`);
    });
  }
  renderer.setPixelRatio(2); renderer.setSize(21, 17); pipeline.resize();
  check(pipeline.target.width === 42 && pipeline.target.height === 34, 'HDR target follows physical viewport resolution');
  material.color.setRGB(0.5, 0.5, 0.5); draw();
  check(renderer.getRenderTarget() === null && !renderer.getContext().isContextLost(), 'Output restores the default framebuffer');
  pipeline.dispose(); texture.dispose(); plane.geometry.dispose(); material.dispose(); renderer.dispose();
  return { linearHalf: blended.linear, sRGB128: colorInput.linear, data128: dataInput.linear, referenceSamples: reference.samples.length, maximumByteError };
}
