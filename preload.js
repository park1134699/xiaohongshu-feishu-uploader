const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopConfig', {
  loadConnection: () => ipcRenderer.invoke('connection-config:load'),
  saveConnection: config => ipcRenderer.invoke('connection-config:save', config),
  loadGroups: () => ipcRenderer.invoke('group-config:load'),
  saveGroups: config => ipcRenderer.invoke('group-config:save', config),
  loadImageUploadSettings: () => ipcRenderer.invoke('image-upload-config:load'),
  saveImageUploadSettings: config => ipcRenderer.sendSync('image-upload-config:save-sync', config),
});

contextBridge.exposeInMainWorld('desktopImages', {
  selectFolders: () => ipcRenderer.invoke('images:select-folders'),
  scanFolders: paths => ipcRenderer.invoke('images:scan-folders', paths),
});
