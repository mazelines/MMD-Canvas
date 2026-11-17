import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Viewer } from '../renderer/viewer.js';

export function registerShadowTests(test) {
  test('shadows: PMX morph expansion and reset refresh model bounds without moving the view', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const object = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial());
    const viewer = Object.create(Viewer.prototype);
    viewer.current = {
      kind: 'pmx', object, morphWeights: new Float32Array(1),
      basePositions: geometry.attributes.position.array.slice(),
      data: { morphs: [{ indices: [0], offsets: [20, 20, 20] }] },
    };
    viewer.shadow = { groundY: 0 };
    viewer.requestRender = () => {};
    viewer.frame = () => assert.fail('morph must not reset the user camera');
    for (const weight of [1, 0]) {
      viewer.setMorph(0, weight);
      const positions = geometry.attributes.position;
      const points = Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i));
      for (const point of points) {
        assert.ok(geometry.boundingBox.containsPoint(point));
        assert.ok(point.distanceTo(geometry.boundingSphere.center) <= geometry.boundingSphere.radius + 1e-9);
      }
      assert.ok(viewer.nativeRevision > 0);
    }
    assert.equal(geometry.boundingBox.max.x, 1);
  });
}
