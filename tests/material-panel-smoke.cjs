// Run after npm test: npx electron tests/material-panel-smoke.cjs
// Uses the real renderer, textures and DX12; leaves screenshots under tests/out.
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
  const timeout = setTimeout(() => { console.error('Material UI test timed out'); app.exit(1); }, 90000);
  app.on('browser-window-created', (_event, win) => {
    const capture = async () => {
      // DOM assertions can finish before Chromium submits the updated compositor frame.
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 100));
      for (let attempt = 0; ; attempt++) {
        try { return await win.webContents.capturePage(); }
        catch (error) {
          if (attempt >= 19 || !error.message.includes('display surface')) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    };
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 3 || /GL_INVALID|GL_OUT_OF_MEMORY/.test(event.message)) errors.push(event.message);
      if (event.message.startsWith('CORTAO ')) console.log(event.message);
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(`(async () => {
          const $ = (id) => document.getElementById(id);
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const wait = async (predicate) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Renderer wait timed out'); };
          await wait(() => window.__viewer?.current && __viewer.dx12?.lastFrame && !__viewer.dx12.busy && $('materials').children.length === 2);
          check(__viewer.lightLevel === 10 && __viewer.sun.intensity === 10, 'default directional light is 10 lux');
          check(__viewer.exposure.ev100 === 0 && __viewer.exposure.compensation === 0, 'manual exposure defaults');
          check(__viewer.cortao.settings.enabled && $('cortao-enabled').checked, 'CORTAO enabled by default');
          $('cortao-intensity').value='1.3'; $('cortao-intensity').dispatchEvent(new Event('input'));
          $('cortao-radius').value='4'; $('cortao-radius').dispatchEvent(new Event('input'));
          check(JSON.parse(localStorage.getItem('viewportCortao')).radius===4, 'CORTAO preferences persist');
          check(__viewer.cortao.settings.intensity===1.3, 'CORTAO shared across materials');
          const aoPreferences = localStorage.getItem('viewportCortao');
          for (const view of ['ao', 'raw']) {
            $('cortao-debug').value=view; $('cortao-debug').dispatchEvent(new Event('change'));
            __viewer.benchmark(1);
            check(__viewer.cortao.debugView===view && !$('cortao-debug-hint').hidden, 'AO debug selector changes the live viewport');
          }
          check(localStorage.getItem('viewportCortao')===aoPreferences, 'debug inspection does not overwrite saved AO settings');
          $('cortao-enabled').click(); __viewer.benchmark(1);
          check(!__viewer.cortao.settings.enabled && $('cortao-radius').disabled, 'CORTAO toggle bypasses rendering');
          check($('cortao-debug-hint').textContent.includes('꺼져'), 'debug explains disabled AO');
          $('cortao-reset').click(); __viewer.benchmark(1);
          check(__viewer.cortao.settings.enabled && __viewer.cortao.settings.radius===2 && !$('cortao-radius').disabled, 'CORTAO reset restores defaults');
          check(__viewer.cortao.debugView==='off' && $('cortao-debug').value==='off' && $('cortao-debug-hint').hidden, 'reset returns to normal rendering');
          $('exposure-ev100').value='2'; $('exposure-ev100').dispatchEvent(new Event('input'));
          $('exposure-compensation').value='1'; $('exposure-compensation').dispatchEvent(new Event('input'));
          check(__viewer.exposureMultiplier===50 && __viewer.sun.intensity===10, 'exposure controls adjust output without changing lux');
          $('exposure-reset').click();
          check(__viewer.exposure.ev100===0 && JSON.parse(localStorage.getItem('viewportExposure')).ev100===0, 'exposure reset persists');
          check($('light-value').textContent === 'lux' && $('light-intensity-number').value === '10', 'lux controls show physical default');
          $('light-intensity-number').value = '12000'; $('light-intensity-number').dispatchEvent(new Event('input'));
          check(__viewer.sun.intensity === 12000 && Number($('light-intensity').max) >= 12000, 'numeric lux supports daylight values');
          $('light-intensity').dispatchEvent(new MouseEvent('dblclick'));
          check(__viewer.sun.intensity === 10 && $('light-intensity-number').value === '10', 'reset restores 10 lux');
          for (const mode of ['toon', 'lambert']) {
            __viewer.setRenderMode(mode);
            for (const enabled of [false, true]) {
              __viewer.setShadows(enabled);
              check(__viewer.sun.intensity === 10 && __viewer.hemi.intensity === __viewer.ambientLevel, 'shading and shadows preserve physical light');
            }
          }
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
          const frame = async () => { const old=__viewer.dx12.lastFrame.id;__viewer.requestRender();for(let i=0;i<300;i++){if(__viewer.dx12.error)throw __viewer.dx12.error;if(__viewer.dx12.lastFrame.id>old&&!__viewer.dx12.busy)return;await new Promise(r=>setTimeout(r,20));}throw new Error('DX12 frame timeout'); };
          await frame();
          // Outline is a global setting; the built-in Default Toon stack enables it
          // per material. Materials use Lambert variants carrying surface props.
          check(!$('toon-settings').hidden, 'Outline controls always visible');
          check(__viewer.current.object.material.every(m => m.isMeshLambertMaterial), 'Lambert variants active');
          check(__viewer.current.info.triangles === 194, 'outline geometry excluded from statistics');
          const before = __viewer.canvas.toDataURL();
          $('outline-width').value = '4'; $('outline-width').dispatchEvent(new Event('input'));
          $('outline-color').value = '#e83355'; $('outline-color').dispatchEvent(new Event('input'));
          await frame();
          check(__viewer.current.shading.outlineWidth.value === 4, 'width uniform updated');
          check(__viewer.outlineSettings.color === '#e83355', 'outline color updated');
          check($('outline-width-number').value === '4', 'number field synchronized');
          check(__viewer.canvas.toDataURL() !== before, 'outline changes rendered pixels');
          const thick = __viewer.canvas.toDataURL();
          $('outline-width-number').value = '0'; $('outline-width-number').dispatchEvent(new Event('input'));
          await frame();
          check(__viewer.canvas.toDataURL() !== thick, 'outline width changes rendered pixels');
          $('outline-reset').click();
          const pose = __viewer.canvas.toDataURL();
          __viewer.setMorph(0, 1); await frame();
          check(__viewer.canvas.toDataURL() !== pose, 'PMX morph changes native geometry');
          __viewer.setMorph(0, 0);
          await frame();
          check(JSON.parse(localStorage.getItem('viewportOutline')).width === 1.6, 'outline preferences saved');
          return { width: __viewer.outlineSettings.width };
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
          if (!__viewer.current.shading.bindings.every(b => (Array.isArray(b.mesh.material) ? b.mesh.material : [b.mesh.material]).every(m => m.isMeshLambertMaterial))) throw new Error('Lambert variants persist when loading FBX');
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
          const exposure = document.querySelector('.exposure-controls').getBoundingClientRect();
          const modes = document.querySelector('.viewport-modes').getBoundingClientRect();
          if (exposure.right > modes.left && exposure.left < modes.right && exposure.bottom > modes.top && exposure.top < modes.bottom) throw new Error('Exposure overlaps shading controls');
          const tab = document.getElementById('tab-materials');
          tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
          if (document.getElementById('inspector-overview').hidden) throw new Error('Keyboard tab navigation');
          tab.click();
        })()`);
        await fs.writeFile(path.resolve('tests/out/material-panel-narrow.png'), (await capture()).toPNG());
        // Animation playback: a glTF with two clips shows the transport bar; a model without clips hides it again.
        const animatedPath = path.resolve('tests/sample/animated.gltf');
        const animationScript = (body) => `(async () => {
          const $ = (id) => document.getElementById(id);
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const wait = async (predicate) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Animation wait timed out'); };
          const open = async (file, ready) => {
            $('path-input').value = file;
            $('path-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await wait(ready);
          };
          const state = () => __viewer.getAnimation();
          const pixels = async () => { const old=__viewer.dx12.lastFrame.id;__viewer.requestRender();await wait(()=>__viewer.dx12.lastFrame.id>old&&!__viewer.dx12.busy);if(__viewer.dx12.error)throw __viewer.dx12.error;return __viewer.canvas.toDataURL(); };
          ${body}
        })()`;
        await win.webContents.executeJavaScript(animationScript(`
          check($('animation-bar').hidden && state() === null, 'no transport bar for a model without clips');
          await open(${JSON.stringify(animatedPath)}, () => __viewer.current?.info.name === 'animated.gltf' && !$('animation-bar').hidden);
          check(state().playing && $('viewport').classList.contains('has-animation'), 'clips start playing');
          check($('anim-clip').options.length === 2 && $('anim-clip').options[0].textContent === 'Bend (2.00 s)', 'clip list');
          check($('info').textContent.includes('클립 2개'), 'clip count in model info');
          const started = state().time;
          await wait(() => state().time !== started && $('anim-time').textContent.endsWith('/ 2.00 s'));
          $('anim-play').click();
          check(!state().playing && $('anim-play').title === '재생 (Space)', 'pause');
          const seek = (value) => { $('anim-seek').value = String(value); $('anim-seek').dispatchEvent(new Event('input')); };
          seek(0);
          const rest = await pixels();
          __viewer.setCortaoDebug('ao');const restAO=await pixels();__viewer.setCortaoDebug('off');
          seek(1);
          const upper = __viewer.current.object.getObjectByName('Upper');
          check(state().time === 1 && Math.abs(upper.quaternion.z - Math.SQRT1_2) < 1e-6, 'scrubbing poses the skeleton');
          check($('anim-time').textContent === '1.00 / 2.00 s', 'time readout');
          check(await pixels() !== rest, 'scrubbing changes rendered pixels');
          __viewer.setCortaoDebug('ao');check(await pixels()!==restAO,'Native CORTAO follows skeletal animation');__viewer.setCortaoDebug('off');
          check(__viewer.current.shading.bindings.some(b => b.mesh.isSkinnedMesh), 'outline hull follows the skin');
        `));
        await fs.writeFile(path.resolve('tests/out/animation-bar.png'), (await capture()).toPNG());
        await win.webContents.executeJavaScript(animationScript(`
          $('tab-overview').focus();
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
          check(!state().playing, 'Space is left to a focused button');
          document.activeElement.blur();
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
          check(state().playing && $('anim-play').title === '일시정지 (Space)', 'Space resumes');
          $('anim-seek').dispatchEvent(new PointerEvent('pointerdown'));
          check(!state().playing, 'scrubbing holds playback');
          $('anim-seek').dispatchEvent(new PointerEvent('pointerup'));
          check(state().playing, 'playback resumes after scrubbing');
          $('anim-clip').value = '1'; $('anim-clip').dispatchEvent(new Event('change'));
          check(state().index === 1 && state().time === 0 && $('anim-seek').max === '1', 'clip switch');
          check(Math.abs(__viewer.current.object.getObjectByName('Upper').quaternion.z) < 1e-9, 'previous clip released');
          $('anim-loop').click();
          $('anim-speed').value = '2'; $('anim-speed').dispatchEvent(new Event('change'));
          const prefs = JSON.parse(localStorage.getItem('animationPrefs'));
          check(!state().loop && state().speed === 2 && prefs.loop === false && prefs.speed === 2, 'loop and speed apply and persist');
          await wait(() => !state().playing);
          check(state().time === 1 && $('anim-play').title === '재생 (Space)', 'play once stops on the last frame');
          $('anim-play').click();
          check(state().playing && state().time === 0, 'replay starts over');
          $('anim-play').click(); $('anim-restart').click();
          check(state().time === 0 && $('anim-seek').value === '0', 'back to start');
          $('anim-loop').click();
          $('anim-speed').value = '1'; $('anim-speed').dispatchEvent(new Event('change'));
          await open(${JSON.stringify(genericPath)}, () => __viewer.current?.info.name === 'basic.fbx');
          check($('animation-bar').hidden && !$('viewport').classList.contains('has-animation') && state() === null, 'bar hides for the next model');
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        `));
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
        await win.webContents.executeJavaScript(`(async()=>{
          const v=__viewer,wait=async f=>{for(let i=0;i<500;i++){if(f())return;await new Promise(r=>setTimeout(r,20));}throw new Error('DX12 recovery timed out');};
          await wait(()=>!v.dx12.busy);const old=v.dx12.lastFrame.id,source=v.current.materials[0].material;
          const THREE=await import('three');source.displacementMap=new THREE.Texture();v.refreshMaterialTextures();
          await wait(()=>!!v.dx12.error);
          if(document.getElementById('renderer-error').hidden||v.renderer||document.getElementById('renderer-backend'))throw new Error('Native failure must show an error without browser fallback');
          source.displacementMap.dispose();source.displacementMap=null;v.refreshMaterialTextures();document.getElementById('renderer-retry').click();
          await wait(()=>v.dx12.enabled&&!v.dx12.error&&!v.dx12.busy&&v.dx12.lastFrame.id>old);
          if(!document.getElementById('renderer-error').hidden)throw new Error('Successful retry must clear the error');
          await api.dx12Stop();v.requestRender();await wait(()=>!!v.dx12.error);
          document.getElementById('renderer-retry').click();await wait(()=>v.dx12.enabled&&!v.dx12.error&&!v.dx12.busy);
        })()`);
        console.log('Material and shading UI smoke passed:', JSON.stringify({ ...result, ...shading, nativeRecovery: true }), '(PMX + FBX)');
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
