# NusaDesk

**Aplikasi remote desktop open source untuk macOS dan Windows yang bisa di-host sendiri.**
Hubungkan ke komputer lain lewat ID 9 digit untuk melihat layarnya secara real-time,
mengontrol mouse dan keyboard, menyinkronkan clipboard, dan mengirim file. Semuanya
peer-to-peer dan terenkripsi end-to-end. Server sinyal kecilnya Anda jalankan sendiri.

🇬🇧 [Read in English](README.md)

> **Status:** rilis awal (v1.x). Sudah berfungsi dan teruji, tapi belum diaudit keamanan
> oleh pihak luar. Baca [model keamanan](#model-keamanan) sebelum dipakai untuk hal sensitif.

## Fitur

- **ID perangkat 9 digit** dan **kata sandi sesi** yang berganti setiap aplikasi dibuka
- **Persetujuan masuk**: tanpa kata sandi, pengguna di komputer tujuan harus menekan *Terima*
- **Akses tanpa pengawasan** dengan kata sandi permanen (disimpan sebagai kunci turunan di Keychain / DPAPI)
- **Layar real-time** lewat WebRTC (H.264, fallback VP9/VP8), P2P, terenkripsi DTLS-SRTP
- **Kontrol penuh**: mouse, scroll, klik kanan, drag, semua tombol termasuk modifier
- **Transfer file** dua arah lewat tombol atau seret & lepas, dengan progres dan pilihan terima/tolak. File diterima ditandai sebagai unduhan internet.
- **Clipboard**: "kirim clipboard" sekali kirim, plus sinkron dua arah (opsional)
- **Multi-monitor**, mode kualitas, mode hanya-lihat, layar penuh, dan statistik koneksi
- **Kode verifikasi** di kedua layar untuk mendeteksi penyadapan
- **Bar always-on-top** di komputer yang dikontrol, lengkap dengan tombol *Putuskan*

## Cara kerja

Server sinyal hanya mempertemukan dua perangkat dan meneruskan data koneksi.
**Layar, input, file, dan kata sandi tidak pernah melewati server.** Diagram dan
teknologinya ada di [README bahasa Inggris](README.md#how-it-works).

## Mulai cepat

### 1. Jalankan server sinyal

Semua perangkat yang ingin saling terhubung harus memakai server yang sama.

```bash
# Lewat internet (HTTPS otomatis dengan Caddy; butuh domain yang mengarah ke mesin ini)
cd server/selfhost
DOMAIN=remote.contoh.com docker compose up -d
# → wss://remote.contoh.com

# Hanya jaringan lokal (LAN)
cd server
docker compose up -d --build
# → ws://<ip-mesin-ini>:8787
```

Detail lengkap, contoh reverse proxy, dan TURN ada di [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

### 2. Pasang aplikasi

Unduh installer dari [Releases](https://github.com/arieansyah/nusadesk/releases) atau
build sendiri. Saat pertama dibuka, masukkan alamat server Anda (`wss://…` atau `ws://…`).

| Platform | File |
|---|---|
| macOS Apple Silicon | `NusaDesk-<versi>-arm64.dmg` |
| macOS Intel | `NusaDesk-<versi>.dmg` |
| Windows | `NusaDesk.Setup.<versi>.exe` (installer) atau `NusaDesk.<versi>.exe` (portable) |

Build belum ditandatangani resmi:
- **macOS:** buka lewat *klik kanan → Open*.
- **Windows:** pilih *More info → Run anyway*.

**Izin macOS:** supaya bisa dikontrol, berikan izin **Screen Recording** dan
**Accessibility** di *System Settings → Privacy & Security*.

### 3. Hubungkan

1. Di komputer yang akan dikontrol: berikan **ID** dan **kata sandi sesi**, atau tanpa
   kata sandi lalu tekan *Terima* saat permintaan masuk.
2. Di komputer Anda: masukkan ID (dan kata sandi), lalu klik **Hubungkan**.
3. Opsional: pastikan **kode verifikasi** di kedua layar sama.

## Pengembangan

```bash
cd server && npm install && npm start                         # ws://localhost:8787
cd app && npm install && NUSADESK_SERVER=ws://localhost:8787 npm start
cd server && npm test     # tes aturan keamanan server
cd app && npm test        # tes end-to-end (server + dua instance aplikasi)
cd app && npm run dist:mac / npm run dist:win                 # build installer
```

## Model keamanan

- **Kata sandi tidak pernah dikirim ke server.** Viewer membuktikan kata sandi langsung ke
  host di dalam koneksi WebRTC terenkripsi. Bukti itu terikat ke sidik jari sertifikat
  DTLS kedua sisi, jadi server yang mencoba menyadap akan gagal. Host tidak membagikan
  apa pun sebelum bukti valid.
- **Kode verifikasi 6 digit** dari kedua sidik jari tampil di kedua layar. Kalau berbeda,
  koneksi sedang disadap.
- **Server:** rate limit per IP, maksimal 3 permintaan menunggu per host, dan penguncian
  tebak kata sandi 15 menit.
- **Aplikasi:** Electron fuses, sandbox, CSP, navigasi diblokir, dan switch dev diabaikan
  di build terpasang.
- **Privasi:** sinkron clipboard default mati, file dari host perlu persetujuan, dan file
  yang diterima diberi tanda quarantine / Mark-of-the-Web.

Detail dan keterbatasannya ada di [README bahasa Inggris](README.md#security-model).
Menemukan celah keamanan? Ikuti [SECURITY.md](SECURITY.md).

## Kontribusi

Lihat [CONTRIBUTING.md](CONTRIBUTING.md). Issue dan PR boleh dalam bahasa Indonesia atau Inggris.

## Lisensi

[GNU AGPL v3.0](LICENSE). Jika Anda memodifikasi NusaDesk lalu menyediakannya untuk orang
lain, termasuk sebagai layanan online, perubahan Anda wajib dibuka dengan lisensi yang sama.
