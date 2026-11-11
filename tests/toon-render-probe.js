import * as THREE from 'three';
import { ViewportShading } from '../renderer/viewport-shading.js';
import { SoftShadows } from '../renderer/shadows.js';

/** Real GPU regression: count sphere tones and compare cast shadow with the unlit face. */
export function probeToonRendering() {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(600, 300);
  const target = new THREE.WebGLRenderTarget(600, 300);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const camera = new THREE.OrthographicCamera(-3, 3, 1.5, -1.5, 0.1, 20);
  camera.position.z = 10;
  const sun = new THREE.DirectionalLight(0xffffff, 180);
  sun.position.set(1, 0, 1);
  scene.add(sun, new THREE.HemisphereLight(0xffffff, 0xb4b8c0, 130));
  const shadows = new SoftShadows(renderer);
  const source = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.2, 96, 64), source);
  scene.add(sphere);
  const sphereShading = new ViewportShading(sphere, new THREE.Vector2(600, 300), { width: 0, color: '#000000' });
  sphereShading.apply('toon'); shadows.patch(sphere);
  const pixels = new Uint8Array(600 * 300 * 4);
  const draw = () => {
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 600, 300, pixels);
  };
  const sample = (x, y = 0) => {
    const index = (Math.floor((y + 1.5) * 100) * 600 + Math.floor((x + 3) * 100)) * 4;
    return Array.from(pixels.subarray(index, index + 3));
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  draw();
  const tones = new Set();
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 0) tones.add(pixels.slice(i, i + 3).join(','));
  check(tones.size === 2, `Untextured sphere must have exactly two tones, got ${tones.size}`);
  scene.remove(sphere); sphereShading.dispose(); sphere.geometry.dispose();

  const object = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), source);
  const dark = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1), source);
  dark.position.set(2, 0, 0.01);
  const normals = dark.geometry.attributes.normal;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -1, 0, 0);
  const blocker = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.1), source);
  blocker.position.set(0, 0, 1);
  object.add(receiver, dark, blocker); scene.add(object);
  const shading = new ViewportShading(object, new THREE.Vector2(600, 300), { width: 0, color: '#000000' });
  shading.apply('toon'); shadows.patch(object);
  draw();
  const lit = sample(-2), unlit = sample(2);
  check(lit[0] > unlit[0] + 15, 'Two tones have visible contrast');
  check(same(sample(-1), lit), 'Receiver is lit before enabling shadows');
  shadows.fit(new THREE.Box3().setFromObject(object));
  for (const softness of [0, 0.06]) {
    shadows.setLight(sun.position, softness); shadows.setEnabled(true); shadows.renderMap(object);
    draw();
    check(same(sample(-1), unlit), `Cast shadow uses the dark tone at softness ${softness}: ${sample(-1)} vs ${unlit}`);
    check(same(sample(-2), lit), 'Unoccluded light tone stays unchanged');
    check(same(sample(2), unlit), 'Unlit face is not darkened twice');
    for (let x = -1.6; x < -0.4; x += 0.01) {
      const value = sample(x)[0];
      check(value >= unlit[0] - 1 && value <= lit[0] + 1, 'Penumbra remains within the two tone endpoints');
    }
  }
  shadows.setEnabled(false); draw();
  check(same(sample(-1), lit), 'Disabling shadows restores the original lit tone');
  shadows.setEnabled(true);
  renderer.setRenderTarget(null); renderer.render(scene, camera);
  const screenshot = renderer.domElement.toDataURL();
  shading.dispose();
  for (const mesh of [receiver, dark, blocker]) mesh.geometry.dispose();
  source.dispose(); target.dispose(); shadows.clear(); shadows.target.dispose();
  shadows.ground.geometry.dispose(); shadows.ground.material.dispose(); renderer.dispose();
  return { tones: tones.size, lit, unlit, screenshot };
}
