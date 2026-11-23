import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadShaderAsset, saveShaderAsset, discoverFunctionAssets, readFunctionAsset, writeFunctionAsset, functionContainer } from '../src/core/shader-assets.js';
import { validateShaderFile, readShaderFile, writeShaderFile, shaderContainer, SHADER_FORMAT, SHADER_VERSION } from '../src/core/shader-file.js';
import { encodeWorkspace, decodeWorkspace } from '../src/core/workspace.js';
import { sampleWorkspace } from './workspace-tests.js';

export function registerShaderFileTests(test, outDir) {
  const sample = () => ({
    format: SHADER_FORMAT, version: 1, name: 'My Toon', outline: true,
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
  test('shader assets: v1 remains readable; saving splits code into shaderStack without changing layer IDs', async () => {
    const dir = await fs.mkdtemp(path.join(outDir, 'assets-'));
    const old = path.join(dir, 'legacy.shader'); await writeShaderFile(old, sample());
    const bytes = await fs.readFile(old, 'utf8'), loaded = await loadShaderAsset(old);
    assert.equal(await fs.readFile(old, 'utf8'), bytes);
    const target = path.join(dir, 'Toon.shader');
    const saved = await saveShaderAsset(target, loaded), disk = await readShaderFile(target);
    assert.equal(disk.version, 2); assert.equal(disk.layers[0].id, 'band');
    assert.equal(disk.layers[0].code, undefined); assert.match(disk.layers[0].ref, /^stacks\/.+\.shaderStack$/);
    const fn = await readFunctionAsset(saved.layers[0].ref);
    assert.equal(fn.code, sample().layers[0].code);
    const back = await loadShaderAsset(target);
    assert.equal(back.layers[0].code, sample().layers[0].code); assert.equal(back.outline, true);
    assert.deepEqual(back.metadata.tags, ['toon']);
  });
  test('shader assets: shared function, repeated instances and Save As preserve identity and references', async () => {
    const dir = await fs.mkdtemp(path.join(outDir, 'shared-'));
    const a = path.join(dir, 'A.shader');
    const first = await saveShaderAsset(a, sample());
    const entry = { ...first, path: a, layers: [first.layers[0], { ...first.layers[0], id: 'second', enabled: false }] };
    const b = path.join(dir, 'nested', 'B.shader'); await saveShaderAsset(b, entry);
    const disk = await readShaderFile(b);
    assert.equal(disk.layers[0].ref, disk.layers[1].ref); assert.match(disk.layers[0].ref, /^\.\.\/stacks\//);
    assert.equal(disk.layers[1].id, 'second'); assert.equal(disk.layers[1].enabled, false);
    const asset = await readFunctionAsset(first.layers[0].ref); asset.code = asset.code.replace('0.25', '0.75');
    await writeFunctionAsset(first.layers[0].ref, asset);
    assert.equal((await loadShaderAsset(a)).layers[0].code, asset.code);
    assert.equal((await loadShaderAsset(b)).layers[1].code, asset.code);
    const moved = `${dir}-moved`; await fs.cp(dir, moved, { recursive: true });
    assert.equal((await loadShaderAsset(path.join(moved, 'nested', 'B.shader'))).layers[0].code, asset.code);
  });
  test('shader assets: invalid or missing dependencies do not overwrite parent or valid function', async () => {
    const dir = await fs.mkdtemp(path.join(outDir, 'invalid-assets-')), target = path.join(dir, 'A.shader');
    const first = await saveShaderAsset(target, sample()), parent = await fs.readFile(target, 'utf8');
    const fn = first.layers[0].ref, before = await fs.readFile(fn, 'utf8');
    await assert.rejects(saveShaderAsset(target, { ...first, layers: [first.layers[0], { ...first.layers[0] }] }));
    assert.equal(await fs.readFile(fn, 'utf8'), before);
    const invalid = { ...first, layers: [{ ...first.layers[0], code: 'not a function' }] };
    await assert.rejects(saveShaderAsset(target, invalid));
    assert.equal(await fs.readFile(target, 'utf8'), parent);
    await fs.unlink(fn);
    await assert.rejects(loadShaderAsset(target), /shaderStack/);
    await assert.rejects(saveShaderAsset(target, first));
    assert.equal(await fs.readFile(target, 'utf8'), parent);
  });
  test('shader assets: function discovery includes nested files and reports broken assets', async () => {
    const dir = await fs.mkdtemp(path.join(outDir, 'catalog-')); await fs.mkdir(path.join(dir, 'nested'));
    const fn = path.join(dir, 'nested', 'Tone.SHADERSTACK');
    await writeFunctionAsset(fn, functionContainer(sample().layers[0]));
    await fs.writeFile(path.join(dir, 'broken.shaderStack'), '{');
    const { assets, errors } = await discoverFunctionAssets(dir);
    assert.equal(assets.length, 1); assert.equal(assets[0].ref, path.resolve(fn)); assert.equal(errors.length, 1);
    await assert.rejects(writeFunctionAsset(path.join(dir, 'wrong.shader'), functionContainer(sample().layers[0])));
  });
}
