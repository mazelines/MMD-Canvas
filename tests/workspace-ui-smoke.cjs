// Real Electron save/open dialogs are stubbed only in this test process.
const { app, dialog } = require('electron');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

// The test window is often covered by other windows. Chromium then throttles its timers and stops
// producing frames, which made the waits below time out and screenshots fail at random.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

(async () => {
  const locale = process.env.MMDCONV_LOCALE || 'ko-KR';
  const language = /^(ko|en|zh|ja)/.exec(locale)?.[1] || 'en';
  app.setPath('userData', syncFs.mkdtempSync(path.join(os.tmpdir(), 'mmd-workspace-ui-')));
  process.env.MMDCONV_OPEN = process.env.MMDCONV_WORKSPACE_START || path.resolve('tests/sample/complex.pmx');
  delete process.env.MMDCONV_SHOT;
  const first = path.resolve(`tests/out/workspace-${locale}.canvas`);
  const second = path.resolve(`tests/out/nested/workspace-${locale}.canvas`);
  const output = path.resolve('tests/out/export/result.usdz');
  syncFs.mkdirSync(path.dirname(second), { recursive: true });
  let saveTarget = first, saveCalls = 0, openTarget = first;
  dialog.showSaveDialog = async () => { saveCalls++; return saveTarget ? { canceled: false, filePath: saveTarget } : { canceled: true }; };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openTarget] });
  const errors = [];
  const timeout = setTimeout(() => { console.error('Workspace UI timed out', locale); app.exit(1); }, 60000);
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
    win.webContents.once('did-finish-load', async () => {
      const run = (code) => win.webContents.executeJavaScript(`(async () => {
        const $ = id => document.getElementById(id);
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const wait = async predicate => { for(let i=0;i<300;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,30)); } throw new Error('Wait timed out'); };
        const change = (id,value,event='change') => { const e=$(id); if(e.type==='checkbox') e.checked=value; else e.value=value; e.dispatchEvent(new Event(event)); };
        ${code}
      })()`);
      try {
        const initial = await run(`
          await wait(() => window.__viewer?.current && !$('workspace-save').disabled);
          const { t } = await import('../src/i18n/index.js');
          check(document.documentElement.lang === ${JSON.stringify(language === 'zh' ? 'zh-CN' : language)}, 'system language');
          check($('workspace-save').textContent === t('저장'), 'static translation');
          $('mode-toon').click();
          change('outline-width',2.7,'input'); change('outline-color','#8844aa','input');
          change('flag-grid',false); change('flag-skeleton',true);
          change('light-intensity-number',12500.5,'input'); change('shadow-softness',33,'input');
          change('exposure-ev100',12.5,'input'); change('exposure-compensation',1.5,'input');
          __viewer.setLightDirection([1,2,3]);
          const morph=$('morphs').querySelector('input'); morph.value='0.35'; morph.dispatchEvent(new Event('input'));
          $('tab-materials').click(); change('material-search','','input'); $('material-show-all').click();
          $('materials').children[1].querySelector('input').click();
          $('materials').children[0].querySelector('button').click(); $('material-solo').click();
          change('material-search','体','input');
          change('material-emissive-nits',350,'input');
          check(__viewer.current.materials[0].material.emissiveIntensity===1, 'emission edit preserves source');
          __viewer.camera.position.multiplyScalar(1.15); __viewer.controls.update();
          $('btn-convert').click(); change('opt-format','usdz'); change('opt-scale','10'); change('opt-names','english');
          change('opt-output',${JSON.stringify(output)}); change('opt-ascii',true); change('opt-copy',false); change('opt-recursive',true);
          $('btn-cancel').click();
          $('workspace-save-as').click(); await wait(() => !$('workspace-save').disabled);
          check($('workspace-name').title === ${JSON.stringify(first)}, 'first save');
          return { camera: __viewer.camera.position.toArray(), target: __viewer.controls.target.toArray() };
        `);
        const saved = JSON.parse(await fs.readFile(first, 'utf8'));
        assert.equal(saved.format, 'mmd-canvas-workspace');
        assert.equal(saved.model.path, '../sample/complex.pmx');
        assert.equal(saved.conversion.output, 'export/result.usdz');
        assert.equal(saved.viewport.mode, 'toon');
        assert.equal(saved.viewport.outline.width, 2.7);
        assert.deepEqual(saved.viewport.exposure, {ev100:12.5,compensation:1.5});
        assert.equal(saved.model.materials[0].emissiveNits,350);
        assert.deepEqual(saved.inspector.soloVisibility, [true, false]);
        assert.equal('locale' in saved, false);
        assert.equal(saveCalls, 1);
        await run(`
          $('mode-lambert').click(); $('material-show-all').click();
          change('outline-width',0,'input'); change('flag-grid',true);
          $('exposure-reset').click(); $('material-emissive-reset').click();
          __viewer.setMorph(0,0); __viewer.camera.position.multiplyScalar(2);
          const old=__viewer.current.object.uuid;
          $('workspace-open').click(); await wait(() => !$('workspace-open').disabled && __viewer.current.object.uuid!==old);
          check(__viewer.renderMode==='toon' && __viewer.outlineSettings.width===2.7, 'shading restored');
          check(__viewer.outlineSettings.color==='#8844aa', 'color restored');
          check(!__viewer.flags.grid && __viewer.flags.skeleton, 'flags restored');
          check(Math.abs(__viewer.current.morphWeights[0]-0.35)<0.00001, 'morph restored');
          check(__viewer.lightLevel===12500.5 && __viewer.sun.intensity===12500.5, 'physical lux restored');
          check($('light-intensity-number').value==='12500.5', 'numeric lux restored');
          check(__viewer.exposure.ev100===12.5 && __viewer.exposure.compensation===1.5, 'exposure restored');
          check($('exposure-ev100').value==='12.5' && $('exposure-compensation').value==='1.5', 'exposure controls restored');
          check(__viewer.getMaterialEmission(0).nits===350 && $('material-emissive-nits').value==='350', 'physical emission restored');
          check($('material-solo').getAttribute('aria-pressed')==='true', 'solo restored');
          $('material-solo').click();
          check(__viewer.current.materials[0].material.visible && !__viewer.current.materials[1].material.visible, 'solo baseline restored');
          const expected=${JSON.stringify(initial)};
          check(__viewer.camera.position.toArray().every((n,i)=>Math.abs(n-expected.camera[i])<1e-6), 'camera restored');
          check(__viewer.controls.target.toArray().every((n,i)=>Math.abs(n-expected.target[i])<1e-6), 'orbit target restored');
          $('btn-convert').click();
          check($('opt-format').value==='usdz' && $('opt-scale').value==='10', 'conversion settings restored');
          check($('opt-output').value===${JSON.stringify(output)}, 'conversion destination survives opening dialog');
          check($('opt-ascii').checked && !$('opt-copy').checked, 'conversion options restored');
          $('btn-cancel').click();
          if (${JSON.stringify(language)} !== 'ko') check(!/[가-힣]/.test(document.body.innerText), 'no untranslated Korean UI');
        `);
        saveTarget = second;
        await run(`$('workspace-save-as').click(); await wait(() => !$('workspace-save').disabled); check($('workspace-name').title===${JSON.stringify(second)}, 'save as');`);
        const relocated = JSON.parse(await fs.readFile(second, 'utf8'));
        assert.equal(relocated.model.path, '../../sample/complex.pmx');
        assert.equal(relocated.conversion.output, '../export/result.usdz');
        await run(`change('outline-width',3.4,'input'); window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyS',ctrlKey:true})); await wait(() => !$('workspace-save').disabled);`);
        assert.equal(saveCalls, 2, 'Ctrl+S reuses existing path');
        assert.equal(JSON.parse(await fs.readFile(second, 'utf8')).viewport.outline.width, 3.4);
        saveTarget = null;
        await run(`$('workspace-save-as').click(); await wait(() => !$('workspace-save').disabled); check($('workspace-name').title===${JSON.stringify(second)}, 'cancel retains path');`);
        const broken = path.resolve(`tests/out/broken-${locale}.canvas`);
        await fs.writeFile(broken, '{invalid'); openTarget = broken;
        await run(`const old=__viewer.current.object.uuid; $('workspace-open').click(); await wait(() => !$('workspace-open').disabled); check($('statusbar').className==='error' && __viewer.current.object.uuid===old, 'bad file preserves model');`);
        const missing = structuredClone(saved); missing.model.path = 'missing-model.pmx';
        await fs.writeFile(broken, JSON.stringify(missing));
        await run(`const old=__viewer.current.object.uuid; $('workspace-open').click(); await wait(() => !$('workspace-open').disabled); check($('statusbar').className==='error' && __viewer.current.object.uuid===old, 'missing model preserves session');`);
        const folderOnly = structuredClone(saved);
        folderOnly.model = null;
        folderOnly.conversion.mode = 'batch';
        folderOnly.conversion.source = folderOnly.browser.directory;
        folderOnly.conversion.output = 'batch-export';
        folderOnly.inspector.soloVisibility = null;
        await fs.writeFile(broken, JSON.stringify(folderOnly));
        saveTarget = path.resolve(`tests/out/folder-${locale}.canvas`);
        await run(`
          $('workspace-open').click(); await wait(() => !$('workspace-open').disabled);
          check(!__viewer.current && $('btn-convert').disabled, 'folder workspace clears model');
          $('btn-batch').click();
          check($('opt-output').value===${JSON.stringify(path.resolve('tests/out/batch-export'))}, 'batch destination restored');
          check(!$('row-recursive').hidden && $('opt-recursive').checked, 'batch recursion restored');
          $('btn-cancel').click();
          $('workspace-save-as').click(); await wait(() => !$('workspace-save').disabled);
        `);
        assert.equal(JSON.parse(await fs.readFile(saveTarget, 'utf8')).model, null, 'folder workspace saves without model');
        openTarget = first;
        await run(`$('workspace-open').click(); await wait(() => !$('workspace-open').disabled);`);
        await win.webContents.capturePage().then((image) => fs.writeFile(path.resolve(`tests/out/workspace-${locale}.png`), image.toPNG())).catch((e) => console.warn('screenshot skipped:', e.message));
        if (errors.length) throw new Error(errors.join('\n'));
        console.log(`Workspace save/restore and localization passed: ${locale}`);
        clearTimeout(timeout); app.exit(0);
      } catch (error) {
        console.error(error, errors);
        await win.webContents.capturePage().then((image) => fs.writeFile(path.resolve(`tests/out/workspace-failure-${locale}.png`), image.toPNG())).catch((e) => console.warn('screenshot skipped:', e.message));
        clearTimeout(timeout); app.exit(1);
      }
    });
  });
  await import('../electron/main.js');
})();
