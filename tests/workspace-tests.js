import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWorkspace, encodeWorkspace, decodeWorkspace, readWorkspace, writeWorkspace, networkPaths } from '../src/core/workspace.js';
import { getLanguage, setLanguage, resolveLanguage, t } from '../src/i18n/index.js';
import { messages } from '../src/i18n/messages.js';

export function sampleWorkspace() {
  return {
    format: 'mmd-canvas-workspace', version: 1,
    browser: { directory: 'C:\\project\\models', filter: 'モデル', only3d: true },
    model: { path: 'C:\\project\\models\\캐릭터.pmx', materials: [{ name: '体', visible: false }], morphs: [{ name: 'あ', weight: 0.5 }] },
    viewport: { mode: 'toon', outline: { width: 2.7, color: '#ab3344' }, flags: { grid: false, skeleton: true, wireframe: false },
      lightIntensity: 1.7, lightDirection: [1, 2, 3], shadowEnabled: true, shadowSoftness: 0.04, gizmo: true,
      gizmoSpace: 'world', gizmoMode: 'rotate', gizmoPosition: [1, 4, 5],
      camera: { position: [2, 4, 7], target: [0, 1, 0], up: [0, 1, 0], fov: 35, zoom: 1, near: 0.1, far: 100, maxDistance: 50 } },
    conversion: { mode: 'single', format: 'usdz', output: 'C:\\project\\export\\キャラクター.usdz', source: 'C:\\project\\models\\캐릭터.pmx', scale: 8, nameMode: 'english', morphs: true, copyTextures: true, asciiNames: true, recursive: false },
    inspector: { tab: 'materials', selectedMaterial: 0, filter: '体', soloVisibility: [true] },
  };
}

export function registerWorkspaceTests(test) {
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
