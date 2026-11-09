// NusaDesk — Electron main process
// Owns: config (ID/password), the signaling WebSocket, window routing,
// screen-source selection and OS input injection.
'use strict';

const {
  app, BrowserWindow, ipcMain, session, desktopCapturer, screen,
  systemPreferences, clipboard, shell, Notification, safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let robot = null;
try { robot = require('@jitsi/robotjs'); robot.setMouseDelay(0); robot.setKeyboardDelay(0); }
catch (e) { console.error('robotjs failed to load — remote control disabled:', e.message); }

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// Development/test switches (NUSADESK_* env vars) only work in an unpackaged dev run:
// an installed app ignores them, so nobody can change its behaviour through the environment.
const DEV = !app.isPackaged;
const devEnv = (name) => (DEV ? process.env[name] : undefined);
const FAKE_SCREEN = devEnv('NUSADESK_FAKE_SCREEN') === '1'; // test mode: no real capture/injection
// No signaling server is built in: each user points the app at their own (self-hosted)
// server on first run. A packager can bake one in with
//   electron-builder -c.extraMetadata.nusadeskDefaultServer=wss://your.server
const DEFAULT_SERVER = devEnv('NUSADESK_SERVER') || (() => {
  try { return require('../package.json').nusadeskDefaultServer || ''; } catch { return ''; }
})();

// ---------- config ----------
if (devEnv('NUSADESK_PROFILE')) {
  app.setPath('userData', path.join(app.getPath('appData'), `NusaDesk-${devEnv('NUSADESK_PROFILE')}`));
}
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let config;
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); } catch { config = {}; }
  let changed = false;
  if (!/^\d{9}$/.test(config.id || '')) { config.id = String(crypto.randomInt(100000000, 999999999)); changed = true; }
  if (!config.deviceKey) { config.deviceKey = crypto.randomBytes(24).toString('hex'); changed = true; }
  if (!config.server && DEFAULT_SERVER) { config.server = DEFAULT_SERVER; changed = true; }
  if (!/^[0-9a-f]{32}$/.test(config.salt || '')) { config.salt = crypto.randomBytes(16).toString('hex'); changed = true; }
  if (config.allowFileTransfer === undefined) { config.allowFileTransfer = true; changed = true; }
  if (!config.name) { config.name = require('os').hostname(); changed = true; }
  // Older versions stored the unattended password in plain text: keep only a derived key.
  if (typeof config.unattendedPassword === 'string') {
    if (config.unattendedPassword) setUnattendedPassword(config.unattendedPassword);
    delete config.unattendedPassword;
    changed = true;
  }
  if (changed) saveConfig();
  newSessionPassword();
}
function saveConfig() {
  const { sessionPassword, ...persist } = config;
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(persist, null, 2));
}

// ---------- passwords & end-to-end authentication ----------
// The password never leaves this computer and never goes to the signaling server.
// Both sides derive K = PBKDF2(password, salt, ITERS). After the WebRTC connection is up,
// the viewer sends HMAC(K, nonce | hostFingerprint | viewerFingerprint) inside the
// encrypted channel. Binding the DTLS fingerprints means a signaling server that swaps
// them (man-in-the-middle) produces a proof that does not verify on the host.
const AUTH_ITERS = 210000;
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i
let sessionKey = null;
const authPending = new Map(); // sessionId -> { nonce, from, name }

const deriveKey = (pw) => crypto.pbkdf2Sync(String(pw), config.salt, AUTH_ITERS, 32, 'sha256');

function newSessionPassword() {
  let pw = '';
  for (let i = 0; i < 10; i++) pw += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
  config.sessionPassword = pw; // ~49 bits, regenerated on every launch
  sessionKey = deriveKey(pw);
}
function setUnattendedPassword(pw) {
  if (!pw) { delete config.unattendedKey; delete config.unattendedKeyEnc; return; }
  const hex = deriveKey(pw).toString('hex');
  if (safeStorage.isEncryptionAvailable()) { // macOS Keychain / Windows DPAPI
    config.unattendedKeyEnc = safeStorage.encryptString(hex).toString('base64');
    delete config.unattendedKey;
  } else {
    config.unattendedKey = hex; // still not the password itself
    delete config.unattendedKeyEnc;
  }
}
function unattendedKey() {
  try {
    if (config.unattendedKeyEnc) return Buffer.from(safeStorage.decryptString(Buffer.from(config.unattendedKeyEnc, 'base64')), 'hex');
    if (config.unattendedKey) return Buffer.from(config.unattendedKey, 'hex');
  } catch (e) { console.error('cannot read unattended key', e.message); }
  return null;
}
const hasUnattended = () => !!(config.unattendedKeyEnc || config.unattendedKey);

function verifyProof(sessionId, hostFp, viewerFp, proofHex) {
  const p = authPending.get(sessionId);
  authPending.delete(sessionId); // one attempt per session
  if (!p || typeof proofHex !== 'string' || !/^[0-9a-f]{64}$/.test(proofHex)) return false;
  const msg = `nusadesk-auth-v1|${p.nonce}|${hostFp}|${viewerFp}`;
  const proof = Buffer.from(proofHex, 'hex');
  let ok = false;
  for (const key of [sessionKey, unattendedKey()]) {
    if (!key) continue;
    const expected = crypto.createHmac('sha256', key).update(msg).digest();
    if (crypto.timingSafeEqual(expected, proof)) ok = true;
  }
  return ok;
}

// ---------- windows ----------
let mainWin = null;
const viewerWins = new Map(); // sessionId -> BrowserWindow
const pendingViewers = [];    // windows waiting for a connect-pending (FIFO)

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 880, height: 600, minWidth: 760, minHeight: 520,
    title: 'NusaDesk',
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
}

function openViewer(target, password) {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 480, minHeight: 320,
    title: `NusaDesk — ${formatId(target)}`,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'viewer.html'), { query: { target } });
  // The password stays in this process until the viewer window asks for it once.
  win.nusa = { target, sessionId: null, password: password || '' };
  pendingViewers.push(win);
  win.webContents.once('did-finish-load', () => {
    sig({ type: 'connect-request', target, mode: password ? 'password' : 'ask', name: config.name });
  });
  win.on('closed', () => {
    const i = pendingViewers.indexOf(win);
    if (i >= 0) pendingViewers.splice(i, 1);
    if (win.nusa.sessionId) {
      sig({ type: 'end', sessionId: win.nusa.sessionId });
      viewerWins.delete(win.nusa.sessionId);
    }
  });
}

const formatId = (id) => String(id).replace(/(\d{3})(?=\d)/g, '$1 ');

// ---------- signaling ----------
let ws = null;
let wsState = 'offline';
let reconnectTimer = null;
let backoff = 1000;

function setState(s, detail) {
  wsState = s;
  mainWin?.webContents.send('status', { state: s, detail: detail || null });
}

function connectSignaling() {
  clearTimeout(reconnectTimer);
  try { ws?.close(); } catch {}
  setState('connecting');
  let sock;
  if (!config.server) { setState('unconfigured'); return; } // first run: user sets a server
  try { sock = new WebSocket(config.server); }
  catch (e) { setState('offline', e.message); return scheduleReconnect(); }
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    sock.send(JSON.stringify({ type: 'register', id: config.id, deviceKey: config.deviceKey }));
  };
  sock.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    onSignal(msg);
  };
  sock.onclose = () => { if (ws === sock) { setState('offline'); scheduleReconnect(); } };
  sock.onerror = () => {};
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectSignaling, backoff);
  backoff = Math.min(backoff * 2, 15000);
}
function sig(msg) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

const hostSessions = new Set(); // sessionIds where we are the host
let autoConnected = false;

// Test hook (host side): after N ms print the verification codes of host sessions.
function scheduleHostSnapshot() {
  const ms = Number(devEnv('NUSADESK_TEST_HOST_SNAPSHOT_MS') || 0);
  if (!ms) return;
  setTimeout(async () => {
    const codes = await mainWin?.webContents.executeJavaScript('[...NusaHost.sessions.values()].map((s) => s.sas)');
    const shotDir = devEnv('NUSADESK_SHOT_DIR');
    if (shotDir && indicatorWin) fs.writeFileSync(path.join(shotDir, 'host-indicator.png'), (await indicatorWin.webContents.capturePage()).toPNG());
    if (shotDir && mainWin) fs.writeFileSync(path.join(shotDir, 'host-main.png'), (await mainWin.webContents.capturePage()).toPNG());
    console.log('NUSADESK_HOST_SNAPSHOT ' + JSON.stringify({ codes, indicator: !!indicatorWin }));
  }, ms);
}

// Test hook: after N ms print each viewer's connection state as JSON and quit.
function scheduleTestReport() {
  const ms = Number(devEnv('NUSADESK_TEST_REPORT_MS') || 0);
  if (!ms) return;
  setTimeout(async () => {
    const out = [];
    const shotDir = devEnv('NUSADESK_SHOT_DIR');
    if (shotDir) {
      let i = 0;
      for (const w of BrowserWindow.getAllWindows()) {
        const img = await w.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, `${devEnv('NUSADESK_PROFILE') || 'app'}-${w === mainWin ? 'main' : 'viewer' + i++}.png`), img.toPNG());
      }
    }
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === mainWin || w === indicatorWin) continue;
      try { out.push(await w.webContents.executeJavaScript('window.__nusaTest && window.__nusaTest()')); } catch (e) { out.push({ error: e.message }); }
    }
    console.log('NUSADESK_TEST_REPORT ' + JSON.stringify(out));
    app.exit(0);
  }, ms);
}

function onSignal(msg) {
  switch (msg.type) {
    case 'registered':
      setState('online');
      if (devEnv('NUSADESK_AUTOCONNECT') && !autoConnected) { // test hook: "id:password"
        autoConnected = true;
        const [t, pw] = devEnv('NUSADESK_AUTOCONNECT').split(':');
        setTimeout(() => openViewer(t, pw), 500);
      }
      break;
    case 'error':
      if (msg.code === 'id-taken') {
        // Another device owns this ID on this server: pick a fresh one.
        config.id = String(crypto.randomInt(100000000, 999999999));
        saveConfig();
        mainWin?.webContents.send('config', publicConfig());
        sig({ type: 'register', id: config.id, deviceKey: config.deviceKey });
      } else if (msg.code === 'replaced') {
        setState('offline', 'ID ini dibuka di aplikasi lain');
      } else if (msg.code === 'rate-limited' || msg.code === 'server-full') {
        setState('offline', 'server sedang membatasi pendaftaran, coba lagi nanti');
      }
      break;
    case 'incoming': handleIncoming(msg); break;
    case 'connect-pending': {
      const win = pendingViewers.shift();
      if (!win || win.isDestroyed()) { sig({ type: 'end', sessionId: msg.sessionId }); break; }
      win.nusa.sessionId = msg.sessionId;
      viewerWins.set(msg.sessionId, win);
      win.webContents.send('viewer-event', { type: 'pending', sessionId: msg.sessionId });
      break;
    }
    case 'connect-result': {
      if (!msg.sessionId) { // rejected before a session existed (offline, self, rate-limited)
        const win = pendingViewers.shift();
        win?.webContents.send('viewer-event', { type: 'result', accepted: false, reason: msg.reason });
        break;
      }
      viewerWins.get(msg.sessionId)?.webContents.send('viewer-event', { ...msg, type: 'result' });
      break;
    }
    case 'signal':
      if (hostSessions.has(msg.sessionId)) mainWin?.webContents.send('host-signal', msg);
      else viewerWins.get(msg.sessionId)?.webContents.send('viewer-event', { ...msg, type: 'signal' });
      break;
    case 'session-ended':
      if (hostSessions.has(msg.sessionId)) {
        hostSessions.delete(msg.sessionId);
        authPending.delete(msg.sessionId);
        mainWin?.webContents.send('host-ended', msg);
      } else {
        viewerWins.get(msg.sessionId)?.webContents.send('viewer-event', { type: 'ended', reason: msg.reason });
      }
      break;
  }
}

function handleIncoming(msg) {
  if (msg.mode === 'password') {
    // Provisional accept: the WebRTC connection is built, but the host shares nothing
    // (no screen, no input, no files) until the viewer's password proof verifies.
    if (authPending.size >= 3) {
      return sig({ type: 'connect-response', sessionId: msg.sessionId, accepted: false, reason: 'busy' });
    }
    const nonce = crypto.randomBytes(32).toString('hex');
    authPending.set(msg.sessionId, { nonce, from: msg.from, name: msg.name });
    setTimeout(() => authPending.delete(msg.sessionId), 60000);
    hostSessions.add(msg.sessionId);
    mainWin?.webContents.send('host-start', { sessionId: msg.sessionId, from: msg.from, name: msg.name, viaPassword: true, needsAuth: true });
    sig({ type: 'connect-response', sessionId: msg.sessionId, accepted: true, auth: { required: true, salt: config.salt, iters: AUTH_ITERS, nonce } });
    return;
  }
  // No password: ask the person at this computer.
  mainWin?.webContents.send('incoming-request', { sessionId: msg.sessionId, from: msg.from, name: msg.name });
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show(); mainWin.focus();
    if (IS_MAC) app.dock?.bounce('critical');
  }
  if (Notification.isSupported()) {
    new Notification({ title: 'NusaDesk', body: `${msg.name || formatId(msg.from)} ingin mengakses komputer ini` }).show();
  }
}

function acceptIncoming(msg, viaPassword) {
  hostSessions.add(msg.sessionId);
  mainWin?.webContents.send('host-start', { sessionId: msg.sessionId, from: msg.from, name: msg.name, viaPassword, needsAuth: false });
  sig({ type: 'connect-response', sessionId: msg.sessionId, accepted: true, auth: { required: false } });
}

// ---------- screen capture ----------
// The renderer captures with getUserMedia({chromeMediaSource:'desktop'}), which needs no
// user gesture; we hand it the desktopCapturer source id for the chosen display.
async function screenSource(displayId) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const primary = screen.getPrimaryDisplay();
  const want = displayId != null ? String(displayId) : String(primary.id);
  const src = sources.find((s) => s.display_id === want) || sources.find((s) => s.display_id === String(primary.id)) || sources[0];
  if (!src) return null;
  const d = screen.getAllDisplays().find((x) => String(x.id) === src.display_id) || primary;
  return {
    sourceId: src.id,
    displayId: src.display_id,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
  };
}

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Layar ${i + 1}${d.id === primary ? ' (utama)' : ''} — ${d.size.width}×${d.size.height}`,
    primary: d.id === primary,
  }));
}

// ---------- input injection ----------
const KEYMAP = {
  Backspace: 'backspace', Delete: 'delete', Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Escape: 'escape',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert',
  Space: 'space', CapsLock: 'capslock',
  ShiftLeft: 'shift', ShiftRight: 'right_shift', ControlLeft: 'control', ControlRight: 'right_control',
  AltLeft: 'alt', AltRight: 'right_alt', MetaLeft: 'command', MetaRight: 'command',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'numpad_+', NumpadSubtract: 'numpad_-', NumpadMultiply: 'numpad_*', NumpadDivide: 'numpad_/',
  NumpadDecimal: 'numpad_.', PrintScreen: 'printscreen',
  AudioVolumeMute: 'audio_mute', AudioVolumeDown: 'audio_vol_down', AudioVolumeUp: 'audio_vol_up',
};
function mapKey(code) {
  if (KEYMAP[code]) return KEYMAP[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `numpad_${m[1]}`;
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) <= 24) return `f${m[1]}`;
  return null;
}

const downKeys = new Set();
const downButtons = new Set();
let currentDisplayId = null;

function displayForInput() {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(currentDisplayId)) || screen.getPrimaryDisplay();
}
function toScreenPoint(nx, ny) {
  const d = displayForInput();
  const b = d.bounds;
  const x = b.x + Math.min(Math.max(nx, 0), 0.9999) * b.width;
  const y = b.y + Math.min(Math.max(ny, 0), 0.9999) * b.height;
  // robotjs on Windows works in physical pixels; on macOS in points (= DIP).
  if (IS_WIN) return screen.dipToScreenPoint({ x, y });
  return { x, y };
}

function injectInput(ev) {
  if (!robot || FAKE_SCREEN) return;
  try {
    switch (ev.t) {
      case 'mm': { const p = toScreenPoint(ev.x, ev.y); robot.moveMouse(Math.round(p.x), Math.round(p.y)); break; }
      case 'md':
      case 'mu': {
        const p = toScreenPoint(ev.x, ev.y);
        robot.moveMouse(Math.round(p.x), Math.round(p.y));
        const btn = ['left', 'middle', 'right'][ev.b] || 'left';
        if (ev.t === 'md') { downButtons.add(btn); robot.mouseToggle('down', btn); }
        else { downButtons.delete(btn); robot.mouseToggle('up', btn); }
        break;
      }
      case 'dc': { const p = toScreenPoint(ev.x, ev.y); robot.moveMouse(Math.round(p.x), Math.round(p.y)); robot.mouseClick('left', true); break; }
      case 'wh': {
        // ev.dx/dy are browser wheel deltas in pixels (positive = scroll down/right).
        // macOS robotjs posts pixel scroll events where positive = up/left;
        // Windows posts WHEEL/HWHEEL data (120 per notch, positive = up / right).
        const clamp = (v) => Math.max(-2400, Math.min(2400, Math.round(v)));
        let dx, dy;
        if (IS_WIN) { dx = clamp(ev.dx * 1.2); dy = clamp(-ev.dy * 1.2); }
        else { dx = clamp(-ev.dx); dy = clamp(-ev.dy); }
        if (dx || dy) robot.scrollMouse(dx, dy);
        break;
      }
      case 'kd':
      case 'ku': {
        const k = mapKey(ev.code);
        if (!k) {
          // Unknown physical key (e.g. non-US layouts): type the produced character instead.
          if (ev.t === 'kd' && typeof ev.key === 'string' && [...ev.key].length === 1 && !ev.mod) robot.typeString(ev.key);
          break;
        }
        if (ev.t === 'kd') { downKeys.add(k); robot.keyToggle(k, 'down'); }
        else { downKeys.delete(k); robot.keyToggle(k, 'up'); }
        break;
      }
      case 'txt': // characters that have no physical-key equivalent (IME, emoji)
        if (typeof ev.s === 'string' && ev.s.length <= 256) robot.typeString(ev.s);
        break;
      case 'release-all': releaseAll(); break;
    }
  } catch (e) {
    console.error('inject error', ev.t, e.message);
  }
}
function releaseAll() {
  if (!robot) return;
  for (const k of downKeys) { try { robot.keyToggle(k, 'up'); } catch {} }
  for (const b of downButtons) { try { robot.mouseToggle('up', b); } catch {} }
  downKeys.clear(); downButtons.clear();
}

// ---------- permissions (macOS) ----------
function permissionStatus() {
  if (!IS_MAC) return { screen: 'granted', accessibility: true, platform: process.platform };
  return {
    platform: process.platform,
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function publicConfig() {
  return {
    id: config.id, idFormatted: formatId(config.id), server: config.server, name: config.name,
    sessionPassword: config.sessionPassword, hasUnattended: hasUnattended(),
    robot: !!robot, fake: FAKE_SCREEN, platform: process.platform, version: app.getVersion(),
    allowFileTransfer: config.allowFileTransfer !== false, downloadDir: downloadDir(),
  };
}

// ---------- file transfer (receiving side) ----------
// Incoming files are streamed to "<Downloads>/NusaDesk/<name>.nusapart" and renamed to a
// unique final name once complete; aborted transfers leave nothing behind.
function downloadDir() {
  return devEnv('NUSADESK_DOWNLOAD_DIR') || path.join(app.getPath('downloads'), 'NusaDesk');
}
const incomingFiles = new Map(); // id -> { fd, tmp, name, size, written }

function safeFileName(name) {
  let n = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 200) || 'file';
}
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
function abortIncoming(id) {
  const f = incomingFiles.get(id);
  if (!f) return;
  incomingFiles.delete(id);
  try { fs.closeSync(f.fd); } catch {}
  try { fs.unlinkSync(f.tmp); } catch {}
}
const okId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

// Received files are marked as coming from the internet, so Gatekeeper (macOS) and
// SmartScreen / Office Protected View (Windows) still check them when opened.
function markFromInternet(file) {
  try {
    if (IS_MAC) {
      const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};NusaDesk;`;
      require('child_process').execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], () => {});
    } else if (IS_WIN) {
      fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    }
  } catch (e) { console.error('cannot mark file', e.message); }
}

function registerFileIpc() {
  ipcMain.handle('file-open', (_e, { id, name, size }) => {
    if (!okId(id) || incomingFiles.has(id)) return { ok: false, error: 'ID transfer tidak valid' };
    try {
      const dir = downloadDir();
      fs.mkdirSync(dir, { recursive: true });
      const clean = safeFileName(name);
      const tmp = path.join(dir, `.${id}.nusapart`);
      const fd = fs.openSync(tmp, 'w');
      incomingFiles.set(id, { fd, tmp, name: clean, size: Number(size) || 0, written: 0 });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('file-write', (_e, { id, data }) => {
    const f = incomingFiles.get(id);
    if (!f) return { ok: false, error: 'Transfer tidak ditemukan' };
    try {
      const buf = Buffer.from(data);
      if (f.written + buf.length > f.size) throw new Error('Data melebihi ukuran file');
      fs.writeSync(f.fd, buf);
      f.written += buf.length;
      return { ok: true };
    } catch (e) { abortIncoming(id); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('file-close', (_e, { id }) => {
    const f = incomingFiles.get(id);
    if (!f) return { ok: false, error: 'Transfer tidak ditemukan' };
    try {
      if (f.written !== f.size) throw new Error(`File tidak lengkap (${f.written}/${f.size} byte)`);
      fs.closeSync(f.fd);
      const final = uniquePath(path.dirname(f.tmp), f.name);
      fs.renameSync(f.tmp, final);
      markFromInternet(final);
      incomingFiles.delete(id);
      if (Notification.isSupported() && !devEnv('NUSADESK_DOWNLOAD_DIR')) {
        const n = new Notification({ title: 'NusaDesk — file diterima', body: path.basename(final) });
        n.on('click', () => shell.showItemInFolder(final));
        n.show();
      }
      return { ok: true, path: final, name: path.basename(final) };
    } catch (e) { abortIncoming(id); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('file-abort', (_e, { id }) => { abortIncoming(id); return { ok: true }; });
  ipcMain.handle('show-file', (_e, p) => {
    const dir = path.resolve(downloadDir());
    const target = path.resolve(String(p || ''));
    if (target.startsWith(dir + path.sep)) shell.showItemInFolder(target);
  });
  ipcMain.handle('open-downloads', () => {
    fs.mkdirSync(downloadDir(), { recursive: true });
    shell.openPath(downloadDir());
  });
  ipcMain.handle('allow-file-transfer', () => config.allowFileTransfer !== false);
  ipcMain.handle('test-env', () => ({ sendBytes: Number(devEnv('NUSADESK_TEST_SEND_BYTES') || 0), autoAcceptFiles: !!devEnv('NUSADESK_TEST_SEND_BYTES') }));
}

// ---------- "being controlled" indicator ----------
// A small always-on-top bar while anyone is connected to this computer, with a
// disconnect button: the person at the computer always sees that it is shared.
let indicatorWin = null;
function updateIndicator(list) {
  if (!list.length) { indicatorWin?.close(); indicatorWin = null; return; }
  const height = 46 + list.length * 40;
  if (!indicatorWin || indicatorWin.isDestroyed()) {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = 460;
    indicatorWin = new BrowserWindow({
      width, height, x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + 8,
      frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#171a21', title: 'NusaDesk — sesi aktif',
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    indicatorWin.setAlwaysOnTop(true, 'screen-saver');
    indicatorWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    indicatorWin.setContentProtection(true); // keep it out of the shared screen
    indicatorWin.loadFile(path.join(__dirname, 'indicator.html'));
    indicatorWin.once('ready-to-show', () => indicatorWin?.showInactive());
    indicatorWin.on('closed', () => { indicatorWin = null; });
    indicatorWin.webContents.once('did-finish-load', () => indicatorWin?.webContents.send('indicator', list));
  } else {
    indicatorWin.setSize(indicatorWin.getSize()[0], height);
    indicatorWin.webContents.send('indicator', list);
  }
}

// ---------- Electron hardening ----------
function hardenSessions() {
  // Only screen capture is ever needed; deny every other web permission.
  const allowed = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  app.on('web-contents-created', (_e, contents) => {
    // The app only shows its own local pages: no navigation, pop-ups or webviews.
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.on('will-redirect', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('get-config', () => publicConfig());
  ipcMain.handle('get-status', () => ({ state: wsState }));
  ipcMain.handle('set-settings', (_e, s) => {
    if (typeof s.server === 'string' && /^wss?:\/\//.test(s.server.trim())) config.server = s.server.trim();
    if (typeof s.name === 'string' && s.name.trim()) config.name = s.name.trim().slice(0, 64);
    if (s.clearUnattended === true) setUnattendedPassword('');
    if (typeof s.unattendedPassword === 'string' && s.unattendedPassword) {
      if (s.unattendedPassword.length < 8) return { ...publicConfig(), error: 'Kata sandi unattended minimal 8 karakter' };
      setUnattendedPassword(s.unattendedPassword);
    }
    if (typeof s.allowFileTransfer === 'boolean') config.allowFileTransfer = s.allowFileTransfer;
    saveConfig();
    connectSignaling();
    return publicConfig();
  });
  ipcMain.handle('new-session-password', () => { newSessionPassword(); return publicConfig(); });
  // Host: check the viewer's password proof (see "end-to-end authentication" above).
  ipcMain.handle('verify-proof', (_e, { sessionId, hostFp, viewerFp, proof }) => {
    const ok = verifyProof(sessionId, String(hostFp || ''), String(viewerFp || ''), proof);
    if (!ok) sig({ type: 'auth-failed', sessionId });
    return ok;
  });
  // Viewer: hand over the typed password once, then forget it.
  ipcMain.handle('viewer-password', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w?.nusa) return '';
    const pw = w.nusa.password;
    w.nusa.password = '';
    return pw;
  });
  ipcMain.on('host-sessions', (_e, list) => updateIndicator(Array.isArray(list) ? list.slice(0, 8) : []));
  ipcMain.on('indicator-end', (_e, sessionId) => mainWin?.webContents.send('host-end-request', String(sessionId)));
  ipcMain.handle('connect-to', (_e, { target, password }) => {
    const t = String(target || '').replace(/\D/g, '');
    if (!/^\d{9}$/.test(t)) return { ok: false, error: 'ID harus 9 digit' };
    if (t === config.id) return { ok: false, error: 'Itu ID komputer ini sendiri' };
    if (wsState !== 'online') return { ok: false, error: 'Belum terhubung ke server' };
    openViewer(t, password);
    return { ok: true };
  });
  ipcMain.handle('incoming-decision', (_e, { sessionId, accept, from, name }) => {
    if (accept) acceptIncoming({ sessionId, from, name }, false);
    else sig({ type: 'connect-response', sessionId, accepted: false, reason: 'rejected' });
  });
  ipcMain.handle('host-end', (_e, { sessionId }) => {
    hostSessions.delete(sessionId);
    releaseAll();
    sig({ type: 'end', sessionId });
  });
  ipcMain.on('signal-out', (_e, { sessionId, data }) => sig({ type: 'signal', sessionId, data }));
  ipcMain.handle('select-display', (_e, id) => { currentDisplayId = id; return true; });
  ipcMain.handle('screen-source', (_e, id) => screenSource(id));
  ipcMain.handle('list-displays', () => listDisplays());
  ipcMain.on('inject', (_e, ev) => injectInput(ev));
  ipcMain.handle('clipboard-read', () => clipboard.readText());
  ipcMain.handle('clipboard-write', (_e, text) => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 1_000_000)); });
  ipcMain.handle('permissions', () => permissionStatus());
  ipcMain.handle('request-accessibility', () => IS_MAC ? systemPreferences.isTrustedAccessibilityClient(true) : true);
  ipcMain.handle('open-privacy', (_e, which) => {
    if (!IS_MAC) return;
    const pane = which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  });
  ipcMain.handle('viewer-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('viewer-fullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setFullScreen(!w.isFullScreen());
  });
  ipcMain.handle('is-fake', () => FAKE_SCREEN);
  registerFileIpc();
}

// ---------- app lifecycle ----------
if (!app.requestSingleInstanceLock() && !devEnv('NUSADESK_PROFILE')) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
  app.whenReady().then(() => {
    hardenSessions();
    loadConfig();
    registerIpc();
    createMainWindow();
    connectSignaling();
    scheduleTestReport();
    scheduleHostSnapshot();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { releaseAll(); for (const id of [...incomingFiles.keys()]) abortIncoming(id); });
}
