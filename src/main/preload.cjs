// The only bridge between the UI and the main process. The page gets a single
// `call(method, args)` function; it has no access to Node, files, or the DB.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mma', {
  call: (method, args) => ipcRenderer.invoke('mma:call', method, args ?? {}),
  // Full path of a file dropped onto the window (for receipts / CSV import).
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: (handler) => ipcRenderer.on('mma:menu', (_e, action) => handler(action)),
});
