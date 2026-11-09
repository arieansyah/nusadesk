// NusaDesk signaling server
// Pairs devices by their 9-digit ID and relays WebRTC signaling (SDP/ICE).
// Screen/input/files never pass through here: they flow peer-to-peer over WebRTC.
// Passwords never pass through here either: the viewer proves the password to the
// host inside the encrypted WebRTC connection (see app/src/host.js / viewer.js).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const DB_FILE = process.env.NUSADESK_DB || path.join(__dirname, 'devices.json');
// Behind Cloudflare + Traefik the client IP comes from CF-Connecting-IP. Only trust
// forwarded headers when the deployment guarantees they cannot be spoofed.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const LIMITS = {
  socketsPerIp: Number(process.env.LIMIT_SOCKETS_PER_IP || 20),
  newIdsPerIpPerHour: Number(process.env.LIMIT_NEW_IDS_PER_IP || 20),
  connectPerIpPerMin: Number(process.env.LIMIT_CONNECT_PER_IP || 20),
  connectPerViewerPerMin: 10,
  pendingPerHost: 3,          // unanswered requests waiting on one host (popup spam)
  msgBurst: 300,              // token bucket per socket
  msgPerSec: 100,
  maxDevices: Number(process.env.MAX_DEVICES || 200000),
  deviceTtlDays: 180,
};
// Wrong-password lockouts (window 15 min): per attacker+host, per attacker, per host.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMITS = { ipHost: 5, ip: 20, host: 50 };

// ---------- device ownership: id -> { k: sha256(deviceKey), t: lastSeen } ----------
let owners = {};
try {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  for (const [id, v] of Object.entries(raw)) owners[id] = typeof v === 'string' ? { k: v, t: Date.now() } : v;
} catch { owners = {}; }
let saveTimer = null;
function saveOwners() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const cutoff = Date.now() - LIMITS.deviceTtlDays * 86400000;
    for (const [id, v] of Object.entries(owners)) if (v.t < cutoff && !online.has(id)) delete owners[id];
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(owners), (err) => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 2000);
}

const online = new Map();   // id -> ws
const sessions = new Map(); // sessionId -> { host, viewer, viewerIp, accepted, created }
const socketsPerIp = new Map();

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Fixed-window counters: hit() records one event and says whether it is within the limit.
const counters = new Map();
function hit(name, key, limit, windowMs) {
  const k = `${name}|${key}`;
  const now = Date.now();
  let c = counters.get(k);
  if (!c || now >= c.reset) { c = { n: 0, reset: now + windowMs }; counters.set(k, c); }
  c.n++;
  return c.n <= limit;
}
function count(name, key) {
  const c = counters.get(`${name}|${key}`);
  return c && Date.now() < c.reset ? c.n : 0;
}
function lockedOut(ip, host) {
  return count('fail-iphost', `${ip}>${host}`) >= FAIL_LIMITS.ipHost
    || count('fail-ip', ip) >= FAIL_LIMITS.ip
    || count('fail-host', host) >= FAIL_LIMITS.host;
}
function recordFailure(ip, host) {
  hit('fail-iphost', `${ip}>${host}`, Infinity, FAIL_WINDOW_MS);
  hit('fail-ip', ip, Infinity, FAIL_WINDOW_MS);
  hit('fail-host', host, Infinity, FAIL_WINDOW_MS);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, online: online.size, sessions: sessions.size }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const n = (socketsPerIp.get(ip) || 0) + 1;
  if (n > LIMITS.socketsPerIp) { ws.close(1008, 'too many connections'); return; }
  socketsPerIp.set(ip, n);
  ws.ip = ip;
  ws.isAlive = true;
  ws.tokens = LIMITS.msgBurst;
  ws.lastRefill = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.deviceId = null;

  ws.on('message', (raw) => {
    const now = Date.now();
    ws.tokens = Math.min(LIMITS.msgBurst, ws.tokens + ((now - ws.lastRefill) / 1000) * LIMITS.msgPerSec);
    ws.lastRefill = now;
    if (--ws.tokens < 0) { ws.close(1008, 'rate limited'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { log('handler error', e); }
  });

  ws.on('close', () => {
    const left = (socketsPerIp.get(ip) || 1) - 1;
    if (left <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, left);
    if (ws.deviceId && online.get(ws.deviceId) === ws) online.delete(ws.deviceId);
    for (const [sid, s] of sessions) {
      if (s.host === ws.deviceId || s.viewer === ws.deviceId) {
        const other = s.host === ws.deviceId ? s.viewer : s.host;
        send(online.get(other), { type: 'session-ended', sessionId: sid, reason: 'peer-disconnected' });
        sessions.delete(sid);
      }
    }
  });
});

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function handle(ws, msg) {
  if (msg.type === 'register') {
    const id = String(msg.id || '');
    const key = String(msg.deviceKey || '');
    if (!/^\d{9}$/.test(id) || key.length < 16 || key.length > 256) return send(ws, { type: 'error', code: 'bad-register' });
    const kh = hash(key);
    const owner = owners[id];
    if (owner && owner.k !== kh) return send(ws, { type: 'error', code: 'id-taken' });
    if (!owner) {
      if (Object.keys(owners).length >= LIMITS.maxDevices) return send(ws, { type: 'error', code: 'server-full' });
      if (!hit('newid', ws.ip, LIMITS.newIdsPerIpPerHour, 3600000)) return send(ws, { type: 'error', code: 'rate-limited' });
      owners[id] = { k: kh, t: Date.now() };
    } else {
      owner.t = Date.now();
    }
    saveOwners();
    const prev = online.get(id);
    if (prev && prev !== ws) { send(prev, { type: 'error', code: 'replaced' }); prev.close(); }
    ws.deviceId = id;
    online.set(id, ws);
    return send(ws, { type: 'registered', id });
  }

  const me = ws.deviceId;
  if (!me) return send(ws, { type: 'error', code: 'not-registered' });

  switch (msg.type) {
    case 'connect-request': {
      const target = String(msg.target || '').replace(/\D/g, '');
      const mode = msg.mode === 'password' ? 'password' : 'ask';
      const reject = (reason) => send(ws, { type: 'connect-result', accepted: false, reason });
      if (target === me) return reject('self');
      if (!hit('connect-ip', ws.ip, LIMITS.connectPerIpPerMin, 60000)
        || !hit('connect-viewer', me, LIMITS.connectPerViewerPerMin, 60000)) return reject('rate-limited');
      const hostWs = online.get(target);
      if (!hostWs) return reject('offline');
      if (mode === 'password' && lockedOut(ws.ip, target)) return reject('too-many-attempts');
      let pending = 0;
      for (const s of sessions.values()) if (s.host === target && !s.accepted) pending++;
      if (pending >= LIMITS.pendingPerHost) return reject('busy');
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { host: target, viewer: me, viewerIp: ws.ip, accepted: false, created: Date.now() });
      log('connect-request', mode);
      send(ws, { type: 'connect-pending', sessionId, target });
      send(hostWs, { type: 'incoming', sessionId, from: me, name: str(msg.name, 64), mode });
      return;
    }
    case 'connect-response': {
      const s = sessions.get(msg.sessionId);
      if (!s || s.host !== me) return;
      let auth = null;
      if (msg.accepted) {
        s.accepted = true;
        const a = msg.auth || {};
        auth = {
          required: !!a.required,
          salt: str(a.salt, 64),
          iters: Math.min(Math.max(Number(a.iters) || 0, 0), 5_000_000),
          nonce: str(a.nonce, 128),
        };
      } else {
        sessions.delete(msg.sessionId);
      }
      send(online.get(s.viewer), {
        type: 'connect-result', sessionId: msg.sessionId, accepted: !!msg.accepted,
        reason: msg.accepted ? null : str(msg.reason, 32) || 'rejected', auth,
      });
      return;
    }
    case 'auth-failed': { // reported by the host after a wrong password proof
      const s = sessions.get(msg.sessionId);
      if (!s || s.host !== me) return;
      recordFailure(s.viewerIp, s.host);
      sessions.delete(msg.sessionId);
      log('auth-failed');
      send(online.get(s.viewer), { type: 'session-ended', sessionId: msg.sessionId, reason: 'bad-password' });
      return;
    }
    case 'signal': {
      const s = sessions.get(msg.sessionId);
      if (!s || !s.accepted || (s.host !== me && s.viewer !== me)) return;
      const to = s.host === me ? s.viewer : s.host;
      send(online.get(to), { type: 'signal', sessionId: msg.sessionId, from: me, data: msg.data });
      return;
    }
    case 'end': {
      const s = sessions.get(msg.sessionId);
      if (!s || (s.host !== me && s.viewer !== me)) return;
      sessions.delete(msg.sessionId);
      const to = s.host === me ? s.viewer : s.host;
      send(online.get(to), { type: 'session-ended', sessionId: msg.sessionId, reason: 'peer-ended' });
      return;
    }
    case 'ping':
      return send(ws, { type: 'pong' });
  }
}

// Drop dead sockets, stale sessions and expired counters.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (!s.accepted && now - s.created > 2 * 60 * 1000) sessions.delete(sid);
  }
  for (const [k, c] of counters) if (now >= c.reset) counters.delete(k);
}, 30000);

server.listen(PORT, () => log(`NusaDesk signaling server on :${PORT}${TRUST_PROXY ? ' (trusting proxy headers)' : ''}`));
