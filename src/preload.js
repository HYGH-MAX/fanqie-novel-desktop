const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fq', {
  state: () => ipcRenderer.invoke('app:state'),
  onState: (cb) => {
    ipcRenderer.on('fq:state', (_event, state) => cb(state))
  },

  pin: () => ipcRenderer.invoke('win:pin'),
  fullscreen: () => ipcRenderer.invoke('win:fullscreen'),
  toggleMax: () => ipcRenderer.invoke('win:toggle-max'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),

  openSettings: () => ipcRenderer.send('win:settings'),
  openRecent: () => ipcRenderer.send('win:recent'),

  settings: () => ipcRenderer.invoke('app:settings'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  recent: () => ipcRenderer.invoke('app:recent'),
  onRecent: (cb) => {
    ipcRenderer.on('fq:recent', (_event, items) => cb(items))
  },
  openRecentItem: (url) => ipcRenderer.invoke('recent:open', url),

  openDataDir: () => ipcRenderer.send('app:open-data-dir'),
  chooseDataDir: () => ipcRenderer.invoke('app:choose-data-dir'),
  restart: () => ipcRenderer.send('app:restart')
})
