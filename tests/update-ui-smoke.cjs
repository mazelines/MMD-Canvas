// Exercise real main/preload/renderer IPC with a fixed release response, without a live network or browser launch.
const { app, net, shell } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-update-')));
// Electron launched with a test script otherwise reports Electron's own version.
app.getVersion = () => require('../package.json').version;
process.env.MMDCONV_UPDATE_CHECK = '1';
process.env.MMDCONV_LOCALE = process.env.MMDCONV_LOCALE || 'ko';
process.env.MMDCONV_OPEN = path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
const fetch = net.fetch.bind(net), opened = []; let checks = 0;
net.fetch = async (url, options) => {
  if (url === 'https://api.github.com/repos/mazelines/MMD-Canvas/releases/latest') {
    checks++;
    return new Response(JSON.stringify({ tag_name: 'v0.9.0' }), { status: 200 });
  }
  return fetch(url, options);
};
shell.openExternal = async url => { opened.push(url); };
const timeout = setTimeout(() => { console.error('Update UI timed out'); app.exit(1); }, 90000);
app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', async () => {
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async code => {
    for (let i = 0; i < 600; i++) {
      if (await run(code).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('UI did not settle: ' + code);
  };
  try {
    await wait('document.getElementById("update-message").textContent.includes("0.9.0")');
    assert.equal(checks, 1);
    const banners = await run(`(() => {
      const u=document.getElementById('update-banner'),s=document.getElementById('star-banner');
      return { update:u.hidden,star:s.hidden,overlap:u.getBoundingClientRect().bottom>s.getBoundingClientRect().top,
        message:document.getElementById('update-message').textContent,download:document.getElementById('update-download').textContent };
    })()`);
    assert.equal(banners.update, false); assert.equal(banners.star, false); assert.equal(banners.overlap, false);
    if (process.env.MMDCONV_LOCALE === 'en') assert.equal(banners.download, 'Download');
    await run('document.getElementById("update-download").click()');
    await wait(`true`);
    assert.equal(opened[0], 'https://github.com/mazelines/MMD-Canvas/releases/tag/v0.9.0');
    await run('document.getElementById("update-dismiss").click();document.getElementById("star-dismiss").click()');
    assert.equal(await run('localStorage.getItem("updateDismissedVersion")'), '0.9.0');
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded;
    await wait('document.getElementById("update-message").textContent.includes("0.9.0")');
    assert.equal(await run('document.getElementById("update-banner").hidden && document.getElementById("star-banner").hidden'), true);
    win.webContents.send('app:update', { version: '0.10.0', url: 'https://github.com/mazelines/MMD-Canvas/releases/tag/v0.10.0' });
    await wait('!document.getElementById("update-banner").hidden && document.getElementById("update-message").textContent.includes("0.10.0")');
    console.log('Update UI passed:', banners, 'dismissal persisted; later release notified.');
    clearTimeout(timeout); app.quit();
  } catch (error) { console.error(error, { checks }); clearTimeout(timeout); app.exit(1); }
}));
import('../electron/main.js');
