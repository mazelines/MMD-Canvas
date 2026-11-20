import assert from 'node:assert/strict';
import path from 'node:path';
import { validateShaderFile, readShaderFile, writeShaderFile, shaderContainer, SHADER_FORMAT, SHADER_VERSION } from '../src/core/shader-file.js';
import { encodeWorkspace, decodeWorkspace } from '../src/core/workspace.js';
import { sampleWorkspace } from './workspace-tests.js';

export function registerShaderFileTests(test, outDir) {
  const sample = () => ({
    format: SHADER_FORMAT, version: SHADER_VERSION, name: 'My Toon', outline: true,
    metadata: { description: 'test', author: 'me', tags: ['toon'] },
    layers: [{ id: 'band', name: 'ToonBand', code: '//@property float floor = 0.25 [0,1] "바닥"\nvoid ToonBand(inout ShadingContext ctx){}', enabled: true }],
  });
  test('shader file: validate keeps known fields and rejects invalid', () => {
    const v = validateShaderFile(sample());
    assert.equal(v.name, 'My Toon'); assert.equal(v.outline, true); assert.equal(v.layers.length, 1);
    assert.deepEqual(v.metadata.tags, ['toon']);
    const extra = sample(); extra.evil = 'x'; extra.layers[0].params = { a: 1 };
    const clean = validateShaderFile(extra);
    assert.equal(clean.evil, undefined); assert.equal(clean.layers[0].params, undefined);
    for (const bad of [null, {}, { ...sample(), format: 'other' }, { ...sample(), version: 99 }, { ...sample(), name: 123 }, { ...sample(), layers: 'x' }]) {
      assert.throws(() => validateShaderFile(bad));
    }
  });
  test('shader file: write/read round-trip + extension/size guards', async () => {
    const target = path.join(outDir, 'roundtrip.shader');
    await writeShaderFile(target, sample());
    const back = await readShaderFile(target);
    assert.equal(back.name, 'My Toon'); assert.equal(back.layers[0].id, 'band');
    assert.ok(back.metadata.modifiedAt);
    await assert.rejects(writeShaderFile(path.join(outDir, 'bad.txt'), sample()));
    await assert.rejects(readShaderFile(path.join(outDir, 'missing.shader')));
    const big = sample(); big.layers[0].code = 'x'.repeat(40000);
    await assert.rejects(writeShaderFile(target, big));
  });
  test('shader file: container drops runtime-only fields', () => {
    const c = shaderContainer({ name: 'X', outline: false, layers: [{ id: 'a', name: 'A', code: 'void A(inout ShadingContext ctx){}', enabled: true }], source: 'file', ref: 'shaders/x.shader', path: '/abs/x.shader', dirty: true, baseline: [] });
    assert.equal(c.format, SHADER_FORMAT); assert.equal(c.source, undefined); assert.equal(c.path, undefined); assert.equal(c.dirty, undefined);
    assert.equal(c.layers[0].id, 'a');
  });
  test('workspace: .shader references relativize against the canvas directory', () => {
    const ws = sampleWorkspace();
    ws.viewport.materialInstances = [{ ref: 'C:\\project\\shaders\\toon.shader', params: { band: { floor: 0.3 } } }, { ref: 'builtin:Default Toon', params: {} }];
    ws.viewport.shaderFiles = ['C:\\project\\shaders\\toon.shader'];
    const encoded = encodeWorkspace(ws, 'C:\\project\\scene.canvas', path.win32);
    assert.equal(encoded.viewport.materialInstances[0].ref, 'shaders/toon.shader');
    assert.equal(encoded.viewport.materialInstances[1].ref, 'builtin:Default Toon');
    assert.equal(encoded.viewport.shaderFiles[0], 'shaders/toon.shader');
    const decoded = decodeWorkspace(encoded, 'C:\\project\\scene.canvas', path.win32);
    assert.equal(decoded.viewport.materialInstances[0].ref, 'C:\\project\\shaders\\toon.shader');
    assert.equal(decoded.viewport.materialInstances[1].ref, 'builtin:Default Toon');
    const moved = decodeWorkspace(encoded, 'D:\\moved\\scene.canvas', path.win32);
    assert.equal(moved.viewport.materialInstances[0].ref, 'D:\\moved\\shaders\\toon.shader');
  });
}
