import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWorkspace, encodeWorkspace, decodeWorkspace, readWorkspace, writeWorkspace, networkPaths } from '../src/core/workspace.js';
import { getLanguage, setLanguage, resolveLanguage, t } from '../src/i18n/index.js';
import { messages } from '../src/i18n/messages.js';
import { LEGACY_EV100, exposureScale } from '../src/core/lighting.js';

export function sampleWorkspace() {
  return {
    format: 'mmd-canvas-workspace', version: 2,
    browser: { directory: 'C:\\project\\models', filter: 'モデル', only3d: true },
    model: { path: 'C:\\project\\models\\캐릭터.pmx', materials: [{ name: '体', visible: false, emissiveNits: 250 }], morphs: [{ name: 'あ', weight: 0.5 }] },
    viewport: { exposure: { ev100: 2.5, compensation: 1 }, mode: 'toon', outline: { width: 2.7, color: '#ab3344' }, flags: { grid: false, skeleton: true, wireframe: false },
      lightIntensity: 12500.5, lightUnit: 'lux', ambientIntensity: 3.5, lightDirection: [1, 2, 3], shadowEnabled: true, shadowSoftness: 0.04, gizmo: true,
      gizmoSpace: 'world', gizmoMode: 'rotate', gizmoPosition: [1, 4, 5],
      camera: { position: [2, 4, 7], target: [0, 1, 0], up: [0, 1, 0], fov: 35, zoom: 1, near: 0.1, far: 100, maxDistance: 50 } },
    conversion: { mode: 'single', format: 'usdz', output: 'C:\\project\\export\\キャラクター.usdz', source: 'C:\\project\\models\\캐릭터.pmx', scale: 8, nameMode: 'english', morphs: true, copyTextures: true, asciiNames: true, recursive: false },
    inspector: { tab: 'materials', selectedMaterial: 0, filter: '体', soloVisibility: [true] },
  };
}

export function registerWorkspaceTests(test) {
  test('workspace: exposure and emission migration preserves the previous fixed output scale', () => {
    const old = sampleWorkspace();
    delete old.viewport.exposure; delete old.model.materials[0].emissiveNits;
    const restored = validateWorkspace(old);
    assert.equal(restored.viewport.exposure.ev100, LEGACY_EV100);
    assert.ok(Math.abs(exposureScale(LEGACY_EV100, 0) - 1) < 1e-12);
    assert.equal(restored.model.materials[0].emissiveNits, null);
    assert.deepEqual(validateWorkspace(restored), restored);
    assert.equal(exposureScale(1, 0), exposureScale(0, 0) / 2);
    assert.equal(exposureScale(1, 1), exposureScale(0, 0));
    restored.viewport.exposure.ev100 = 25;
    assert.throws(() => validateWorkspace(restored));
    restored.viewport.exposure.ev100 = 0; restored.model.materials[0].emissiveNits = -1;
    assert.throws(() => validateWorkspace(restored));
  });
  test('workspace: lux values round-trip and legacy multipliers migrate exactly once', () => {
    const workspace = sampleWorkspace();
    assert.equal(validateWorkspace(workspace).viewport.lightIntensity, 12500.5);
    delete workspace.viewport.lightUnit; workspace.viewport.lightIntensity = 1;
    const migrated = validateWorkspace(workspace);
    assert.equal(migrated.viewport.lightUnit, 'lux');
    assert.equal(migrated.viewport.lightIntensity, 6);
    assert.equal(validateWorkspace(migrated).viewport.lightIntensity, 6);
    // version 1 files stay readable, are rewritten as version 2, and had no ambient fill
    const old = sampleWorkspace(); old.version = 1; delete old.viewport.ambientIntensity;
    assert.equal(validateWorkspace(old).version, 2);
    assert.equal(validateWorkspace(old).viewport.ambientIntensity, 0);
    assert.equal(validateWorkspace(sampleWorkspace()).viewport.ambientIntensity, 3.5);
    workspace.viewport.lightUnit = 'candela';
    assert.throws(() => validateWorkspace(workspace));
    workspace.viewport.lightUnit = 'lux'; workspace.viewport.lightIntensity = 200001;
    assert.throws(() => validateWorkspace(workspace));
  });
  test('workspace: Windows paths relocate as a bundle and cross-drive paths remain absolute', () => {
    const workspace = sampleWorkspace();
    const encoded = encodeWorkspace(workspace, 'C:\\project\\scene.canvas', path.win32);
    assert.equal(encoded.model.path, 'models/캐릭터.pmx');
    assert.equal(encoded.conversion.output, 'export/キャラクター.usdz');
    assert.deepEqual(decodeWorkspace(encoded, 'C:\\project\\scene.canvas', path.win32), workspace);
    const moved = decodeWorkspace(encoded, 'D:\\moved\\scene.canvas', path.win32);
    assert.equal(moved.model.path, 'D:\\moved\\models\\캐릭터.pmx');
    workspace.model.path = 'D:\\models\\external.pmx';
    assert.equal(encodeWorkspace(workspace, 'C:\\project\\scene.canvas', path.win32).model.path, 'D:/models/external.pmx');
  });
  test('workspace: network locations are reported unless they are the workspace file\'s own server', () => {
    const workspace = sampleWorkspace();
    assert.deepEqual(networkPaths(workspace, 'C:\\project\\scene.canvas'), []);
    workspace.model.path = '\\\\evil\\share\\a.pmx'; workspace.conversion.source = workspace.model.path;
    workspace.browser.directory = '//NAS/models';
    assert.deepEqual(networkPaths(workspace, 'C:\\project\\scene.canvas'), ['//NAS/models', '\\\\evil\\share\\a.pmx']);
    assert.deepEqual(networkPaths(workspace, '\\\\nas\\models\\scene.canvas'), ['\\\\evil\\share\\a.pmx']);
  });
  test('workspace: POSIX relative paths and folder-only workspaces round-trip', () => {
    const workspace = sampleWorkspace();
    workspace.browser.directory = '/project/assets'; workspace.model = null;
    workspace.conversion.source = '/project/assets'; workspace.conversion.output = '/project/out'; workspace.conversion.mode = 'batch';
    assert.deepEqual(decodeWorkspace(encodeWorkspace(workspace, '/project/scenes/a.canvas', path.posix), '/project/scenes/a.canvas', path.posix), workspace);
  });
  test('workspace: invalid documents fail before replacing an existing save', async () => {
    const target = path.resolve('tests/out/workspace-valid.canvas');
    const workspace = sampleWorkspace();
    workspace.browser.directory = path.resolve('tests/sample');
    workspace.model.path = path.resolve('tests/sample/complex.pmx');
    workspace.conversion.source = workspace.model.path; workspace.conversion.output = path.resolve('tests/out/test.usdz');
    await writeWorkspace(target, workspace);
    assert.deepEqual(await readWorkspace(target), workspace);
    const original = await fs.readFile(target, 'utf8');
    for (const mutation of [d => { d.version = 99; }, d => { d.format = 'json-canvas'; }, d => { d.viewport.camera.near = Infinity; }, d => { d.viewport.camera.far = 0.01; }, d => { d.model.morphs[0].weight = -1; }, d => { d.viewport.outline.color = 'bad'; }]) {
      const invalid = structuredClone(workspace); mutation(invalid);
      assert.throws(() => validateWorkspace(invalid));
      await assert.rejects(writeWorkspace(target, invalid));
      assert.equal(await fs.readFile(target, 'utf8'), original);
    }
    workspace.viewport.outline.width = 4;
    await writeWorkspace(target, workspace);
    assert.equal((await readWorkspace(target)).viewport.outline.width, 4);
    const invalid = path.resolve('tests/out/invalid.canvas');
    await fs.writeFile(invalid, '{broken');
    await assert.rejects(readWorkspace(invalid));
    assert.equal((await fs.readdir('tests/out')).some(name => name.endsWith('.tmp')), false);
  });
  test('i18n: supported system locales, fallback and interpolation preserve user names', () => {
    const previous = getLanguage();
    try {
      for (const [locale, expected] of [['ko-KR','ko'],['en-GB','en'],['ja_JP','ja'],['zh-Hant-TW','zh'],['zh-CN','zh'],['de-DE','en'],['','en']]) assert.equal(resolveLanguage(locale), expected);
      for (const locale of ['ko', 'en', 'zh', 'ja']) {
        setLanguage(locale);
        const name = '한글/日本語/中文/{0}/$file.pmx';
        const rendered = t`불러오는 중: ${name}`;
        assert.ok(rendered.endsWith(name));
        if (locale !== 'ko') assert.ok(!rendered.startsWith('불러오는'));
      }
      for (const [key, translations] of Object.entries(messages)) {
        assert.equal(translations.length, 3, key);
        const placeholders = [...key.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
        for (const translation of translations) {
          assert.ok(translation && !/[가-힣]/.test(translation), key);
          assert.deepEqual([...translation.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), placeholders, key);
        }
      }
    } finally { setLanguage(previous); }
  });
}
