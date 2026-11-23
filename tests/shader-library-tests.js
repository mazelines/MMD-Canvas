import assert from 'node:assert/strict';
import * as THREE from 'three';
import path from 'node:path';
import { discoverFunctionAssets } from '../src/core/shader-assets.js';
import { parseStack, packMaterialParams, packParams, hlslDeclarations, shaderTexturePaths } from '../src/core/shader-stack.js';
import { measureObjectHeight, objectHeightPlane } from '../renderer/object-space-height.js';
import { encodeWorkspace, decodeWorkspace, networkPaths } from '../src/core/workspace.js';
import { sampleWorkspace } from './workspace-tests.js';

export function registerShaderLibraryTests(test) {
  test('function library: valid independent assets and per-material texture handles', async () => {
    const { assets, errors } = await discoverFunctionAssets('renderer/shader-functions');
    assert.deepEqual(errors, []);
    assert.deepEqual(assets.map(a => a.name).sort(), ['SelfEmission', 'VerticalTwoColorBlending']);
    const emission = { ...assets.find(a => a.name === 'SelfEmission'), id: 'emission' };
    const gradient = { ...assets.find(a => a.name === 'VerticalTwoColorBlending'), id: 'gradient' };
    const library = [{ layers: [gradient, emission] }], parsed = parseStack(library[0].layers);
    const slot = parsed.layers[1].properties.find(p => p.type === 'texture2D').slot, stride = parsed.slotCount;
    const values = [{ texture: 'A.png' }, { texture: 'B.png' }, { texture: null }, { texture: 'missing.png' }];
    const instances = values.map(value => ({ stackId: 1, params: { emission: { emissionMask: value } } }));
    const textures = new Map([['A.png', { index: 5, flipY: true }], ['B.png', { index: 9, flipY: false }]]);
    const packed = packMaterialParams(library, instances, [0, 1, 2, 3], stride, 4, textures);
    assert.deepEqual(values.map((_, i) => [...packed.slice((i * stride + slot) * 4, (i * stride + slot) * 4 + 2)]), [[5, 1], [9, 0], [-1, 0], [-2, 0]]);
    assert.deepEqual(shaderTexturePaths(library, instances), ['A.png', 'B.png', 'missing.png']);
    assert.match(hlslDeclarations(parsed.layers[1], stride), /float2 emissionMask = userParams/);
    assert.equal(packParams([emission])[0], -1);
    emission.enabled = false;
    assert.deepEqual(shaderTexturePaths(library, instances), []);
  });

  test('gradient: whole-model object-space bounds survive transforms and hidden submeshes', () => {
    const root = new THREE.Group(), low = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)), high = low.clone();
    low.position.y = -2; high.position.y = 3; high.visible = false; root.add(low, high);
    const range = measureObjectHeight(root);
    assert.deepEqual(range, { min: -3, max: 4 });
    root.position.set(8, -4, 2); root.rotation.set(0.7, -0.4, 1.1); root.scale.set(2, 0.3, -1.5);
    const plane = objectHeightPlane(root, range);
    for (const height of [0, 0.25, 0.5, 1]) {
      const world = new THREE.Vector3(0.3, -3 + 7 * height, 0.4).applyMatrix4(root.matrixWorld);
      const actual = plane[0] * world.x + plane[1] * world.y + plane[2] * world.z + plane[3];
      assert.ok(Math.abs(actual - height) < 1e-10);
    }
    const transformed = measureObjectHeight(root);
    assert.ok(Math.abs(transformed.min - range.min) < 1e-10 && Math.abs(transformed.max - range.max) < 1e-10);
    assert.deepEqual(objectHeightPlane(root, { min: 1, max: 1 }), [0, 0, 0, 0.5]);
    assert.deepEqual(objectHeightPlane(new THREE.Group(), measureObjectHeight(new THREE.Group())), [0, 0, 0, 0.5]);
  });

  test('shader masks: workspace round-trip and network paths preserve independent references', () => {
    const data = sampleWorkspace();
    data.viewport.materialInstances = [{ ref: 'builtin:Default Toon', params: { emission: {
      emissionMask: { texture: 'C:\\project\\textures\\발광 mask.png' }, empty: { texture: null }, useDiffuseColor: 0,
    } } }];
    const file = 'C:\\project\\scene.canvas', encoded = encodeWorkspace(data, file, path.win32);
    assert.equal(encoded.viewport.materialInstances[0].params.emission.emissionMask.texture, 'textures/발광 mask.png');
    assert.deepEqual(decodeWorkspace(encoded, file, path.win32).viewport.materialInstances, data.viewport.materialInstances);
    assert.equal(data.viewport.materialInstances[0].params.emission.emissionMask.texture, 'C:\\project\\textures\\발광 mask.png');
    data.viewport.materialInstances[0].params.emission.emissionMask.texture = '\\\\mask-server\\art\\mask.png';
    assert.deepEqual(networkPaths(data), ['\\\\mask-server\\art\\mask.png']);
  });
}
