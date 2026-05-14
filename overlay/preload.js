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

contextBridge.exposeInMainWorld('mail', {
  get_unread: (limit) => ipcRenderer.invoke('mail:get_unread', limit),
  search: (args) => ipcRenderer.invoke('mail:search', args),
  create_draft: (args) => ipcRenderer.invoke('mail:create_draft', args),
  mark_read: (args) => ipcRenderer.invoke('mail:mark_read', args),
});

contextBridge.exposeInMainWorld('anki', {
  list_decks: () => ipcRenderer.invoke('anki:list_decks'),
  add_card: (args) => ipcRenderer.invoke('anki:add_card', args),
  search_cards: (args) => ipcRenderer.invoke('anki:search_cards', args),
});

contextBridge.exposeInMainWorld('weather', {
  get: (location) => ipcRenderer.invoke('weather:get', { location }),
});

contextBridge.exposeInMainWorld('obsidian', {
  list_vault: (args) => ipcRenderer.invoke('obsidian:list_vault', args),
  list_dir: (args) => ipcRenderer.invoke('obsidian:list_dir', args),
  get_file: (args) => ipcRenderer.invoke('obsidian:get_file', args),
  search: (args) => ipcRenderer.invoke('obsidian:search', args),
  patch: (args) => ipcRenderer.invoke('obsidian:patch', args),
  append: (args) => ipcRenderer.invoke('obsidian:append', args),
  delete: (args) => ipcRenderer.invoke('obsidian:delete', args),
  list_tools: () => ipcRenderer.invoke('obsidian:list_tools'),
});
