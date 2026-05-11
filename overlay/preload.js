const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appleScripts', {
  get_todays_events: () => ipcRenderer.invoke('apple:get_todays_events'),
  get_upcoming_events: (days) => ipcRenderer.invoke('apple:get_upcoming_events', days),
  create_event: (args) => ipcRenderer.invoke('apple:create_event', args),
  get_reminders: () => ipcRenderer.invoke('apple:get_reminders'),
  create_reminder: (args) => ipcRenderer.invoke('apple:create_reminder', args),
  raw: (script) => ipcRenderer.invoke('run-applescript', script),
});

contextBridge.exposeInMainWorld('api', {
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  openPrivacy: (kind) => ipcRenderer.invoke('open-privacy', kind),
  resizeToContent: (h) => ipcRenderer.send('resize-to-content', h),
  setWindowSize: (width, height) => ipcRenderer.send('set-window-size', { width, height }),
  onManualResize: (cb) => ipcRenderer.on('manual-resize', cb),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
});

contextBridge.exposeInMainWorld('memory', {
  tree: () => ipcRenderer.invoke('memory:tree'),
  read: (path) => ipcRenderer.invoke('memory:read', path),
  write: (path, content) => ipcRenderer.invoke('memory:write', { path, content }),
  append: (path, content) => ipcRenderer.invoke('memory:append', { path, content }),
  delete: (path) => ipcRenderer.invoke('memory:delete', path),
});
