import assert from 'node:assert/strict';
import * as THREE from 'three';
import { collectMaterials, textureInfo } from '../renderer/material-info.js';
import { Viewer } from '../renderer/viewer.js';

export function registerMaterialTests(test) {
  test('materials: names do not merge distinct materials, shared instances collect usages', () => {
    const first = new THREE.MeshStandardMaterial({ name: 'same' });
    const second = new THREE.MeshStandardMaterial({ name: 'same' });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), first), new THREE.Mesh(new THREE.BoxGeometry(), second), new THREE.Mesh(new THREE.BoxGeometry(), first));
    const entries = collectMaterials(root);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].usages.length, 2);
    assert.equal(entries[0].triangles, 24);
    assert.equal(entries[1].triangles, 12);
    const viewer = Object.create(Viewer.prototype);
    viewer.current = { kind: 'generic', materials: entries };
    viewer.shadow = {};
    viewer.requestRender = () => {};
    viewer.setMaterialVisible(0, false);
    assert.equal(first.visible, false);
    assert.equal(second.visible, true);
    assert.equal(viewer.shadow.dirty, true);
  });

  test('materials: group, draw range and instance counts reflect rendered triangles', () => {
    const geometry = new THREE.BoxGeometry();
    const first = new THREE.MeshBasicMaterial(), second = new THREE.MeshBasicMaterial();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    geometry.setDrawRange(6, 18);
    const object = new THREE.InstancedMesh(geometry, [first, second], 3);
    const entries = collectMaterials(object);
    assert.deepEqual(entries.map((entry) => entry.triangles), [12, 6]);
  });

  test('materials: unloaded and embedded texture metadata are safe to inspect', () => {
    const texture = new THREE.Texture();
    assert.equal(textureInfo(texture).status, 'pending');
    texture.userData.loadStatus = 'error';
    texture.userData.sourcePath = 'missing.png';
    assert.equal(textureInfo(texture).status, 'error');
    assert.equal(textureInfo(texture).path, 'missing.png');
    const embedded = new THREE.DataTexture(new Uint8Array(32), 4, 2);
    assert.equal(textureInfo(embedded).width, 4);
    assert.equal(textureInfo(embedded).height, 2);
  });
}
