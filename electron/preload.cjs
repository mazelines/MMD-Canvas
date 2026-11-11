const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('api', {
  startup: () => call('app:startup'),
  list: (dir) => call('fs:list', dir),
  drives: () => call('fs:drives'),
  stat: (p) => call('fs:stat', p),
  pickFolder: (defaultPath) => call('dialog:pickFolder', defaultPath),
  openFile: (defaultPath) => call('dialog:openFile', defaultPath),
  saveFile: (defaultPath, format) => call('dialog:saveFile', defaultPath, format),
  openWorkspace: (filePath = null) => call('workspace:open', filePath),
  saveWorkspace: (data, filePath = null, saveAs = false) => call('workspace:save', data, filePath, saveAs),
  onOpenFile: (fn) => ipcRenderer.on('app:open-file', (_event, filePath) => fn(filePath)),
  convertFile: (input, output, options) => call('convert:file', input, output, options),
  convertBatch: (dir, outDir, format, recursive, options) => call('convert:batch', dir, outDir, format, recursive, options),
  onConvertProgress: (fn) => ipcRenderer.on('convert:progress', (_e, p) => fn(p)),
  reveal: (p) => call('shell:reveal', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  notifyLoaded: (info) => ipcRenderer.send('viewer:loaded', info),
});
