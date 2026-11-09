// End-to-end test: signaling server + two NusaDesk instances (host in fake-screen mode).
// The viewer auto-connects with the host's unattended password and reports whether
// WebRTC connected, video frames arrived and data channels opened.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18787;
const SERVER = `ws://localhost:${PORT}`;
const electron = require('electron'); // path to the binary when required from Node
const appDir = path.join(__dirname, '..');
const appData = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? process.env.APPDATA : path.join(os.homedir(), '.config');

const profiles = ['e2eHost', 'e2eViewer', 'e2eViewer2'].map((p) => path.join(appData, `NusaDesk-${p}`));
profiles.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
fs.mkdirSync(profiles[0], { recursive: true });
fs.writeFileSync(path.join(profiles[0], 'config.json'), JSON.stringify({
  id: '111111111', deviceKey: 'e2e-host-device-key-0000000000', server: SERVER,
  unattendedPassword: 'testpass', name: 'E2E Host',
}));

// File-transfer check: each side pushes a deterministic file to the other.
const dl = { host: fs.mkdtempSync(path.join(os.tmpdir(), 'nusa-dl-host-')), viewer: fs.mkdtempSync(path.join(os.tmpdir(), 'nusa-dl-viewer-')) };
const SIZE_V2H = 5 * 1024 * 1024 + 123; // viewer -> host
const SIZE_H2V = 3 * 1024 * 1024 + 7;   // host -> viewer
function checkFile(dir, name, size) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return `${name} tidak ada (isi folder: ${fs.readdirSync(dir).join(', ')})`;
  const b = fs.readFileSync(p);
  if (b.length !== size) return `${name} ukuran ${b.length} != ${size}`;
  for (let i = 0; i < size; i++) if (b[i] !== (i * 7 + 3) % 251) return `${name} isi berbeda di byte ${i}`;
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.nusapart'));
  if (leftovers.length) return `sisa file parsial: ${leftovers}`;
  return null;
}

const procs = [];
function run(cmd, args, env, tag) {
  const p = spawn(cmd, args, { cwd: appDir, env: { ...process.env, ...env } });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += d; process.stdout.write(`[${tag}] ${d}`); });
  p.stderr.on('data', (d) => { const s = String(d); if (!/Fontconfig|GPU|Gtk|stun_port|rtc_data_channel|ERROR:third_party/.test(s)) process.stderr.write(`[${tag}] ${s}`); });
  p.out = () => out;
  return p;
}
const done = (code) => {
  procs.forEach((p) => { try { p.kill(); } catch {} });
  [...profiles, dl.host, dl.viewer].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  process.exit(code);
};

const dbFile = path.join(os.tmpdir(), `nusadesk-e2e-${process.pid}.json`);
let failures = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' ' + extra : ''}`); if (!ok) failures++; };

function runViewer(profile, autoconnect, env = {}) {
  return new Promise((resolve) => {
    const viewer = run(electron, ['.'], {
      NUSADESK_PROFILE: profile, NUSADESK_SERVER: SERVER, NUSADESK_FAKE_SCREEN: '1',
      NUSADESK_AUTOCONNECT: autoconnect, NUSADESK_TEST_REPORT_MS: '14000', ...env,
    }, profile);
    viewer.on('exit', () => {
      const m = /NUSADESK_TEST_REPORT (.*)/.exec(viewer.out());
      resolve(m ? JSON.parse(m[1])[0] : null);
    });
  });
}

run(process.execPath, [path.join(appDir, '..', 'server', 'index.js')], { PORT: String(PORT), NUSADESK_DB: dbFile }, 'server');
setTimeout(() => {
  const host = run(electron, ['.'], { NUSADESK_PROFILE: 'e2eHost', NUSADESK_FAKE_SCREEN: '1', NUSADESK_DOWNLOAD_DIR: dl.host, NUSADESK_TEST_SEND_BYTES: String(SIZE_H2V), NUSADESK_TEST_HOST_SNAPSHOT_MS: '15000' }, 'host');
  setTimeout(async () => {
    // 1) correct unattended password
    const r = await runViewer('e2eViewer', '111111111:testpass', { NUSADESK_DOWNLOAD_DIR: dl.viewer, NUSADESK_TEST_SEND_BYTES: String(SIZE_V2H) });
    if (!r) { console.error('FAIL: no report'); return done(1); }
    const transfers = r.transfers || [];
    delete r.transfers;
    check(r.connected === 'connected' && r.videoWidth > 0 && r.ctl === 'open' && r.move === 'open' && r.authorized === true,
      'koneksi dengan kata sandi benar', JSON.stringify({ authorized: r.authorized, video: `${r.videoWidth}x${r.videoHeight}`, sas: r.sas, stats: r.stats }));
    check(/^Kode verifikasi \d{3} \d{3}$/.test(r.sas || ''), 'kode verifikasi tampil di viewer', r.sas);
    const hs = /NUSADESK_HOST_SNAPSHOT (.*)/.exec(host.out());
    const snap = hs ? JSON.parse(hs[1]) : {};
    check(!!snap.codes && snap.codes.length === 1 && r.sas === `Kode verifikasi ${snap.codes[0]}`, 'kode verifikasi host = viewer', JSON.stringify(snap));
    check(snap.indicator === true, 'bar indikator tampil di host selama sesi');
    console.log('transfers', JSON.stringify(transfers.map((t) => ({ dir: t.dir, name: t.name, state: t.state, bytes: t.bytes, error: t.error }))));
    const e1 = checkFile(dl.host, 'viewer-to-host.bin', SIZE_V2H);
    const e2 = checkFile(dl.viewer, 'host-to-viewer.bin', SIZE_H2V);
    check(!e1, 'file viewer->host isi cocok', e1 || '');
    check(!e2, 'file host->viewer isi cocok', e2 || '');
    if (process.platform === 'darwin') {
      const q = require('child_process').spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path.join(dl.host, 'viewer-to-host.bin')]).stdout.toString().trim();
      check(/^0081;[0-9a-f]+;NusaDesk;$/.test(q), 'file diterima diberi tanda quarantine', q);
    }
    const hostCfg = JSON.parse(fs.readFileSync(path.join(profiles[0], 'config.json'), 'utf8'));
    check(!('unattendedPassword' in hostCfg) && !!(hostCfg.unattendedKeyEnc || hostCfg.unattendedKey) && !JSON.stringify(hostCfg).includes('testpass'),
      'kata sandi unattended tidak tersimpan sebagai teks', Object.keys(hostCfg).join(','));

    // 2) wrong password: nothing may be shared
    const w = await runViewer('e2eViewer2', '111111111:wrongpass1');
    check(!!w && w.authorized === false && w.videoWidth === 0 && w.ended === true && /Kata sandi salah/.test(w.overlay || ''),
      'kata sandi salah ditolak tanpa membagikan layar', JSON.stringify(w && { authorized: w.authorized, video: w.videoWidth, overlay: w.overlay }));

    fs.rmSync(dbFile, { force: true });
    done(failures ? 1 : 0);
  }, 2500);
}, 800);
setTimeout(() => { console.error('FAIL: timeout'); done(1); }, 80000);
