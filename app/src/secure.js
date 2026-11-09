// Crypto helpers shared by host and viewer pages (WebCrypto only).
'use strict';

const NusaSecure = (() => {
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // DTLS certificate fingerprint of an SDP ("sha-256 AB:CD:..."). WebRTC itself checks
  // that the encrypted connection really uses this certificate.
  function fingerprint(sdp) {
    const m = /a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/.exec(sdp || '');
    return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : '';
  }

  // Password proof sent by the viewer: HMAC(PBKDF2(password), nonce | host fp | viewer fp).
  async function proof(password, auth, hostFp, viewerFp) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(auth.salt), iterations: auth.iters }, base, 256);
    const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`nusadesk-auth-v1|${auth.nonce}|${hostFp}|${viewerFp}`));
    return hex(sig);
  }

  // Short verification code from both fingerprints. Both screens show the same code
  // only when nobody sits in the middle of the connection.
  async function sas(hostFp, viewerFp) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`nusadesk-sas-v1|${hostFp}|${viewerFp}`)));
    const n = ((d[0] << 16) | (d[1] << 8) | d[2]) % 1000000;
    return String(n).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
  }

  return { fingerprint, proof, sas };
})();

window.NusaSecure = NusaSecure;
