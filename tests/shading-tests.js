import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SmoothHullGeometry } from '../renderer/smooth-normals.js';
import { ViewportShading } from '../renderer/viewport-shading.js';

export function registerShadingTests(test) {
  test('outline: hard-edge cube seams weld to angle-weighted normals without changing source channels', () => {
    for (const geometry of [new THREE.BoxGeometry(), new THREE.BoxGeometry().toNonIndexed()]) {
      const sourceNormals = geometry.attributes.normal.array.slice();
      const smooth = new SmoothHullGeometry(geometry);
      const mesh = new THREE.Mesh(geometry);
      assert.equal(smooth.weld.count, 8);
      assert.equal(smooth.update(mesh), true);
      assert.equal(smooth.update(mesh), false, 'unchanged frames reuse normals');
      for (let i = 0; i < geometry.attributes.position.count; i++) {
        const expected = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i).normalize();
        const actual = new THREE.Vector3().fromBufferAttribute(smooth.geometry.attributes.normal, i);
        assert.ok(expected.distanceTo(actual) < 1e-6, 'all face/UV copies have the same smooth normal');
      }
      assert.deepEqual(geometry.attributes.normal.array, sourceNormals);
      assert.equal(smooth.geometry.attributes.uv, geometry.attributes.uv);
      assert.equal(smooth.geometry.index, geometry.index);
    }
  });

  test('outline: PMX position edits and GPU morph weights refresh normals only when changed', () => {
    const geometry = new THREE.BoxGeometry();
    const target = geometry.attributes.position.clone();
    for (let i = 0; i < target.count; i++) target.setXYZ(i, target.getY(i) > 0 ? 0.6 : 0, 0, 0);
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [target];
    const mesh = new THREE.Mesh(geometry);
    const smooth = new SmoothHullGeometry(geometry);
    smooth.update(mesh);
    const initial = smooth.geometry.attributes.normal.array.slice();
    mesh.morphTargetInfluences[0] = 1;
    assert.equal(smooth.update(mesh), true);
    assert.notDeepEqual(smooth.geometry.attributes.normal.array, initial);
    assert.equal(smooth.update(mesh), false);
    mesh.morphTargetInfluences[0] = 0;
    smooth.update(mesh);
    assert.deepEqual(smooth.geometry.attributes.normal.array, initial);
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + (p.getY(i) > 0 ? 0.5 : 0));
    p.needsUpdate = true;
    assert.equal(smooth.update(mesh), true);
    assert.notDeepEqual(smooth.geometry.attributes.normal.array, initial);
    const seen = new Map();
    for (let i = 0; i < p.count; i++) {
      const normal = Array.from(smooth.geometry.attributes.normal.array.subarray(i * 3, i * 3 + 3));
      const group = smooth.weld.groups[i];
      if (seen.has(group)) assert.deepEqual(normal, seen.get(group));
      seen.set(group, normal);
    }
  });

  test('shading: modes, alpha, visibility, outline controls and disposal preserve source assets', () => {
    const source = new THREE.MeshStandardMaterial({ color: 0x957246, side: THREE.DoubleSide });
    source.map = new THREE.Texture();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
    const shading = new ViewportShading(mesh);
    shading.apply('lambert');
    assert.ok(mesh.material.isMeshLambertMaterial);
    assert.equal(shading.bindings[0].hull, undefined, 'Lambert does not pay for outline geometry');
    shading.apply('toon');
    const hull = shading.bindings[0].hull;
    const toon = mesh.material;
    assert.ok(toon.isMeshToonMaterial);
    assert.equal(toon.map, source.map);
    assert.equal(hull.visible, true);
    assert.equal(hull.material.side, THREE.BackSide);
    assert.notEqual(hull.geometry.attributes.normal, mesh.geometry.attributes.normal);
    source.transparent = true; source.alphaTest = 0.02; source.visible = false;
    shading.sync();
    assert.equal(toon.transparent, true);
    assert.equal(toon.alphaTest, 0.02);
    assert.equal(hull.material.visible, false);
    assert.equal(hull.material.map, source.map);
    source.visible = true;
    shading.setOutline(3.2, '#ee2255');
    assert.equal(shading.outlineWidth.value, 3.2);
    assert.equal(hull.material.color.getHexString(), 'ee2255');
    shading.setOutline(0, '#ee2255');
    assert.equal(hull.material.visible, false);
    shading.setOutline(1.6, '#151923');
    shading.apply('lambert'); shading.apply('toon');
    assert.equal(mesh.material, toon, 'material variants are reused');
    let sourceDisposed = false, textureDisposed = false;
    source.addEventListener('dispose', () => { sourceDisposed = true; });
    source.map.addEventListener('dispose', () => { textureDisposed = true; });
    shading.dispose();
    assert.equal(mesh.material, source);
    assert.equal(mesh.children.length, 0);
    assert.equal(sourceDisposed, false);
    assert.equal(textureDisposed, false);
  });
}
