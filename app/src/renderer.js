// Main window UI
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (id) => String(id).replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
let cfg = null;

const STATUS_TEXT = {
  unconfigured: 'Server sinyal belum diatur',
  online: 'Siap — terhubung ke server',
  connecting: 'Menghubungkan ke server…',
  offline: 'Tidak terhubung ke server',
};

function renderConfig(c) {
  cfg = c;
  $('myId').textContent = c.idFormatted;
  $('myPw').value = c.sessionPassword;
  $('versionText').textContent = `NusaDesk v${c.version} · ${c.platform}${c.robot ? '' : ' · kontrol input tidak tersedia'}${c.fake ? ' · MODE UJI' : ''}`;
}

function renderStatus({ state, detail }) {
  $('serverSetup').classList.toggle('hidden', state !== 'unconfigured');
  $('dot').className = 'dot ' + state;
  $('statusText').textContent = (STATUS_TEXT[state] || state) + (detail ? ` (${detail})` : '');
}

async function init() {
  renderConfig(await nusa.getConfig());
  renderStatus(await nusa.getStatus());
  renderRecent();
  checkPermissions();
  setInterval(checkPermissions, 5000);
}

nusa.onStatus(renderStatus);
nusa.onConfig(renderConfig);

// ---- copy / refresh password ----
$('copyBtn').onclick = async () => {
  await nusa.clipboardWrite(`ID NusaDesk: ${cfg.idFormatted}\nKata sandi: ${cfg.sessionPassword}`);
  $('copyBtn').textContent = 'Tersalin ✓';
  setTimeout(() => ($('copyBtn').textContent = 'Salin'), 1500);
};
$('refreshPw').onclick = async () => renderConfig(await nusa.newSessionPassword());

// ---- connect ----
$('targetId').addEventListener('input', (e) => {
  const caret = e.target.value.length;
  e.target.value = fmt(e.target.value).slice(0, 11);
});
$('targetId').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('targetPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('connectBtn').onclick = () => connect();

async function connect(idOverride) {
  const id = (idOverride || $('targetId').value).replace(/\D/g, '');
  $('connectErr').textContent = '';
  const r = await nusa.connectTo(id, $('targetPw').value);
  if (!r.ok) { $('connectErr').textContent = r.error; return; }
  $('targetPw').value = '';
  addRecent(id);
}

function getRecent() { try { return JSON.parse(localStorage.getItem('recent') || '[]'); } catch { return []; } }
function addRecent(id) {
  const list = [id, ...getRecent().filter((x) => x !== id)].slice(0, 6);
  try { localStorage.setItem('recent', JSON.stringify(list)); } catch {}
  renderRecent();
}
function renderRecent() {
  const box = $('recent');
  box.innerHTML = '';
  for (const id of getRecent()) {
    const b = document.createElement('button');
    b.className = 'mono';
    b.textContent = fmt(id);
    b.title = 'Hubungkan lagi';
    b.onclick = () => { $('targetId').value = fmt(id); connect(id); };
    box.appendChild(b);
  }
}

// ---- incoming requests (one at a time, queued) ----
const incomingQueue = [];
let currentIncoming = null;
nusa.onIncomingRequest((req) => { incomingQueue.push(req); showNextIncoming(); });
function showNextIncoming() {
  if (currentIncoming || !incomingQueue.length) return;
  currentIncoming = incomingQueue.shift();
  $('inName').textContent = currentIncoming.name || 'Seseorang';
  $('inId').textContent = `(${fmt(currentIncoming.from)})`;
  $('incomingModal').classList.remove('hidden');
  $('acceptBtn').focus();
}
function decide(accept) {
  if (!currentIncoming) return;
  nusa.incomingDecision({ ...currentIncoming, accept });
  currentIncoming = null;
  $('incomingModal').classList.add('hidden');
  showNextIncoming();
}
$('acceptBtn').onclick = () => decide(true);
$('rejectBtn').onclick = () => decide(false);

// ---- active host sessions ----
NusaHost.onChange = () => {
  const list = [...NusaHost.sessions.values()];
  $('sessionsCard').classList.toggle('hidden', !list.length);
  const box = $('sessions');
  box.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 's';
    const dot = document.createElement('span');
    dot.className = 'dot ' + (s.state === 'terhubung' ? 'online' : 'connecting');
    const txt = document.createElement('div');
    txt.style.flex = '1';
    txt.innerHTML = `<b></b> <span class="muted mono small"></span><div class="muted small"></div>`;
    txt.querySelector('b').textContent = s.name || 'Viewer';
    txt.querySelectorAll('span')[0].textContent = fmt(s.from);
    txt.querySelector('div').textContent = !s.authorized
      ? 'memverifikasi kata sandi…'
      : `${s.state}${s.viaPassword ? ' · via kata sandi' : ''} · sedang mengontrol komputer ini${s.sas ? ` · kode verifikasi ${s.sas}` : ''}`;
    if (!s.authorized) row.style.opacity = '0.6';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const fileBtn = document.createElement('button');
    fileBtn.textContent = 'Kirim file';
    fileBtn.title = 'Kirim file dari komputer ini ke orang yang terhubung';
    fileBtn.disabled = s.state !== 'terhubung' || !s.authorized;
    fileBtn.onclick = () => { fileTargetSession = s.sessionId; $('hostFileInput').click(); };
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = 'Putuskan';
    btn.onclick = () => endHostSession(s.sessionId, true);
    actions.append(fileBtn, btn);
    row.append(dot, txt, actions);
    box.appendChild(row);
  }
};

// ---- file transfer ----
let fileTargetSession = null;
$('hostFileInput').onchange = (e) => {
  for (const f of e.target.files) sendFileToViewer(fileTargetSession, f);
  e.target.value = '';
};
NusaTransferUI.mount($('hostXfer'), { title: 'Transfer file' });
// Dropping a file on the main window must never navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---- first run: no signaling server configured yet ----
$('setupSave').onclick = async () => {
  const v = $('setupServer').value.trim();
  if (!/^wss?:\/\/\S+$/.test(v)) { $('setupErr').textContent = 'Alamat harus diawali ws:// atau wss://'; return; }
  $('setupErr').textContent = '';
  renderConfig(await nusa.setSettings({ server: v }));
};
$('setupServer').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('setupSave').click(); });

// ---- settings ----
$('settingsBtn').onclick = () => {
  $('setName').value = cfg.name;
  $('setServer').value = cfg.server;
  $('setUnattended').value = '';
  $('setUnattended').placeholder = cfg.hasUnattended ? 'Sudah diatur — isi untuk mengganti' : 'Kosong = nonaktif';
  $('setAllowFiles').checked = cfg.allowFileTransfer;
  $('clearUnattended').classList.toggle('hidden', !cfg.hasUnattended);
  $('settingsErr').textContent = '';
  $('downloadDirText').textContent = `File yang diterima disimpan di: ${cfg.downloadDir}`;
  $('settingsModal').classList.remove('hidden');
};
$('settingsCancel').onclick = () => $('settingsModal').classList.add('hidden');
$('clearUnattended').onclick = async () => {
  renderConfig(await nusa.setSettings({ clearUnattended: true }));
  $('clearUnattended').classList.add('hidden');
  $('setUnattended').placeholder = 'Kosong = nonaktif';
};
$('settingsSave').onclick = async () => {
  const s = { name: $('setName').value, server: $('setServer').value, allowFileTransfer: $('setAllowFiles').checked };
  setAllowFiles(s.allowFileTransfer);
  if ($('setUnattended').value) s.unattendedPassword = $('setUnattended').value;
  const r = await nusa.setSettings(s);
  renderConfig(r);
  if (r.error) { $('settingsErr').textContent = r.error; return; }
  $('settingsModal').classList.add('hidden');
};

// ---- macOS permissions ----
async function checkPermissions() {
  const p = await nusa.permissions();
  const b = $('permBanner');
  const issues = [];
  if (p.platform === 'darwin') {
    if (p.screen !== 'granted') issues.push(['screen', 'Izin Perekaman Layar (Screen Recording) belum diberikan — orang lain tidak bisa melihat layar ini.']);
    if (!p.accessibility) issues.push(['accessibility', 'Izin Aksesibilitas belum diberikan — orang lain tidak bisa mengontrol mouse/keyboard.']);
  }
  if (!cfg?.robot) issues.push([null, 'Modul kontrol input gagal dimuat.']);
  b.classList.toggle('hidden', !issues.length);
  b.innerHTML = '';
  for (const [kind, text] of issues) {
    const span = document.createElement('div');
    span.style.flex = '1 1 100%';
    span.textContent = '⚠︎ ' + text;
    b.appendChild(span);
    if (kind) {
      const btn = document.createElement('button');
      btn.textContent = 'Buka Pengaturan Sistem';
      btn.onclick = async () => { if (kind === 'accessibility') await nusa.requestAccessibility(); nusa.openPrivacy(kind); };
      b.appendChild(btn);
    }
  }
}

init();
