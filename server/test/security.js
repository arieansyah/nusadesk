// Security behaviour of the signaling server: run with `npm test` (server/).
// Starts its own server on a random port with small limits.
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DB = path.join(os.tmpdir(), `nusadesk-sec-${process.pid}.json`);
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), NUSADESK_DB: DB, LIMIT_NEW_IDS_PER_IP: '20', LIMIT_CONNECT_PER_IP: '1000', LIMIT_SOCKETS_PER_IP: '30' },
  stdio: 'ignore',
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(id, key = `key-${id}-0000000000000`) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const queue = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].res(m); else queue.push(m);
    };
    ws.next = (pred, ms = 2000) => new Promise((res, rej) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return res(queue.splice(i, 1)[0]);
      const w = { pred, res };
      waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); rej(new Error('timeout waiting')); } }, ms);
    });
    ws.sendJson = (o) => ws.send(JSON.stringify(o));
    ws.onopen = async () => {
      ws.sendJson({ type: 'register', id, deviceKey: key });
      try { ws.reg = await ws.next((m) => m.type === 'registered' || m.type === 'error'); resolve(ws); } catch (e) { reject(e); }
    };
    ws.onerror = reject;
  });
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

(async () => {
  await wait(400);
  const host = await client('100000001');

  await test('ID tidak bisa diambil alih dengan deviceKey lain', async () => {
    const thief = await client('100000001', 'another-key-9999999999');
    assert.strictEqual(thief.reg.code, 'id-taken');
    thief.close();
  });

  await test('password tidak diteruskan ke host, mode diteruskan', async () => {
    const v = await client('200000001');
    v.sendJson({ type: 'connect-request', target: '100000001', mode: 'password', password: 'secret123' });
    const inc = await host.next((m) => m.type === 'incoming');
    assert.strictEqual(inc.mode, 'password');
    assert.ok(!('password' in inc), 'password field leaked to host');
    host.sendJson({ type: 'connect-response', sessionId: inc.sessionId, accepted: true, auth: { required: true, salt: 'abc', iters: 1000, nonce: 'n1' } });
    const r = await v.next((m) => m.type === 'connect-result');
    assert.deepStrictEqual(r.auth, { required: true, salt: 'abc', iters: 1000, nonce: 'n1' });
    v.close();
  });

  await test('host spam: maksimal 3 permintaan menunggu per host', async () => {
    const vs = [];
    for (let i = 0; i < 4; i++) vs.push(await client(`30000000${i}`));
    for (let i = 0; i < 3; i++) vs[i].sendJson({ type: 'connect-request', target: '100000001', mode: 'ask' });
    for (let i = 0; i < 3; i++) await vs[i].next((m) => m.type === 'connect-pending');
    vs[3].sendJson({ type: 'connect-request', target: '100000001', mode: 'ask' });
    const r = await vs[3].next((m) => m.type === 'connect-result');
    assert.strictEqual(r.reason, 'busy');
    // host rejects them, freeing the slots
    for (let i = 0; i < 3; i++) {
      const inc = await host.next((m) => m.type === 'incoming');
      host.sendJson({ type: 'connect-response', sessionId: inc.sessionId, accepted: false, reason: 'rejected' });
    }
    vs.forEach((v) => v.close());
  });

  await test('tebak password: terkunci setelah 5 gagal walau ganti ID viewer', async () => {
    for (let i = 0; i < 6; i++) {
      const v = await client(`40000000${i}`);
      v.sendJson({ type: 'connect-request', target: '100000001', mode: 'password' });
      const first = await v.next((m) => m.type === 'connect-pending' || m.type === 'connect-result');
      if (i < 5) {
        assert.strictEqual(first.type, 'connect-pending', `attempt ${i + 1} should be allowed`);
        const inc = await host.next((m) => m.type === 'incoming');
        host.sendJson({ type: 'connect-response', sessionId: inc.sessionId, accepted: true, auth: { required: true } });
        await v.next((m) => m.type === 'connect-result');
        host.sendJson({ type: 'auth-failed', sessionId: inc.sessionId });
        const end = await v.next((m) => m.type === 'session-ended');
        assert.strictEqual(end.reason, 'bad-password');
      } else {
        assert.strictEqual(first.reason, 'too-many-attempts');
      }
      v.close();
    }
  });

  await test('mode persetujuan tetap bisa saat password terkunci', async () => {
    const v = await client('500000001');
    v.sendJson({ type: 'connect-request', target: '100000001', mode: 'ask' });
    const r = await v.next((m) => m.type === 'connect-pending' || m.type === 'connect-result');
    assert.strictEqual(r.type, 'connect-pending');
    const inc = await host.next((m) => m.type === 'incoming');
    host.sendJson({ type: 'connect-response', sessionId: inc.sessionId, accepted: false, reason: 'rejected' });
    v.close();
  });

  await test('pendaftaran ID baru dibatasi per IP', async () => {
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      const c = await client(`6000000${String(i).padStart(2, '0')}`);
      if (c.reg.code === 'rate-limited') limited = true;
      c.close();
    }
    assert.ok(limited, 'no rate limit on new IDs');
  });

  await test('banjir pesan memutus koneksi', async () => {
    const c = await client('100000001'); // existing ID: not counted as new
    const closed = new Promise((r) => { c.onclose = (e) => r(e.code); });
    for (let i = 0; i < 1000; i++) c.sendJson({ type: 'ping' });
    assert.strictEqual(await Promise.race([closed, wait(3000).then(() => 'open')]), 1008);
  });

  console.log(results.join('\n'));
  srv.kill();
  fs.rmSync(DB, { force: true });
  process.exit();
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
