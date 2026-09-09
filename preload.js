// preload.js — context-isolated bridge between main and renderer.
// Exposes a minimal, typed API on window.sysglas.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sysglas', {
  // One-shot config fetch on load
  getConfig: () => ipcRenderer.invoke('config:get'),

  // Subscribe to live sensor pushes from the main process
  onSensorData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sensor:data', handler);
    return () => ipcRenderer.removeListener('sensor:data', handler);
  },

  // React to config changes
  onTheme:         (cb) => ipcRenderer.on('config:theme',        (_e, v) => cb(v)),
  onTransparency:  (cb) => ipcRenderer.on('config:transparency', (_e, v) => cb(v)),
  onPinChanged:    (cb) => ipcRenderer.on('widget:pin-changed',  (_e, v) => cb(v)),
  onGlassMode:     (cb) => ipcRenderer.on('config:glass-mode',   (_e, v) => cb(v)),
  onGameMode:      (cb) => ipcRenderer.on('config:game-mode',    (_e, v) => cb(v)),

  // Outbound signals
  setTheme:        (theme) => ipcRenderer.send('config:set-theme', theme),
  setTransparency: (v) => ipcRenderer.send('config:set-transparency', v),
  togglePin:       () => ipcRenderer.invoke('widget:toggle-pin'),
  toggleGameMode:  () => ipcRenderer.invoke('config:toggle-game-mode'),
  setGameMode:     (v) => ipcRenderer.send('config:set-game-mode', v),
  toggleGlassMode: () => ipcRenderer.invoke('config:toggle-glass-mode'),
  setGlassMode:    (v) => ipcRenderer.send('config:set-glass-mode', v),
  hideWidget:      () => ipcRenderer.send('widget:hide'),
  setStandby:      (isStandby, contentHeight) => ipcRenderer.send('widget:set-standby', isStandby, contentHeight),
  // Auto-updater
  onUpdateAvailable:  (cb) => ipcRenderer.on('updater:available',  (_e, info) => cb(info)),
  onUpdateProgress:   (cb) => ipcRenderer.on('updater:progress',   (_e, progress) => cb(progress)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('updater:downloaded', (_e, info) => cb(info)),
  restartAndInstall:  () => ipcRenderer.send('updater:restart-and-install'),
  checkForUpdates:    () => ipcRenderer.invoke('updater:check'),
  quitApp:            () => ipcRenderer.send('app:quit'),

  // Platform info
  platform: process.platform,
});