const { contextBridge, ipcRenderer, webUtils, sharedTexture } = require('electron');
const { GpuPresenter } = require('./gpu-presenter.cjs');
const presenter = new GpuPresenter();

if (sharedTexture) sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, id) => {
  let frame;
  try {
    frame = importedSharedTexture.getVideoFrame();
    const canvas = document.getElementById('dx12-canvas');
    if (!canvas) throw new Error('DX12 viewport canvas is not available');
    {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
      const context = canvas.getContext('2d', { alpha: false });
      if (context.isContextLost()) throw new Error('Failed to present shared texture: GPU is not available');
      const copied = await presenter.copy(frame);
      frame.close(); frame = null;
      context.drawImage(copied, 0, 0);
      // Let Chromium submit this canvas before accepting another native frame.
      // Without pacing, a burst of imports can outrun canvas submission and stall
      // the shared-image command stream. The timer also covers an occluded window.
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 100);
        requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
      });
      if (context.isContextLost()) throw new Error('Failed to present shared texture: GPU is not available');
      canvas.dataset.frame = String(id);
    }
    ipcRenderer.send('dx12:presented', id, null);
  } catch (error) {
    ipcRenderer.send('dx12:presented', id, error.message || String(error));
  } finally { frame?.close(); importedSharedTexture.release(); }
});

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('api', {
  dx12Start: () => call('dx12:start'),
  dx12Model: (data) => call('dx12:model', data),
  dx12Pose: (data) => call('dx12:pose', data),
  dx12Render: (data) => call('dx12:render', data),
  dx12Shader: (layers) => call('dx12:shader', layers),
  dx12Params: (data) => call('dx12:params', data),
  shaderStackGet: () => call('shader-stack:get'),
  shaderStackApply: (layers) => call('shader-stack:apply', layers),
  shaderStackParams: (values) => call('shader-stack:params', values),
  onShaderStackApplied: (fn) => ipcRenderer.on('shader-stack:applied', (_e, layers) => fn(layers)),
  onShaderStackUpdated: (fn) => ipcRenderer.on('shader-stack:updated', (_e, layers) => fn(layers)),
  dx12Stop: () => call('dx12:stop'),
  startup: () => call('app:startup'),
  list: (dir) => call('fs:list', dir),
  drives: () => call('fs:drives'),
  stat: (p) => call('fs:stat', p),
  pickFolder: (defaultPath) => call('dialog:pickFolder', defaultPath),
  openFile: (defaultPath) => call('dialog:openFile', defaultPath),
  saveFile: (defaultPath, format) => call('dialog:saveFile', defaultPath, format),
  openWorkspace: (filePath = null) => call('workspace:open', filePath),
  saveWorkspace: (data, filePath = null, saveAs = false) => call('workspace:save', data, filePath, saveAs),
  menuState: (state) => ipcRenderer.send('menu:state', state),
  onMenuCommand: (fn) => ipcRenderer.on('menu:command', (_event, command) => fn(command)),
  onOpenFile: (fn) => ipcRenderer.on('app:open-file', (_event, filePath) => fn(filePath)),
  convertFile: (input, output, options) => call('convert:file', input, output, options),
  convertBatch: (dir, outDir, format, recursive, options) => call('convert:batch', dir, outDir, format, recursive, options),
  onConvertProgress: (fn) => ipcRenderer.on('convert:progress', (_e, p) => fn(p)),
  reveal: (p) => call('shell:reveal', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  notifyLoaded: (info) => ipcRenderer.send('viewer:loaded', info),
});
