// Run after npm test: npx electron tests/material-panel-smoke.cjs
// Uses the real renderer, textures and WebGL; leaves screenshots under tests/out.
const { app } = require('electron');

// The test window is often covered by other windows. Chromium then throttles its timers and stops
// producing frames, which makes waits time out and screenshots fail at random.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const path = require('node:path');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');

(async () => {
  const profile = syncFs.mkdtempSync(path.join(os.tmpdir(), 'mmd-material-test-'));
  app.setPath('userData', profile);
  process.env.MMDCONV_OPEN = path.resolve('tests/sample/complex.pmx');
  process.env.MMDCONV_LOCALE = 'ko-KR';
  delete process.env.MMDCONV_SHOT;
  const errors = [];
  const timeout = setTimeout(() => { console.error('Material UI test timed out'); app.exit(1); }, 45000);
  app.on('browser-window-created', (_event, win) => {
    const capture = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await win.webContents.capturePage(); }
        catch (error) {
          if (attempt >= 19 || !error.message.includes('display surface')) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    };
    win.webContents.on('console-message', (event) => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(`(async () => {
          const $ = (id) => document.getElementById(id);
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const wait = async (predicate) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Renderer wait timed out'); };
          await wait(() => window.__viewer?.current && $('materials').children.length === 2);
          $('tab-materials').click();
          await wait(() => $('material-detail').querySelector('.texture-thumb canvas'));
          check(!$('inspector-materials').hidden, 'material tab opens');
          check($('material-detail').textContent.includes('PMX 원본 정보'), 'PMX source properties shown');
          const rows = () => [...$('materials').querySelectorAll('li[data-index]')];
          rows()[1].querySelector('input').click();
          check(!__viewer.current.materials[1].material.visible, 'visibility off');
          $('material-solo').click();
          rows()[1].querySelector('button').click();
          check(!__viewer.current.materials[0].material.visible && __viewer.current.materials[1].material.visible, 'solo follows selection');
          $('material-solo').click();
          check(__viewer.current.materials[0].material.visible && !__viewer.current.materials[1].material.visible, 'solo restores prior visibility');
          $('material-show-all').click();
          check(__viewer.current.materials.every(e => e.material.visible), 'show all');
          $('material-search').value = 'no-such-material';
          $('material-search').dispatchEvent(new Event('input'));
          check(rows().length === 0 && $('materials').textContent.includes('검색 결과'), 'empty search');
          $('material-search').value = '';
          $('material-search').dispatchEvent(new Event('input'));
          rows()[0].querySelector('button').click();
          $('material-detail').querySelector('.texture-thumb').click();
          check($('texture-dialog').open && $('texture-preview').querySelector('canvas'), 'texture enlargement');
          $('texture-close').click();
          check(!$('texture-dialog').open, 'texture dialog closes');
          return { materials: rows().length, textures: $('material-detail').querySelectorAll('.texture-card').length };
        })()`);
        await fs.writeFile(path.resolve('tests/out/material-panel-pmx.png'), (await capture()).toPNG());
        const shading = await win.webContents.executeJavaScript(`(async () => {
          const $ = (id) => document.getElementById(id);
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const frame = async () => { __viewer.current.shading.updateOutlines(); __viewer.benchmark(1); await new Promise(requestAnimationFrame); };
          const before = __viewer.renderer.domElement.toDataURL();
          $('mode-toon').click();
          await frame();
          check(__viewer.renderMode === 'toon' && !$('toon-settings').hidden, 'Toon controls visible');
          check(__viewer.current.object.material.every(m => m.isMeshToonMaterial), 'Toon materials active');
          check(__viewer.current.info.triangles === 194, 'outline geometry excluded from statistics');
          check(__viewer.renderer.domElement.toDataURL() !== before, 'Toon changes rendered pixels');
          const outline = __viewer.current.shading.bindings[0].hull;
          check(outline.visible && outline.material.every(m => m.side === 1), 'backface geometry hull');
          $('outline-width').value = '4'; $('outline-width').dispatchEvent(new Event('input'));
          $('outline-color').value = '#e83355'; $('outline-color').dispatchEvent(new Event('input'));
          await frame();
          check(__viewer.current.shading.outlineWidth.value === 4, 'width uniform updated');
          check(outline.material[0].color.getHexString() === 'e83355', 'outline color updated');
          check($('outline-width-number').value === '4', 'number field synchronized');
          const thick = __viewer.renderer.domElement.toDataURL();
          $('outline-width-number').value = '0'; $('outline-width-number').dispatchEvent(new Event('input'));
          await frame();
          check(outline.material.every(m => !m.visible), 'zero width disables outline');
          check(__viewer.renderer.domElement.toDataURL() !== thick, 'outline width changes rendered pixels');
          $('outline-reset').click();
          const binding = __viewer.current.shading.bindings[0];
          const normalVersion = binding.smooth.geometry.attributes.normal.version;
          __viewer.setMorph(0, 1); await frame();
          check(binding.smooth.geometry.attributes.normal.version > normalVersion, 'PMX morph regenerates smooth normals');
          __viewer.setMorph(0, 0);
          $('mode-lambert').click(); await frame();
          check($('toon-settings').hidden && !outline.visible, 'Lambert hides controls and hull');
          $('mode-toon').click(); await frame();
          check(JSON.parse(localStorage.getItem('viewportOutline')).width === 1.6, 'outline preferences saved');
          return { mode: __viewer.renderMode, width: __viewer.outlineSettings.width };
        })()`);
        await fs.writeFile(path.resolve('tests/out/viewport-toon.png'), (await capture()).toPNG());
        const genericPath = path.resolve('tests/out/basic.fbx');
        await win.webContents.executeJavaScript(`(async () => {
          const input = document.getElementById('path-input');
          input.value = ${JSON.stringify(genericPath)};
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 200; i++) {
            if (window.__viewer.current?.kind === 'generic' && document.getElementById('info').textContent.includes('FBX')) break;
            await new Promise(r => setTimeout(r, 50));
          }
          const rows = document.querySelectorAll('#materials li[data-index]');
          if (rows.length !== 2) throw new Error('FBX material count');
          if (__viewer.renderMode !== 'toon' || !__viewer.current.shading.bindings.every(b => (Array.isArray(b.mesh.material) ? b.mesh.material : [b.mesh.material]).every(m => m.isMeshToonMaterial))) throw new Error('Toon persists when loading FBX');
          rows[0].querySelector('input').click();
          if (__viewer.current.materials[0].material.visible) throw new Error('FBX visibility');
          document.getElementById('material-show-all').click();
          if (document.getElementById('material-detail').textContent.includes('PMX 원본 정보')) throw new Error('stale PMX details');
        })()`);
        await fs.writeFile(path.resolve('tests/out/material-panel-fbx.png'), (await capture()).toPNG());
        win.setSize(960, 720);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await win.webContents.executeJavaScript(`(() => {
          const pane = document.getElementById('inspector-materials');
          const bounds = pane.getBoundingClientRect();
          if (bounds.right > innerWidth + 1 || pane.scrollWidth > pane.clientWidth + 1) throw new Error('Narrow inspector overflows: ' + JSON.stringify({right: bounds.right, width: innerWidth, scroll: pane.scrollWidth, client: pane.clientWidth}));
          const tab = document.getElementById('tab-materials');
          tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
          if (document.getElementById('inspector-overview').hidden) throw new Error('Keyboard tab navigation');
          tab.click();
        })()`);
        await fs.writeFile(path.resolve('tests/out/material-panel-narrow.png'), (await capture()).toPNG());
        await win.webContents.executeJavaScript(`(async () => {
          const THREE = await import('three');
          const { ViewportShading } = await import('./viewport-shading.js');
          for (const kind of ['skinned', 'instanced']) {
            const geometry = new THREE.SphereGeometry(1, 16, 12);
            const count = geometry.attributes.position.count;
            const morph = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) morph[i * 3] = geometry.attributes.position.getY(i) * 0.2;
            if (kind === 'skinned') {
              geometry.morphAttributes.position = [new THREE.BufferAttribute(morph, 3)];
              geometry.morphTargetsRelative = true;
            }
            const material = new THREE.MeshStandardMaterial({ color: '#82b5d5' });
            let mesh;
            if (kind === 'skinned') {
              const weights = new Float32Array(count * 4);
              for (let i = 0; i < count; i++) weights[i * 4] = 1;
              geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
              geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
              mesh = new THREE.SkinnedMesh(geometry, material);
              const bone = new THREE.Bone(); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
              bone.rotation.z = 0.3;
              mesh.morphTargetInfluences[0] = 0.8;
            } else mesh = new THREE.InstancedMesh(geometry, material, 2);
            mesh.frustumCulled = false;
            mesh.position.copy(__viewer.controls.target);
            const shading = new ViewportShading(mesh, new THREE.Vector2(500, 500));
            shading.apply('toon');
            __viewer.shadows.patch(mesh);
            __viewer.scene.add(mesh);
            __viewer.renderer.render(__viewer.scene, __viewer.camera);
            __viewer.scene.remove(mesh);
            shading.dispose();
            mesh.skeleton?.dispose();
            if (mesh.isInstancedMesh) mesh.dispose();
            geometry.dispose(); material.dispose();
          }
        })()`);
        if (process.env.MMDCONV_HEAVY) {
          const heavyPath = path.resolve('tests/out/heavy.obj');
          const benchmark = await win.webContents.executeJavaScript(`(async () => {
            const input = document.getElementById('path-input');
            input.value = ${JSON.stringify(heavyPath)};
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            for (let i = 0; i < 200; i++) {
              if (__viewer.current?.info.name === 'heavy.obj') break;
              await new Promise(r => setTimeout(r, 50));
            }
            if (__viewer.current?.info.name !== 'heavy.obj') throw new Error('Heavy model did not load');
            __viewer.setOutline(2.5, '#151923');
            return __viewer.benchmark(10);
          })()`);
          await fs.writeFile(path.resolve('tests/out/viewport-toon-heavy.png'), (await capture()).toPNG());
          console.log('Heavy Toon benchmark:', JSON.stringify(benchmark));
        }
        if (errors.length) throw new Error(errors.join('\n'));
        const probe = await win.webContents.executeJavaScript(`(async () => {
          const { probeToonRendering } = await import('../tests/toon-render-probe.js');
          const result = probeToonRendering();
          __viewer.setRenderMode('toon');
          __viewer.setShadows(false);
          const intensities = [__viewer.hemi.intensity, __viewer.sun.intensity];
          __viewer.setShadows(true);
          if (intensities[0] !== __viewer.hemi.intensity || intensities[1] !== __viewer.sun.intensity) throw new Error('Shadow toggle changes Toon palette');
          return result;
        })()`);
        await fs.writeFile(path.resolve('tests/out/toon-shadow-probe.png'), Buffer.from(probe.screenshot.split(',')[1], 'base64'));
        console.log('Two-tone GPU probe:', JSON.stringify({ tones: probe.tones, lit: probe.lit, unlit: probe.unlit }));
        const colors = await win.webContents.executeJavaScript(`(async () => {
          const { probeColorPipeline } = await import('../tests/color-pipeline-probe.js');
          return probeColorPipeline();
        })()`);
        console.log('Linear/GT7 GPU probe:', JSON.stringify(colors));
        if (errors.length) throw new Error(errors.join('\n'));
        console.log('Material and shading UI smoke passed:', JSON.stringify({ ...result, ...shading }), '(PMX + FBX)');
        clearTimeout(timeout);
        app.exit(0);
      } catch (error) {
        console.error(error, errors);
        try { await fs.writeFile(path.resolve('tests/out/material-panel-failure.png'), (await capture()).toPNG()); }
        catch (captureError) { console.error('Failure screenshot unavailable:', captureError.message); }
        finally { clearTimeout(timeout); app.exit(1); }
      }
    });
  });
  await import('../electron/main.js');
})();
