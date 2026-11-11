// Viewer window: shows the remote screen and sends local mouse/keyboard input.
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (id) => String(id).replace(/(\d{3})(?=\d)/g, '$1 ');
// Fallback only: the main process passes the real config (STUN + per-session TURN relay).
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const target = new URLSearchParams(location.search).get('target') || '';
$('title').textContent = fmt(target);

const video = $('video');
const stage = $('stage');
let sessionId = null;
let pc = null;
let __iceOut = 0, __iceIn = 0;
let ctl = null;   // reliable channel: clicks, keys, control messages
let move = null;  // unreliable channel: mouse moves
const pendingIce = [];
let viewOnly = false;
let scaleMode = 'fit'; // 'fit' | 'actual'
let ended = false;
let auth = null;          // { required, salt, iters, nonce } from the host
let authorized = false;   // host accepted us (approval, or verified password proof)
let clipSync = false;     // automatic clipboard sync: off until the user turns it on
let testEnv = { sendBytes: 0, autoAcceptFiles: false };
nusa.testEnv().then((v) => { testEnv = v; });

const REASONS = {
  offline: 'Perangkat tujuan sedang offline atau ID salah.',
  rejected: 'Permintaan ditolak oleh pengguna di komputer tujuan.',
  'bad-password': 'Kata sandi salah.',
  'too-many-attempts': 'Terlalu banyak percobaan kata sandi salah. Coba lagi dalam 15 menit.',
  'rate-limited': 'Terlalu banyak permintaan koneksi. Tunggu sebentar lalu coba lagi.',
  busy: 'Komputer tujuan sedang menerima permintaan lain. Coba lagi sebentar lagi.',
  'auth-timeout': 'Verifikasi kata sandi tidak selesai. Coba lagi.',
  self: 'Tidak bisa terhubung ke komputer sendiri.',
  'peer-disconnected': 'Komputer tujuan terputus dari server.',
  'peer-ended': 'Sesi diakhiri oleh komputer tujuan.',
  failed: 'Koneksi peer-to-peer gagal. Jaringan memblokir koneksi langsung dan server ini belum menyediakan relay (TURN).',
  'failed-relay': 'Koneksi gagal, juga lewat server relay. Periksa koneksi internet kedua komputer, atau firewall yang memblokir port 3478.',
};

function overlay(title, text, { spinner = true, closable = false } = {}) {
  $('overlay').classList.remove('hidden');
  $('ovTitle').textContent = title;
  $('ovText').textContent = text || '';
  $('spinner').classList.toggle('hidden', !spinner);
  $('ovClose').classList.toggle('hidden', !closable);
}
function hideOverlay() { $('overlay').classList.add('hidden'); }
function fail(reason) {
  if (ended) return;
  ended = true;
  cleanup();
  overlay('Sesi berakhir', REASONS[reason] || reason || '', { spinner: false, closable: true });
}
$('ovClose').onclick = () => nusa.viewerClose();

overlay('Menghubungkan…', `Menghubungi ${fmt(target)}`);

// ---------- signaling ----------
nusa.onViewerEvent(async (ev) => {
  switch (ev.type) {
    case 'pending':
      sessionId = ev.sessionId;
      overlay('Menunggu persetujuan…', 'Pengguna di komputer tujuan perlu menerima permintaan ini (atau masukkan kata sandi).');
      break;
    case 'result':
      if (!ev.accepted) return fail(ev.reason || 'rejected');
      auth = ev.auth || { required: false };
      authorized = !auth.required;
      overlay('Membuat koneksi…', auth.required ? 'Menyiapkan koneksi terenkripsi untuk verifikasi kata sandi.' : 'Permintaan diterima, menyiapkan koneksi aman.');
      setupPeer(ev.rtc);
      break;
    case 'signal':
      await onSignal(ev.data || {});
      break;
    case 'ended':
      fail(ev.reason);
      break;
  }
});

let hasRelay = false; // the server issued TURN credentials for this session
function setupPeer(rtc) {
  hasRelay = !!rtc?.iceServers?.some((s) => s.username);
  pc = new RTCPeerConnection(rtc || { iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => { if (e.candidate) __iceOut++, nusa.signal(sessionId, { ice: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    if (ch.label === 'ctl') {
      ctl = ch;
      ch.onmessage = (m) => onHostMessage(m.data);
      ch.onclose = () => fail(authorized ? 'peer-ended' : 'bad-password');
      ch.onopen = () => onControlOpen();
    } else if (ch.label === 'move') {
      move = ch;
    } else if (ch.label.startsWith('file:')) {
      // Files the host pushes to us: the user accepts each one (Terima/Tolak).
      NusaTransfer.receive(ch, () => (!authorized ? 'reject' : testEnv.autoAcceptFiles ? 'accept' : 'ask'));
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && authorized) { hideOverlay(); stage.focus(); }
    if (pc.connectionState === 'disconnected') overlay('Koneksi terganggu…', 'Mencoba menyambung kembali.');
    if (pc.connectionState === 'failed') fail(hasRelay ? 'failed-relay' : 'failed');
  };
}

async function onSignal(d) {
  if (!pc) return;
  try {
    if (d.sdp) {
      await pc.setRemoteDescription(d.sdp);
      for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (d.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        nusa.signal(sessionId, { sdp: pc.localDescription.toJSON() });
      }
    } else if (d.ice) { __iceIn++;
      if (pc.remoteDescription) await pc.addIceCandidate(d.ice).catch(() => {});
      else pendingIce.push(d.ice);
    }
  } catch (e) { console.error('signal error', e); }
}

// ---------- host -> viewer messages ----------
// ---------- authentication & verification code ----------
async function onControlOpen() {
  const hostFp = NusaSecure.fingerprint(pc.remoteDescription?.sdp);
  const viewerFp = NusaSecure.fingerprint(pc.localDescription?.sdp);
  if (auth?.required) {
    overlay('Memverifikasi kata sandi…', 'Kata sandi diperiksa langsung oleh komputer tujuan lewat koneksi terenkripsi, tidak lewat server.');
    const pw = await nusa.viewerPassword();
    const proof = await NusaSecure.proof(pw, auth, hostFp, viewerFp);
    sendCtl({ t: 'auth', proof });
    setTimeout(() => { if (!authorized) fail('auth-timeout'); }, 20000);
  } else {
    onAuthorized();
  }
  showSas(await NusaSecure.sas(hostFp, viewerFp));
}
function onAuthorized() {
  authorized = true;
  if (pc.connectionState === 'connected') { hideOverlay(); stage.focus(); }
  maybeTestSend();
}
function showSas(code) {
  $('sas').textContent = `Kode verifikasi ${code}`;
  $('sas').title = 'Kode ini harus sama dengan yang tampil di komputer tujuan. Jika berbeda, koneksi disadap: putuskan segera.';
}

let lastClip = null;
function onHostMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'auth-ok') { onAuthorized(); return; }
  if (m.t === 'auth-fail') { fail('bad-password'); return; }
  if (m.t === 'hello') {
    const os = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[m.platform] || m.platform;
    $('peerInfo').textContent = `${m.name || ''} · ${os}`;
    document.title = `NusaDesk — ${m.name || fmt(target)}`;
    const sel = $('displaySel');
    sel.innerHTML = '';
    for (const d of m.displays) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.label;
      sel.appendChild(o);
    }
    sel.value = m.current;
    sel.classList.toggle('hidden', m.displays.length < 2);
    $('qualitySel').value = m.quality || 'balanced';
  } else if (m.t === 'clip' && typeof m.s === 'string' && clipSync) {
    lastClip = m.s;
    nusa.clipboardWrite(m.s);
  } else if (m.t === 'display-changed') {
    $('displaySel').value = m.id;
  }
}

const sendCtl = (o) => { if (ctl && ctl.readyState === 'open') ctl.send(JSON.stringify(o)); };
const sendMove = (o) => {
  const ch = move && move.readyState === 'open' ? move : ctl;
  if (ch && ch.readyState === 'open') ch.send(JSON.stringify(o));
};

// ---------- toolbar ----------
$('displaySel').onchange = (e) => sendCtl({ t: 'display', id: e.target.value });
$('qualitySel').onchange = (e) => { sendCtl({ t: 'quality', mode: e.target.value }); stage.focus(); };
$('scaleBtn').onclick = () => {
  scaleMode = scaleMode === 'fit' ? 'actual' : 'fit';
  stage.classList.toggle('actual', scaleMode === 'actual');
  $('scaleBtn').textContent = scaleMode === 'fit' ? 'Sesuaikan' : 'Ukuran asli';
  applyActualSize();
  stage.focus();
};
function applyActualSize() {
  if (scaleMode === 'actual' && video.videoWidth) {
    video.style.width = video.videoWidth / devicePixelRatio + 'px';
    video.style.height = video.videoHeight / devicePixelRatio + 'px';
  } else {
    video.style.width = ''; video.style.height = '';
  }
}
video.addEventListener('resize', applyActualSize);
$('viewOnlyBtn').onclick = () => {
  viewOnly = !viewOnly;
  $('viewOnlyBtn').classList.toggle('on', viewOnly);
  if (viewOnly) sendCtl({ t: 'release-all' });
  stage.focus();
};
$('clipBtn').onclick = async () => {
  const t = await nusa.clipboardRead();
  if (t) { lastClip = t; sendCtl({ t: 'clip', s: t, manual: true }); }
  $('clipBtn').textContent = 'Terkirim ✓';
  setTimeout(() => ($('clipBtn').textContent = 'Kirim clipboard'), 1200);
  stage.focus();
};
$('fsBtn').onclick = () => { nusa.viewerFullscreen(); stage.focus(); };
$('endBtn').onclick = () => nusa.viewerClose();

// Automatic clipboard sync (opt-in): our clipboard goes over when this window regains
// focus, and the remote clipboard comes back whenever it changes.
$('clipSyncBtn').onclick = async () => {
  clipSync = !clipSync;
  $('clipSyncBtn').classList.toggle('on', clipSync);
  $('clipSyncBtn').textContent = clipSync ? 'Sinkron clipboard: aktif' : 'Sinkron clipboard: mati';
  sendCtl({ t: 'clip-sync', on: clipSync });
  if (clipSync) {
    const t = await nusa.clipboardRead();
    if (t && t.length <= 1_000_000) { lastClip = t; sendCtl({ t: 'clip', s: t }); }
  }
  stage.focus();
};
window.addEventListener('focus', async () => {
  if (!clipSync) return;
  const t = await nusa.clipboardRead();
  if (t && t !== lastClip && t.length <= 1_000_000) { lastClip = t; sendCtl({ t: 'clip', s: t }); }
});

// ---------- mouse ----------
function norm(e) {
  const r = video.getBoundingClientRect();
  const iw = video.videoWidth, ih = video.videoHeight;
  if (!iw || !ih) return null;
  let ox = 0, oy = 0, w = r.width, h = r.height;
  if (scaleMode === 'fit') {
    const s = Math.min(r.width / iw, r.height / ih);
    w = iw * s; h = ih * s;
    ox = (r.width - w) / 2; oy = (r.height - h) / 2;
  }
  const x = (e.clientX - r.left - ox) / w;
  const y = (e.clientY - r.top - oy) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: +x.toFixed(5), y: +y.toFixed(5) };
}

let pendingMove = null;
let moveScheduled = false;
video.addEventListener('mousemove', (e) => {
  if (viewOnly) return;
  const p = norm(e);
  if (!p) return;
  pendingMove = p;
  if (!moveScheduled) {
    moveScheduled = true;
    requestAnimationFrame(() => {
      moveScheduled = false;
      if (pendingMove) sendMove({ t: 'mm', ...pendingMove });
      pendingMove = null;
    });
  }
});
video.addEventListener('mousedown', (e) => {
  stage.focus();
  if (viewOnly) return;
  const p = norm(e); if (!p) return;
  e.preventDefault();
  sendCtl({ t: 'md', b: e.button, ...p });
});
window.addEventListener('mouseup', (e) => {
  if (viewOnly) return;
  const p = norm(e) || { x: 0, y: 0, ...(pendingMove || {}) };
  sendCtl({ t: 'mu', b: e.button, ...p });
});
video.addEventListener('contextmenu', (e) => e.preventDefault());

let wheelAcc = { dx: 0, dy: 0 };
let wheelScheduled = false;
video.addEventListener('wheel', (e) => {
  if (viewOnly) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1;
  wheelAcc.dx += e.deltaX * k;
  wheelAcc.dy += e.deltaY * k;
  if (!wheelScheduled) {
    wheelScheduled = true;
    requestAnimationFrame(() => {
      wheelScheduled = false;
      sendCtl({ t: 'wh', dx: wheelAcc.dx, dy: wheelAcc.dy });
      wheelAcc = { dx: 0, dy: 0 };
    });
  }
}, { passive: false });

// ---------- keyboard ----------
function isToolbarTarget(e) { return e.target.closest && e.target.closest('.bar'); }
window.addEventListener('keydown', (e) => {
  if (viewOnly || isToolbarTarget(e) || !ctl) return;
  e.preventDefault();
  sendCtl({ t: 'kd', code: e.code, key: e.key, mod: e.ctrlKey || e.metaKey || e.altKey });
}, true);
window.addEventListener('keyup', (e) => {
  if (viewOnly || isToolbarTarget(e) || !ctl) return;
  e.preventDefault();
  sendCtl({ t: 'ku', code: e.code, key: e.key });
}, true);
// Never leave keys/buttons stuck on the remote side when we lose focus.
window.addEventListener('blur', () => sendCtl({ t: 'release-all' }));

// ---------- stats ----------
let lastBytes = 0, lastTs = 0;
setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected' || !authorized) return;
  const stats = await pc.getStats();
  let fps = 0, bytes = 0, ts = 0, rtt = null, w = 0, h = 0, pair = null, codec = '';
  const byId = new Map();
  stats.forEach((s) => byId.set(s.id, s));
  stats.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      fps = s.framesPerSecond || 0; bytes = s.bytesReceived; ts = s.timestamp;
      w = s.frameWidth || 0; h = s.frameHeight || 0;
      const c = byId.get(s.codecId); if (c) codec = c.mimeType.split('/')[1];
    }
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  if (pair) rtt = pair.currentRoundTripTime;
  const mbps = lastTs ? ((bytes - lastBytes) * 8) / ((ts - lastTs) / 1000) / 1e6 : 0;
  lastBytes = bytes; lastTs = ts;
  // "relay" when either side goes through a TURN server. In relay-only mode the local side
  // may show up as peer-reflexive (the relay's address as the peer saw it).
  const relayed = pc.getConfiguration().iceTransportPolicy === 'relay'
    || [pair?.localCandidateId, pair?.remoteCandidateId].some((id) => byId.get(id)?.candidateType === 'relay');
  const route = relayed ? 'relay' : 'P2P';
  $('stats').textContent = `${w}×${h} · ${Math.round(fps)} fps · ${mbps.toFixed(1)} Mbps · ${rtt != null ? Math.round(rtt * 1000) + ' ms' : '–'} · ${codec} · ${route}`;
}, 1000);

// ---------- file transfer ----------
NusaTransferUI.mount($('xferPanel'), { title: 'Transfer file' });

function sendFiles(files) {
  if (!pc || pc.connectionState !== 'connected') return;
  for (const f of files) {
    if (f.size === 0 && !f.type && !/\.[^.]+$/.test(f.name)) continue; // skip folders dropped by mistake
    NusaTransfer.sendFile(pc, f);
  }
}
$('fileBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { sendFiles([...e.target.files]); e.target.value = ''; stage.focus(); };

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1 && pc?.connectionState === 'connected') $('dropZone').classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('dropZone').classList.add('hidden'); }
});
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', (e) => {
  e.preventDefault(); // never let Electron navigate to a dropped file
  dragDepth = 0;
  $('dropZone').classList.add('hidden');
  sendFiles([...(e.dataTransfer?.files || [])]);
});

let testSent = false;
async function maybeTestSend() {
  if (testSent) return;
  const env = await nusa.testEnv();
  if (!env.sendBytes) return;
  testSent = true;
  setTimeout(() => NusaTransfer.sendFile(pc, NusaTransfer.testFile(env.sendBytes, 'viewer-to-host.bin')), 500);
}

function cleanup() {
  NusaTransfer.cancelAll();
  try { sendCtl({ t: 'release-all' }); } catch {}
  try { pc?.close(); } catch {}
  video.srcObject = null;
}
window.addEventListener('beforeunload', cleanup);

// Test hook (used by the automated end-to-end test).

window.__nusaTest = () => ({
  connected: pc?.connectionState, ice: pc?.iceConnectionState, gather: pc?.iceGatheringState, iceOut: __iceOut, iceIn: __iceIn, sig: pc?.signalingState, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
  overlay: $('ovTitle').textContent + ' / ' + $('ovText').textContent, ctl: ctl?.readyState, move: move?.readyState, peer: $('peerInfo').textContent, stats: $('stats').textContent,
  transfers: NusaTransfer.list().map(({ channel, decide, ...t }) => t),
  authorized, sas: $('sas').textContent, ended,
  policy: pc?.getConfiguration().iceTransportPolicy, relayServers: (pc?.getConfiguration().iceServers || []).filter((x) => x.username).length,
});
