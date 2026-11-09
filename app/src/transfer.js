// File transfer over WebRTC data channels — shared by host and viewer.
// Each file gets its own reliable channel "file:<id>":
//   sender  -> {t:'start', name, size}
//   receiver-> {t:'go'} once accepted (possibly after asking the user) or {t:'err', msg}
//   sender  -> binary chunks…, {t:'end'}
//   receiver-> {t:'ok', name} once the file is safely on disk (or {t:'err', msg})
// The receiver streams chunks to disk through the main process, so file size is not
// limited by memory.
'use strict';

const NusaTransfer = (() => {
  const CHUNK = 64 * 1024;
  const HIGH_WATER = 8 * 1024 * 1024;
  const transfers = new Map();
  const listeners = new Set();
  let emitTimer = null;

  function emitNow() { emitTimer = null; const list = [...transfers.values()]; listeners.forEach((f) => f(list)); }
  function emit(immediate) {
    if (immediate) { clearTimeout(emitTimer); return emitNow(); }
    if (!emitTimer) emitTimer = setTimeout(emitNow, 150);
  }
  function update(t, patch, immediate) { Object.assign(t, patch); emit(immediate); }

  function waitOpen(ch) {
    if (ch.readyState === 'open') return Promise.resolve();
    return new Promise((res, rej) => {
      ch.addEventListener('open', () => res(), { once: true });
      ch.addEventListener('close', () => rej(new Error('Kanal ditutup')), { once: true });
    });
  }
  function waitDrain(ch) {
    return new Promise((res) => {
      const done = () => { ch.removeEventListener('bufferedamountlow', done); ch.removeEventListener('close', done); res(); };
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', done);
    });
  }

  // ---------- sending ----------
  async function sendFile(pc, file) {
    const id = crypto.randomUUID();
    const t = { id, name: file.name, size: file.size, bytes: 0, dir: 'out', state: 'waiting', started: Date.now(), error: null };
    transfers.set(id, t);
    emit(true);
    let ch;
    try {
      ch = pc.createDataChannel('file:' + id, { ordered: true });
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 1024 * 1024;
      t.channel = ch;
      let goRes;
      const go = new Promise((res) => { goRes = res; });
      const result = new Promise((res, rej) => {
        ch.addEventListener('message', (e) => {
          if (typeof e.data !== 'string') return;
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'go') goRes();
          if (m.t === 'ok') res(m);
          if (m.t === 'err') rej(new Error(m.msg || 'Ditolak penerima'));
        });
        ch.addEventListener('close', () => rej(new Error(t.state === 'cancelled' ? 'Dibatalkan' : 'Koneksi transfer terputus')));
      });
      result.catch(() => {}); // handled below

      await waitOpen(ch);
      ch.send(JSON.stringify({ t: 'start', name: file.name, size: file.size }));
      await Promise.race([go, result]); // wait until the receiver accepts (or refuses)
      update(t, { state: 'active', started: Date.now() });
      for (let off = 0; off < file.size; off += CHUNK) {
        if (t.state !== 'active' || ch.readyState !== 'open') throw new Error(t.state === 'cancelled' ? 'Dibatalkan' : 'Koneksi transfer terputus');
        if (ch.bufferedAmount > HIGH_WATER) await waitDrain(ch);
        const buf = await file.slice(off, off + CHUNK).arrayBuffer();
        if (ch.readyState !== 'open') continue;
        ch.send(buf);
        update(t, { bytes: off + buf.byteLength });
      }
      ch.send(JSON.stringify({ t: 'end' }));
      update(t, { state: 'finishing' }, true);
      const ok = await result;
      update(t, { state: 'done', bytes: file.size, remoteName: ok.name, finished: Date.now() }, true);
      ch.close();
    } catch (e) {
      if (t.state !== 'cancelled') update(t, { state: 'error', error: e.message }, true);
      try { ch?.close(); } catch {}
    }
    return t;
  }

  // ---------- receiving ----------
  // `policy(meta)` decides an incoming file: 'accept', 'reject' or 'ask' (the user
  // chooses with Terima/Tolak in the transfer panel; no answer in 2 minutes = reject).
  function receive(ch, policy) {
    const id = ch.label.slice(5).replace(/[^\w-]/g, '').slice(0, 64);
    ch.binaryType = 'arraybuffer';
    let t = null;
    let chain = Promise.resolve();
    let failed = false;
    let finished = false;

    const fail = (msg) => {
      if (failed || finished) return;
      failed = true;
      if (t) update(t, { state: t.state === 'cancelled' ? 'cancelled' : 'error', error: msg }, true);
      chain = chain.then(() => nusa.fileAbort(id)).catch(() => {});
      try { ch.readyState === 'open' && ch.send(JSON.stringify({ t: 'err', msg })); } catch {}
      setTimeout(() => { try { ch.close(); } catch {} }, 200);
    };

    ch.onmessage = (e) => {
      if (failed || finished) return;
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'start') {
          if (t) return;
          t = { id, name: String(m.name || 'file').slice(0, 255), size: Math.max(0, Number(m.size) || 0), bytes: 0, dir: 'in', state: 'offer', started: Date.now(), channel: ch, error: null };
          const decision = policy({ name: t.name, size: t.size });
          if (decision === 'reject') { failed = true; try { ch.send(JSON.stringify({ t: 'err', msg: 'Transfer file ditolak / dinonaktifkan di komputer tujuan' })); } catch {} setTimeout(() => { try { ch.close(); } catch {} }, 200); t = null; return; }
          transfers.set(id, t);
          emit(true);
          const accept = () => {
            update(t, { state: 'active', started: Date.now() }, true);
            chain = chain.then(async () => {
              const r = await nusa.fileOpen(id, t.name, t.size);
              if (!r.ok) throw new Error(r.error || 'Tidak bisa menyimpan file');
              ch.send(JSON.stringify({ t: 'go' }));
            }).catch((err) => fail(err.message));
          };
          if (decision === 'accept') accept();
          else {
            const timer = setTimeout(() => t.decide?.(false), 120000);
            t.decide = (ok) => {
              clearTimeout(timer);
              t.decide = null;
              if (ok) accept(); else { update(t, { state: 'cancelled', error: 'Ditolak' }, true); fail('Ditolak oleh penerima'); }
            };
          }
        } else if (m.t === 'end') {
          chain = chain.then(async () => {
            if (failed) return;
            const r = await nusa.fileClose(id);
            if (!r.ok) throw new Error(r.error || 'Gagal menyimpan file');
            finished = true;
            update(t, { state: 'done', bytes: t.size, path: r.path, savedName: r.name, finished: Date.now() }, true);
            ch.send(JSON.stringify({ t: 'ok', name: r.name }));
          }).catch((err) => fail(err.message));
        }
        return;
      }
      if (!t || t.state !== 'active') return fail('Data sebelum transfer disetujui');
      const buf = e.data;
      t.bytes += buf.byteLength;
      if (t.bytes > t.size) return fail('Ukuran file tidak sesuai');
      emit();
      chain = chain.then(async () => {
        if (failed) return;
        const r = await nusa.fileWrite(id, buf);
        if (!r.ok) throw new Error(r.error || 'Gagal menulis file');
      }).catch((err) => fail(err.message));
    };
    ch.onclose = () => { if (!finished) fail(t && t.state === 'cancelled' ? 'Dibatalkan' : 'Pengirim membatalkan / koneksi terputus'); };
  }

  function respond(id, ok) { transfers.get(id)?.decide?.(ok); }
  function cancel(id) {
    const t = transfers.get(id);
    if (t?.state === 'offer') return respond(id, false);
    if (!t || !['waiting', 'active', 'finishing'].includes(t.state)) return;
    update(t, { state: 'cancelled', error: 'Dibatalkan' }, true);
    try { t.channel?.close(); } catch {}
  }
  function clearFinished() {
    for (const [id, t] of transfers) if (!['offer', 'waiting', 'active', 'finishing'].includes(t.state)) transfers.delete(id);
    emit(true);
  }
  function cancelAll() { for (const id of transfers.keys()) cancel(id); }

  // Deterministic file used by the automated test: byte i = (i * 7 + 3) % 251.
  function testFile(size, name) {
    const a = new Uint8Array(size);
    for (let i = 0; i < size; i++) a[i] = (i * 7 + 3) % 251;
    return new File([a], name);
  }

  return {
    sendFile, receive, respond, cancel, clearFinished, cancelAll, testFile,
    list: () => [...transfers.values()],
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

// ---------- small UI widget (used by both windows) ----------
const NusaTransferUI = {
  mount(container, { title = 'Transfer file' } = {}) {
    const fmtBytes = (n) => {
      if (n < 1024) return n + ' B';
      const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
      return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
    };
    const STATE = { offer: 'Menunggu persetujuan Anda', waiting: 'Menunggu persetujuan penerima…', finishing: 'Menyelesaikan…', done: 'Selesai', error: 'Gagal', cancelled: 'Dibatalkan' };
    container.classList.add('xfer');
    const render = (list) => {
      container.classList.toggle('hidden', !list.length);
      container.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'xfer-head';
      head.innerHTML = '<b></b><span style="flex:1"></span>';
      head.querySelector('b').textContent = title;
      const folder = document.createElement('button');
      folder.textContent = 'Folder unduhan';
      folder.onclick = () => nusa.openDownloads();
      const clear = document.createElement('button');
      clear.textContent = 'Bersihkan';
      clear.onclick = () => NusaTransfer.clearFinished();
      head.append(folder, clear);
      container.appendChild(head);
      for (const t of list.slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'xfer-row ' + t.state;
        const pct = t.size ? Math.min(100, (t.bytes / t.size) * 100) : 100;
        const secs = Math.max(0.001, ((t.finished || Date.now()) - t.started) / 1000);
        const speed = t.state === 'active' ? ` · ${fmtBytes(Math.round(t.bytes / secs))}/s` : '';
        const status = t.state === 'active' ? `${fmtBytes(t.bytes)} / ${fmtBytes(t.size)}${speed}` : `${STATE[t.state] || t.state}${t.error && t.state !== 'cancelled' ? ': ' + t.error : ''} · ${fmtBytes(t.size)}`;
        row.innerHTML = `<div class="xfer-top"><span class="xfer-dir"></span><span class="xfer-name"></span></div><div class="xfer-bar"><i></i></div><div class="xfer-meta"><span class="xfer-status"></span><span style="flex:1"></span></div>`;
        row.querySelector('.xfer-dir').textContent = t.dir === 'out' ? '↑' : '↓';
        row.querySelector('.xfer-dir').title = t.dir === 'out' ? 'Dikirim' : 'Diterima';
        row.querySelector('.xfer-name').textContent = t.dir === 'in' && t.savedName ? t.savedName : t.name;
        row.querySelector('.xfer-name').title = row.querySelector('.xfer-name').textContent;
        row.querySelector('.xfer-bar i').style.width = pct + '%';
        row.querySelector('.xfer-status').textContent = status;
        const meta = row.querySelector('.xfer-meta');
        if (t.state === 'offer') {
          const yes = document.createElement('button'); yes.textContent = 'Terima'; yes.className = 'primary'; yes.onclick = () => NusaTransfer.respond(t.id, true);
          const no = document.createElement('button'); no.textContent = 'Tolak'; no.onclick = () => NusaTransfer.respond(t.id, false);
          meta.append(no, yes);
        } else if (['waiting', 'active', 'finishing'].includes(t.state)) {
          const b = document.createElement('button'); b.textContent = 'Batal'; b.onclick = () => NusaTransfer.cancel(t.id); meta.appendChild(b);
        } else if (t.state === 'done' && t.dir === 'in' && t.path) {
          const b = document.createElement('button'); b.textContent = 'Tampilkan'; b.onclick = () => nusa.showFile(t.path); meta.appendChild(b);
        }
        container.appendChild(row);
      }
    };
    NusaTransfer.onChange(render);
    render(NusaTransfer.list());
  },
};

window.NusaTransfer = NusaTransfer;
window.NusaTransferUI = NusaTransferUI;
