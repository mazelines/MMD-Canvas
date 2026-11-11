import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SoftShadows } from '../renderer/shadows.js';
import { Viewer } from '../renderer/viewer.js';

// Projection checks need real Three.js matrices, but no GPU or DOM.
const renderer = { getRenderTarget: () => null, setRenderTarget() {}, clear() {}, render() {} };

function assertInside(shadows, points) {
  for (const point of points) {
    const uv = point.clone().applyMatrix4(shadows.uniforms.shMatrix.value);
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(Number.isFinite(uv[axis]) && uv[axis] >= 0 && uv[axis] <= 1,
        `point ${point.toArray()} outside shadow ${axis}: ${uv[axis]}`);
    }
  }
}

function corners(box) {
  const points = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z));
  return points;
}

export function registerShadowTests(test) {
  test('shadows: model fits at oblique and vertical light angles, including flat bounds', () => {
    const shadows = new SoftShadows(renderer);
    const object = new THREE.Group();
    const boxes = [
      new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 20, 1)),
      new THREE.Box3(new THREE.Vector3(10000, -20000, 30000), new THREE.Vector3(10002, -19980, 30002)),
      new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 0, 5)),
      new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
    ];
    for (const box of boxes) {
      shadows.fit(box);
      for (const direction of [[1, 2, 3], [0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0.991, 0.1]]) {
        shadows.setLight(new THREE.Vector3(...direction), 0.03);
        shadows.renderMap(object);
        assertInside(shadows, corners(box));
        assert.ok(shadows.camera.near > 0 && shadows.camera.far > shadows.camera.near);
      }
    }
  });

  test('shadows: tall models gain horizontal texel density', () => {
    const shadows = new SoftShadows(renderer);
    shadows.fit(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 20, 1)));
    shadows.setLight(new THREE.Vector3(0, 0, 1), 0.03);
    shadows.renderMap(new THREE.Group());
    assert.ok(shadows.coverage.width < shadows.coverage.sphere / 4);
    assert.ok(shadows.coverage.height < shadows.coverage.sphere * 1.02);
  });

  test('shadows: PMX morph expansion and reset refresh model bounds without moving the view', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const object = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial());
    const shadows = new SoftShadows(renderer);
    shadows.fit(new THREE.Box3().setFromObject(object));
    const viewer = Object.create(Viewer.prototype);
    viewer.current = {
      kind: 'pmx', object, morphWeights: new Float32Array(1),
      basePositions: geometry.attributes.position.array.slice(),
      data: { morphs: [{ indices: [0], offsets: [20, 20, 20] }] },
    };
    viewer.shadows = shadows;
    viewer.shadow = { dirty: false };
    viewer.requestRender = () => {};
    viewer.frame = () => assert.fail('morph must not reset the user camera');
    for (const weight of [1, 0]) {
      viewer.setMorph(0, weight);
      shadows.renderMap(object);
      const positions = geometry.attributes.position;
      const points = Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i));
      assertInside(shadows, points);
      for (const point of points) {
        assert.ok(geometry.boundingBox.containsPoint(point));
        assert.ok(point.distanceTo(geometry.boundingSphere.center) <= geometry.boundingSphere.radius + 1e-9);
      }
      assert.ok(viewer.shadow.dirty);
    }
    assert.equal(geometry.boundingBox.max.x, 1);
  });
}
