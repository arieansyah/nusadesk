// Always-on-top bar shown while someone controls this computer.
'use strict';
const fmt = (id) => String(id).replace(/(\d{3})(?=\d)/g, '$1 ');

nusa.onIndicator((list) => {
  const box = document.getElementById('list');
  box.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'row';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `${s.name || 'Viewer'} (${fmt(s.from)})${s.viaPassword ? ' · kata sandi' : ''}`;
    const code = document.createElement('span');
    code.className = 'code mono';
    code.textContent = s.sas;
    code.title = 'Kode verifikasi: harus sama dengan yang terlihat oleh orang yang terhubung';
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = 'Putuskan';
    btn.onclick = () => nusa.indicatorEnd(s.sessionId);
    row.append(who, code, btn);
    box.appendChild(row);
  }
});
