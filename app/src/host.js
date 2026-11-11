// Host side: shares this computer's screen to an approved viewer over WebRTC
// and forwards the viewer's input events to the main process for injection.
'use strict';

// Fallback only: the main process passes the real config (STUN + per-session TURN relay).
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const NusaHost = {
  sessions: new Map(), // sessionId -> session
  onChange: () => {},
};

let fakeMode = false;
nusa.isFake().then((v) => { fakeMode = v; });

function fakeScreenStream() {
  // Test mode: an animated canvas stands in for the real screen.
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  let f = 0;
  setInterval(() => {
    f++;
    g.fillStyle = '#1b1f2a'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e5484d'; g.fillRect((f * 6) % c.width, 300, 120, 120);
    g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(`NusaDesk test frame ${f}`, 60, 120);
  }, 33);
  return c.captureStream(30);
}

async function captureScreen(displayId) {
  if (fakeMode) return fakeScreenStream();
  const src = await nusa.screenSource(displayId);
  if (!src) throw new Error('Tidak ada layar yang bisa ditangkap (cek izin Screen Recording)');
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: src.sourceId,
        maxWidth: src.width, maxHeight: src.height,
        minFrameRate: 5, maxFrameRate: 30,
      },
    },
  });
}

function tuneSender(sender, quality) {
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  const e = p.encodings[0];
  if (quality === 'speed') {
    e.maxBitrate = 2_500_000; e.maxFramerate = 30; e.scaleResolutionDownBy = 1.5;
    p.degradationPreference = 'maintain-framerate';
  } else if (quality === 'balanced') {
    e.maxBitrate = 5_000_000; e.maxFramerate = 30; e.scaleResolutionDownBy = 1;
    p.degradationPreference = 'balanced';
  } else { // 'quality'
    e.maxBitrate = 10_000_000; e.maxFramerate = 30; e.scaleResolutionDownBy = 1;
    p.degradationPreference = 'maintain-resolution';
  }
  sender.setParameters(p).catch((err) => console.warn('setParameters', err));
}

async function startHostSession({ sessionId, from, name, viaPassword, needsAuth, rtc }) {
  const s = {
    sessionId, from, name, viaPassword, pc: null, stream: null, sender: null,
    ctl: null, move: null, quality: 'balanced', displayId: null, pendingIce: [], state: 'menghubungkan',
    // Password sessions start locked: nothing is shared until the proof verifies.
    authorized: !needsAuth, clipSync: false, sas: null,
  };
  NusaHost.sessions.set(sessionId, s);
  changed();

  const pc = new RTCPeerConnection(rtc || { iceServers: ICE_SERVERS });
  s.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) nusa.signal(sessionId, { ice: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    s.state = { connected: 'terhubung', connecting: 'menghubungkan', disconnected: 'terputus sementara', failed: 'gagal' }[pc.connectionState] || pc.connectionState;
    changed();
    if (pc.connectionState === 'failed') endHostSession(sessionId, true);
  };

  // Video slot without a track: the screen is attached only after authorization.
  const tx = pc.addTransceiver('video', { direction: 'sendonly' });
  s.sender = tx.sender;
  // Prefer H.264 when available (hardware encoders on both macOS and Windows), fall back to VP8/VP9.
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    if (caps && tx.setCodecPreferences) {
      const rank = (c) => (/h264/i.test(c.mimeType) ? 0 : /vp9/i.test(c.mimeType) ? 1 : /vp8/i.test(c.mimeType) ? 2 : 3);
      tx.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
    }
  } catch (e) { console.warn('codec prefs', e); }

  // Files the viewer sends to this computer (only after authorization, if allowed).
  pc.ondatachannel = (e) => {
    if (e.channel.label.startsWith('file:')) NusaTransfer.receive(e.channel, () => (s.authorized && allowFiles ? 'accept' : 'reject'));
    else e.channel.close();
  };
  nusa.allowFileTransfer().then((v) => { allowFiles = v; });

  s.ctl = pc.createDataChannel('ctl', { ordered: true });
  s.move = pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
  s.ctl.onopen = () => {
    if (s.authorized) onAuthorized(s);
    else s.authTimer = setTimeout(() => { if (!s.authorized) endHostSession(sessionId, true); }, 20000);
  };
  s.ctl.onmessage = (e) => onViewerMessage(s, e.data);
  s.move.onmessage = (e) => onViewerMessage(s, e.data);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  nusa.signal(sessionId, { sdp: pc.localDescription.toJSON() });
}

const fingerprints = (s) => ({
  hostFp: NusaSecure.fingerprint(s.pc.localDescription?.sdp),
  viewerFp: NusaSecure.fingerprint(s.pc.remoteDescription?.sdp),
});

async function checkAuth(s, proof) {
  if (s.authorized || s.authChecked) return;
  s.authChecked = true; // one attempt per session
  clearTimeout(s.authTimer);
  const { hostFp, viewerFp } = fingerprints(s);
  const ok = hostFp && viewerFp && (await nusa.verifyProof(s.sessionId, hostFp, viewerFp, proof));
  if (!ok) {
    try { s.ctl.send(JSON.stringify({ t: 'auth-fail' })); } catch {}
    setTimeout(() => endHostSession(s.sessionId, false), 300); // main already told the server
    return;
  }
  s.authorized = true;
  s.ctl.send(JSON.stringify({ t: 'auth-ok' }));
  onAuthorized(s);
}

// Everything a viewer may use starts here: screen, display list, input, clipboard, files.
async function onAuthorized(s) {
  const { hostFp, viewerFp } = fingerprints(s);
  s.sas = await NusaSecure.sas(hostFp, viewerFp);
  changed();
  try {
    const displays = await nusa.listDisplays();
    s.displayId = (displays.find((d) => d.primary) || displays[0] || {}).id || null;
    await nusa.selectDisplay(s.displayId);
    s.stream = await captureScreen(s.displayId);
    const track = s.stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    await s.sender.replaceTrack(track);
    tuneSender(s.sender, s.quality);
    const cfg = await nusa.getConfig();
    s.ctl.send(JSON.stringify({ t: 'hello', displays, current: s.displayId, platform: cfg.platform, name: cfg.name, quality: s.quality }));
  } catch (e) {
    console.error('capture failed', e);
    s.state = 'gagal menangkap layar: ' + e.message;
    changed();
    endHostSession(s.sessionId, true);
    return;
  }
  const env = await nusa.testEnv();
  if (env.sendBytes) setTimeout(() => sendFileToViewer(s.sessionId, NusaTransfer.testFile(env.sendBytes, 'host-to-viewer.bin')), 500);
}

async function onViewerMessage(s, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!s.authorized) { // locked session: the password proof is the only accepted message
    if (m.t === 'auth' && typeof m.proof === 'string') checkAuth(s, m.proof);
    return;
  }
  switch (m.t) {
    case 'auth': break;
    case 'clip-sync':
      s.clipSync = !!m.on;
      if (s.clipSync) { lastClip = await nusa.clipboardRead(); ensureClipboardWatch(); }
      break;
    case 'clip': // automatic sync only when the viewer turned it on; "Kirim clipboard" is explicit
      if (typeof m.s === 'string' && (s.clipSync || m.manual)) { lastClip = m.s; await nusa.clipboardWrite(m.s); }
      break;
    case 'display':
      await switchDisplay(s, m.id);
      break;
    case 'quality':
      if (['quality', 'balanced', 'speed'].includes(m.mode)) {
        s.quality = m.mode;
        if (s.sender) tuneSender(s.sender, s.quality);
        const track = s.sender?.track;
        if (track) track.contentHint = m.mode === 'speed' ? 'motion' : 'detail';
      }
      break;
    default:
      nusa.inject(m); // mouse/keyboard events
  }
}

async function switchDisplay(s, id) {
  try {
    await nusa.selectDisplay(id);
    const stream = await captureScreen(id);
    const track = stream.getVideoTracks()[0];
    track.contentHint = s.quality === 'speed' ? 'motion' : 'detail';
    await s.sender.replaceTrack(track);
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = stream;
    s.displayId = id;
    s.ctl?.readyState === 'open' && s.ctl.send(JSON.stringify({ t: 'display-changed', id }));
  } catch (e) {
    console.error('switch display failed', e);
  }
}

async function handleHostSignal(msg) {
  const s = NusaHost.sessions.get(msg.sessionId);
  if (!s || !s.pc) return;
  const d = msg.data || {};
  try {
    if (d.sdp) {
      await s.pc.setRemoteDescription(d.sdp);
      for (const c of s.pendingIce.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
    } else if (d.ice) {
      if (s.pc.remoteDescription) await s.pc.addIceCandidate(d.ice).catch(() => {});
      else s.pendingIce.push(d.ice);
    }
  } catch (e) { console.error('host signal error', e); }
}

function endHostSession(sessionId, notifyServer) {
  const s = NusaHost.sessions.get(sessionId);
  if (!s) return;
  NusaHost.sessions.delete(sessionId);
  clearTimeout(s.authTimer);
  try { s.pc?.close(); } catch {}
  s.stream?.getTracks().forEach((t) => t.stop());
  nusa.inject({ t: 'release-all' });
  if (notifyServer) nusa.hostEnd(sessionId);
  changed();
}

let allowFiles = true;
function setAllowFiles(v) { allowFiles = !!v; }
function sendFileToViewer(sessionId, file) {
  const s = NusaHost.sessions.get(sessionId);
  if (s?.authorized && s.pc && !['closed', 'failed'].includes(s.pc.connectionState)) NusaTransfer.sendFile(s.pc, file);
}

// Push this computer's clipboard to viewers that turned clipboard sync on.
let lastClip = null;
let clipTimer = null;
function ensureClipboardWatch() {
  if (clipTimer) return;
  clipTimer = setInterval(async () => {
    const syncing = [...NusaHost.sessions.values()].filter((s) => s.authorized && s.clipSync);
    if (!syncing.length) { clearInterval(clipTimer); clipTimer = null; return; }
    const c = await nusa.clipboardRead();
    if (c === lastClip) return;
    lastClip = c;
    if (!c || c.length > 1_000_000) return;
    for (const s of syncing) {
      if (s.ctl?.readyState === 'open') s.ctl.send(JSON.stringify({ t: 'clip', s: c }));
    }
  }, 1000);
}

nusa.onHostStart((m) => startHostSession(m));
nusa.onHostSignal((m) => handleHostSignal(m));
nusa.onHostEnded((m) => endHostSession(m.sessionId, false));
nusa.onHostEndRequest((id) => endHostSession(id, true)); // "Putuskan" on the indicator bar

// Keep the always-on-top indicator in sync with the authorized sessions.
function changed() { NusaHost.onChange(); reportSessions(); }
function reportSessions() {
  nusa.reportHostSessions([...NusaHost.sessions.values()].filter((s) => s.authorized)
    .map((s) => ({ sessionId: s.sessionId, name: s.name || '', from: s.from, sas: s.sas || '', viaPassword: !!s.viaPassword })));
}

window.NusaHost = NusaHost;
window.endHostSession = endHostSession;
window.sendFileToViewer = sendFileToViewer;
window.setAllowFiles = setAllowFiles;
