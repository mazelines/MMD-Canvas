import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ModelAnimation, playableClips } from '../renderer/animation.js';
import { Viewer } from '../renderer/viewer.js';

/**
 * A two-joint skinned strip (0..2 on Y) with two clips: "Bend" turns the upper joint by 90 degrees
 * and back over 2 s, "Slide" moves the whole rig 3 units along X in 1 s. Used by the UI smoke test too.
 */
export function makeAnimatedGltf(file) {
  const chunks = [], bufferViews = [], accessors = [];
  let offset = 0;
  const add = (typed, type, extra = {}) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    offset += padded.length;
    chunks.push(padded);
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const componentType = typed instanceof Float32Array ? 5126 : typed instanceof Uint16Array ? 5123 : 5121;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: typed.length / size, type, ...extra });
    return accessors.length - 1;
  };
  const s = Math.SQRT1_2;
  const position = add(new Float32Array([-0.2, 0, 0, 0.2, 0, 0, -0.2, 1, 0, 0.2, 1, 0, -0.2, 2, 0, 0.2, 2, 0]), 'VEC3', { min: [-0.2, 0, 0], max: [0.2, 2, 0] });
  const normal = add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3');
  const joints = add(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4');
  const weights = add(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4');
  const indices = add(new Uint16Array([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]), 'SCALAR');
  const inverseBind = add(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]), 'MAT4');
  const bendTimes = add(new Float32Array([0, 1, 2]), 'SCALAR', { min: [0], max: [2] });
  const bendRotations = add(new Float32Array([0, 0, 0, 1, 0, 0, s, s, 0, 0, 0, 1]), 'VEC4');
  const slideTimes = add(new Float32Array([0, 1]), 'SCALAR', { min: [0], max: [1] });
  const slideTranslations = add(new Float32Array([0, 0, 0, 3, 0, 0]), 'VEC3');
  const gltf = {
    asset: { version: '2.0', generator: 'mmd-converter tests' },
    scene: 0,
    scenes: [{ nodes: [0, 3] }],
    nodes: [
      { name: 'Rig', children: [1] },
      { name: 'Lower', children: [2] },
      { name: 'Upper', translation: [0, 1, 0] },
      { name: 'Strip', mesh: 0, skin: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal, JOINTS_0: joints, WEIGHTS_0: weights }, indices, material: 0 }] }],
    materials: [{ name: 'Strip', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.4, 0.7, 0.9, 1], metallicFactor: 0 } }],
    skins: [{ joints: [1, 2], inverseBindMatrices: inverseBind, skeleton: 1 }],
    animations: [
      { name: 'Bend', samplers: [{ input: bendTimes, output: bendRotations }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] },
      { name: 'Slide', samplers: [{ input: slideTimes, output: slideTranslations }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
    ],
    accessors, bufferViews,
    buffers: [{ byteLength: offset, uri: `data:application/octet-stream;base64,${Buffer.concat(chunks).toString('base64')}` }],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(gltf));
  return file;
}

async function loadSample(file) {
  // three.js reports download progress for the embedded buffer; Node has no ProgressEvent.
  globalThis.ProgressEvent ??= class ProgressEvent extends Event {};
  const text = fs.readFileSync(makeAnimatedGltf(file), 'utf8');
  const gltf = await new GLTFLoader().parseAsync(text, '');
  gltf.scene.updateMatrixWorld(true);
  return gltf;
}

const tipOf = (root) => new THREE.Vector3().setFromMatrixPosition(root.getObjectByName('Upper').matrixWorld);

export function registerAnimationTests(test, sampleFile) {
  test('animation: clips without tracks or length are not offered', () => {
    const derived = new THREE.AnimationClip('derived', -1, [new THREE.NumberKeyframeTrack('.visible', [0, 2], [0, 1])]);
    const clips = playableClips([
      new THREE.AnimationClip('empty', 1, []),
      new THREE.AnimationClip('pose', -1, [new THREE.NumberKeyframeTrack('.visible', [0], [1])]),
      derived, null,
    ]);
    assert.deepEqual(clips.map((clip) => clip.name), ['derived']);
    assert.equal(derived.duration, 2);
    assert.deepEqual(playableClips(undefined), []);
  });

  test('animation: glTF clips play, loop, stop at the end and scrub', async () => {
    const gltf = await loadSample(sampleFile);
    const animation = new ModelAnimation(gltf.scene, playableClips(gltf.animations));
    const upper = gltf.scene.getObjectByName('Upper');
    const angle = () => 2 * Math.atan2(upper.quaternion.z, upper.quaternion.w);
    assert.deepEqual(animation.state().clips, [{ name: 'Bend', duration: 2 }, { name: 'Slide', duration: 1 }]);
    assert.equal(animation.advance(0.5), false, 'paused clips do not move');

    animation.play();
    assert.equal(animation.advance(0.5), true);
    assert.ok(Math.abs(angle() - Math.PI / 4) < 0.03, `half-way to 90 degrees, got ${angle()}`);
    animation.setSpeed(2);
    animation.advance(0.25);
    assert.ok(Math.abs(animation.time - 1) < 1e-9 && Math.abs(angle() - Math.PI / 2) < 1e-6, 'speed scales time');
    animation.setSpeed(1);
    animation.advance(1.5);
    assert.ok(animation.playing && Math.abs(animation.time - 0.5) < 1e-9, 'looping wraps past the end');

    animation.loop = false;
    animation.advance(5);
    assert.ok(!animation.playing && animation.time === 2 && Math.abs(angle()) < 1e-6, 'play once holds the last frame');
    animation.play();
    assert.equal(animation.time, 0, 'playing a finished clip starts over');

    animation.pause();
    animation.seek(1);
    assert.ok(Math.abs(angle() - Math.PI / 2) < 1e-6, 'scrubbing poses a paused model');
    animation.seek(99);
    assert.equal(animation.time, 2);
    animation.seek(NaN);
    assert.equal(animation.time, 0);
  });

  test('animation: switching clips resets the previous one', async () => {
    const gltf = await loadSample(sampleFile);
    const animation = new ModelAnimation(gltf.scene, playableClips(gltf.animations));
    animation.seek(1);
    assert.equal(animation.select(1), true);
    assert.equal(animation.select(1), false);
    assert.equal(animation.select(7), false);
    assert.equal(animation.time, 0);
    assert.ok(Math.abs(gltf.scene.getObjectByName('Upper').quaternion.z) < 1e-9, 'bend released');
    animation.seek(1);
    assert.equal(gltf.scene.getObjectByName('Rig').position.x, 3);
    animation.dispose();
  });

  test('animation: swept bounds cover the whole motion and keep the playhead', async () => {
    const gltf = await loadSample(sampleFile);
    const animation = new ModelAnimation(gltf.scene, playableClips(gltf.animations));
    const mesh = gltf.scene.getObjectByName('Strip');
    assert.equal(mesh.frustumCulled, false, 'an animated skin must not be culled by its rest bounds');
    animation.seek(0.3);
    const bend = animation.sweptBounds();
    assert.equal(animation.time, 0.3);
    assert.equal(animation.sweptBounds(), bend, 'cached per clip');
    // bent by 90 degrees the tip of the strip reaches x = -1
    const vertex = new THREE.Vector3();
    for (const time of [0, 0.5, 1, 1.5, 2]) {
      animation.seek(time);
      gltf.scene.updateMatrixWorld(true);
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
        assert.ok(bend.distanceToPoint(vertex) < 1e-4, `vertex ${vertex.toArray()} outside swept bounds at ${time}s`);
      }
    }
    assert.ok(bend.max.y <= 2 + 1e-6 && bend.min.y >= -1 - 1e-6 && bend.min.x >= -2 - 1e-6, 'bounds stay within one skin margin of the joints');
    animation.select(1);
    const slide = animation.sweptBounds();
    assert.ok(slide.max.x >= 3.2 && slide.max.x <= 4 + 1e-6 && slide.min.x <= -0.2, 'root motion widens the bounds');
    gltf.scene.updateMatrixWorld(true);
    assert.equal(tipOf(gltf.scene).x, 0, 'sampling restores the pose');
  });

  test('animation: viewer playback refreshes shadows, the UI and survives models without clips', async () => {
    const gltf = await loadSample(sampleFile);
    const animation = new ModelAnimation(gltf.scene, playableClips(gltf.animations));
    const viewer = Object.create(Viewer.prototype);
    const states = [];
    let renders = 0;
    viewer.current = { object: gltf.scene, animation };
    viewer.shadow = { groundY: 0 };
    viewer.requestRender = () => { renders++; };
    viewer.onAnimationFrame = (state) => states.push(state);

    viewer.setAnimationPlaying(true);
    assert.ok(viewer.getAnimation().playing && viewer.nativeRevision === 1 && renders === 1);
    viewer.seekAnimation(1.25);
    assert.equal(states.at(-1).time, 1.25);
    viewer.setAnimationSpeed(0.5);
    viewer.setAnimationLoop(false);
    assert.deepEqual([states.at(-1).speed, states.at(-1).loop], [0.5, false]);
    viewer.setAnimationSpeed(-1);
    assert.equal(viewer.getAnimation().speed, 0.5, 'invalid speed ignored');
    viewer.setAnimationClip(1);
    assert.equal(states.at(-1).index, 1);
    assert.equal(viewer.shadow.groundY, 0, 'shadow catcher keeps its height under looser bounds');
    const count = states.length;
    viewer.setAnimationClip(1);
    assert.equal(states.length, count, 'reselecting the clip is a no-op');

    viewer.current = { object: gltf.scene };
    assert.equal(viewer.getAnimation(), null);
    for (const call of [() => viewer.setAnimationPlaying(true), () => viewer.seekAnimation(1), () => viewer.setAnimationClip(0), () => viewer.setAnimationLoop(true), () => viewer.setAnimationSpeed(2)]) call();
    viewer.current = null;
    assert.equal(viewer.getAnimation(), null);
    assert.equal(states.length, count);
  });
}
