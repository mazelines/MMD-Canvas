import * as THREE from 'three';
import { LinearViewportPipeline } from '../renderer/color-pipeline.js';
import { SoftShadows } from '../renderer/shadows.js';
import { ViewportShading } from '../renderer/viewport-shading.js';
import { LEGACY_EV100 } from '../src/core/lighting.js';

export async function probeColorPipeline() {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(32, 32);
  const pipeline = new LinearViewportPipeline(renderer);
  check(pipeline.exposure.ev100 === 0 && pipeline.exposure.compensation === 0, 'Manual EV100 defaults to zero');
  pipeline.setExposure(LEGACY_EV100, 0); // Reference fixtures provide normalized GT7 inputs directly.
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
  // Photometric Lambert: actual lux reaches the uniform, rho/PI yields cd/m²,
  // then the shader encodes that result in the 100 cd/m² GT7 framebuffer scale.
  const lambert = new THREE.MeshLambertMaterial({ color: 0xffffff });
  plane.material = lambert;
  const sun = new THREE.DirectionalLight(0xffffff, 6); sun.position.set(0, 0, 1); scene.add(sun);
  const shadows = new SoftShadows(renderer); shadows.patch(plane);
  const white6 = draw().linear[0];
  check(near(white6 * 100, 6 / Math.PI, 0.002), `6 lux white Lambert: ${white6 * 100} cd/m²`);
  lambert.color.setRGB(0.18, 0.18, 0.18, THREE.LinearSRGBColorSpace);
  const gray6 = draw().linear[0];
  check(near(gray6 * 100, 0.18 * 6 / Math.PI, 0.0005), '18% gray uses physical reflectance / PI');
  sun.intensity = 12;
  check(near(draw().linear[0], gray6 * 2, 0.00001), 'Doubling lux doubles pre-tone-map luminance');
  sun.intensity = 6; plane.rotation.y = Math.PI / 3;
  check(near(draw().linear[0] * 100, 0.18 * 6 * 0.5 / Math.PI, 0.0005), '60-degree incidence follows cosine law');
  plane.rotation.y = 0; sun.position.z = 1000;
  check(near(draw().linear[0], gray6, 0.00001), 'Directional illuminance does not attenuate with distance');
  sun.position.z = -1;
  check(draw().linear.every(x => x === 0), 'Back-facing Lambert surface receives no direct light');
  sun.position.z = 1; sun.intensity = 0;
  check(draw().linear.every(x => x === 0), 'Zero lux produces no hidden diffuse illumination');

  lambert.emissive.setRGB(1, 1, 1); lambert.emissiveIntensity = 0.5;
  pipeline.setExposure(0, 0);
  const emitted = draw();
  check(near(emitted.linear[0], 0.5 / 100, 0.00001), 'Emission 0.5 cd/m² uses the same framebuffer scale as diffuse');
  const halfReference = reference.samples.find(s => s.input.every(x => x === 0.5));
  check(emitted.display.every((x, i) => Math.abs(x - srgb(halfReference.output[i])) <= 1), 'EV100 zero passes physical luminance into GT7');
  pipeline.setExposure(1, 0);
  const ev1 = draw();
  check(near(ev1.linear[0], emitted.linear[0], 0.000001), 'Exposure leaves physical scene luminance unchanged');
  pipeline.setExposure(1, 1);
  check(draw().display.every((x, i) => x === emitted.display[i]), '+1 compensation cancels +1 EV100');
  pipeline.setExposure(0, 0); lambert.emissiveIntensity = 0.25;
  check(draw().display.every((x, i) => x === ev1.display[i]), '+1 EV100 equals halving luminance before GT7');
  lambert.emissiveIntensity = 0.5; lambert.color.setRGB(1, 1, 1); sun.intensity = 6;
  check(near(draw().linear[0] * 100, 6 / Math.PI + 0.5, 0.003), 'Diffuse and emission add in cd/m² before exposure');
  sun.intensity = 0;
  const emissiveMap = new THREE.DataTexture(new Uint8Array([128,128,128,255]), 1, 1);
  emissiveMap.colorSpace = THREE.SRGBColorSpace; emissiveMap.needsUpdate = true;
  lambert.emissiveMap = emissiveMap; lambert.emissiveIntensity = 10; lambert.needsUpdate = true;
  check(near(draw().linear[0] * 100, 10 * 0.2158605, 0.003), 'Emissive texture decodes to linear before cd/m² scaling');
  lambert.emissiveMap = null; lambert.emissiveIntensity = 0.5; lambert.needsUpdate = true;
  const shading = new ViewportShading(plane, new THREE.Vector2(32,32), {width:0,color:'#000000'});
  shading.setEmission(lambert, 0.5);
  for (const mode of ['lambert','toon']) {
    shading.apply(mode); shadows.patch(plane);
    check(near(draw().linear[0] * 100, 0.5, 0.001), `${mode} preserves physical emission`);
    shading.setEmission(lambert, 0);
    check(draw().linear.every(x => x === 0), `${mode} emission zero disables emission`);
    shading.setEmission(lambert, 0.5);
  }
  check(lambert.emissiveIntensity === 0.5, 'Viewport emission overrides preserve imported values');
  shading.dispose(); emissiveMap.dispose();
  plane.material = material; scene.remove(sun); lambert.dispose();
  shadows.clear(); shadows.target.dispose(); shadows.ground.geometry.dispose(); shadows.ground.material.dispose();
  renderer.setPixelRatio(2); renderer.setSize(21, 17); pipeline.resize();
  check(pipeline.target.width === 42 && pipeline.target.height === 34, 'HDR target follows physical viewport resolution');
  material.color.setRGB(0.5, 0.5, 0.5);
  pipeline.protectEditorObject(plane);
  pipeline.setExposure(0, 0); const helper = draw();
  pipeline.setExposure(4, 0);
  check(draw().display.every((x, i) => Math.abs(x - helper.display[i]) <= 1), 'Editor colors are independent of camera exposure');
  check(renderer.getRenderTarget() === null && !renderer.getContext().isContextLost(), 'Output restores the default framebuffer');
  pipeline.dispose(); texture.dispose(); plane.geometry.dispose(); material.dispose(); renderer.dispose();
  return { linearHalf: blended.linear, sRGB128: colorInput.linear, data128: dataInput.linear, referenceSamples: reference.samples.length, maximumByteError,
    white6LuxNits: white6 * 100, gray6LuxNits: gray6 * 100 };
}
