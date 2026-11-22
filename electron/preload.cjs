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
  dx12MaterialStacks: (stackIds) => call('dx12:matstacks', stackIds),
  dx12Pick: (x, y) => call('dx12:pick', x, y),
  shaderStackLibraryGet: () => call('shader-stack:library-get'),
  shaderStackLibrarySet: (library) => call('shader-stack:library-set', library),
  shaderStackRestore: (payload) => call('shader-stack:restore', payload),
  shaderStackStackApply: (stackId, layers, outline) => call('shader-stack:stack-apply', { stackId, layers, outline }),
  shaderStackInstanceParams: (materialIndex, values) => call('shader-stack:instance-params', { materialIndex, values }),
  shaderStackAssign: (materialIndex, stackId) => call('shader-stack:assign', { materialIndex, stackId }),
  shaderStackPreviewShader: (stackId) => call('shader-stack:preview-shader', stackId),
  shaderStackMaterials: (names) => call('shader-stack:materials', names),
  onShaderStackApplied: (fn) => ipcRenderer.on('shader-stack:applied', (_e, state) => fn(state)),
  onShaderStackUpdated: (fn) => ipcRenderer.on('shader-stack:updated', (_e, state) => fn(state)),
  shaderRead: (filePath) => call('shader:read', filePath),
  shaderList: (dir) => call('shader:list', dir),
  shaderSave: (opts) => call('shader:save', opts),
  shaderDelete: (filePath) => call('shader:delete', filePath),
  shaderStackSetDir: (baseDir) => call('shader-stack:set-dir', baseDir),
  shaderStackSaveEntry: (stackId, saveAs) => call('shader-stack:save-entry', { stackId, saveAs }),
  shaderStackDeleteEntry: (stackId) => call('shader-stack:delete-entry', { stackId }),
  shaderDirty: () => call('shader:dirty'),
  dx12Stop: () => call('dx12:stop'),
  startup: () => call('app:startup'),
  getUpdate: () => call('app:update'),
  onUpdate: (fn) => ipcRenderer.on('app:update', (_event, update) => fn(update)),
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
  openExternal: (url) => call('shell:openExternal', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  notifyLoaded: (info) => ipcRenderer.send('viewer:loaded', info),
});
