'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('nusa', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  newSessionPassword: () => ipcRenderer.invoke('new-session-password'),
  connectTo: (target, password) => ipcRenderer.invoke('connect-to', { target, password }),
  incomingDecision: (d) => ipcRenderer.invoke('incoming-decision', d),
  hostEnd: (sessionId) => ipcRenderer.invoke('host-end', { sessionId }),
  signal: (sessionId, data) => ipcRenderer.send('signal-out', { sessionId, data }),
  selectDisplay: (id) => ipcRenderer.invoke('select-display', id),
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  screenSource: (displayId) => ipcRenderer.invoke('screen-source', displayId),
  inject: (ev) => ipcRenderer.send('inject', ev),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  clipboardWrite: (t) => ipcRenderer.invoke('clipboard-write', t),
  permissions: () => ipcRenderer.invoke('permissions'),
  requestAccessibility: () => ipcRenderer.invoke('request-accessibility'),
  openPrivacy: (which) => ipcRenderer.invoke('open-privacy', which),
  viewerClose: () => ipcRenderer.invoke('viewer-close'),
  viewerFullscreen: () => ipcRenderer.invoke('viewer-fullscreen'),
  isFake: () => ipcRenderer.invoke('is-fake'),
  fileOpen: (id, name, size) => ipcRenderer.invoke('file-open', { id, name, size }),
  fileWrite: (id, data) => ipcRenderer.invoke('file-write', { id, data }),
  fileClose: (id) => ipcRenderer.invoke('file-close', { id }),
  fileAbort: (id) => ipcRenderer.invoke('file-abort', { id }),
  showFile: (p) => ipcRenderer.invoke('show-file', p),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  allowFileTransfer: () => ipcRenderer.invoke('allow-file-transfer'),
  testEnv: () => ipcRenderer.invoke('test-env'),
  verifyProof: (sessionId, hostFp, viewerFp, proof) => ipcRenderer.invoke('verify-proof', { sessionId, hostFp, viewerFp, proof }),
  viewerPassword: () => ipcRenderer.invoke('viewer-password'),
  reportHostSessions: (list) => ipcRenderer.send('host-sessions', list),
  indicatorEnd: (sessionId) => ipcRenderer.send('indicator-end', sessionId),
  onIndicator: on('indicator'),
  onHostEndRequest: on('host-end-request'),

  onStatus: on('status'),
  onConfig: on('config'),
  onIncomingRequest: on('incoming-request'),
  onHostStart: on('host-start'),
  onHostSignal: on('host-signal'),
  onHostEnded: on('host-ended'),
  onViewerEvent: on('viewer-event'),
});
