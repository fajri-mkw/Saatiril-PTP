# Saatiril Desktop

**Aplikasi tether DSLR via USB (PTP) untuk SAATIRIL** — versi Electron/Windows
dari sistem kamera yang sama dengan [Saatiril Andro](../app). Dibangun di atas
modul [`electron-ptp`](../electron-ptp) (port 1:1 `PTPCameraManager.kt`).

## Fitur

- **Tether DSLR via kabel USB (PTP)** — Sony (PC Remote), Canon & Nikon (PTP),
  Fujifilm (Tether). Kamera dikenali otomatis saat dicolok (hot-plug).
- **Tethering Ingestion** — setiap foto yang diambil (tombol shutter fisik di
  body kamera maupun remote shutter dari layar) otomatis terdownload dan
  tersimpan ke folder pilihan Anda.
- **Remote shutter** — Sony: half-press AF → full-press (timeout 25 dtk);
  generik: InitiateCapture.
- **Mode USB salah?** Aplikasi mendeteksi mode Mass Storage dan menampilkan
  instruksi yang tepat per-merek ("PC Remote" / "PTP" / "USB Tether").
- **Mode Demo** — coba seluruh alur tanpa kamera (kamera Sony α7 IV tiruan).
- Auto-reconnect saat kabel dicabut/pasang, anti-nama-file-tabrakan, galeri
  foto masuk, dan log aktivitas real-time.

## Unduh

| Saluran | File | Keterangan |
|---|---|---|
| Latest | `saatiril-setup.exe` | Installer Windows (NSIS, one-click) |
| Latest | `saatiril-portable.exe` | **Portable** — jalankan tanpa instalasi |
| Latest | `saatiril-linux.AppImage` | Linux portable (chmod +x lalu jalankan) |
| Rilis resmi | [releases](https://github.com/fajri-mkw/Saatiril-PTP/releases) | Semua versi bertag `v*` |

Link unduh permanen (selalu build terbaru):

- https://github.com/fajri-mkw/Saatiril-PTP/releases/download/latest/saatiril-setup.exe
- https://github.com/fajri-mkw/Saatiril-PTP/releases/download/latest/saatiril-portable.exe
- https://github.com/fajri-mkw/Saatiril-PTP/releases/download/latest/saatiril-linux.AppImage

## Mode USB kamera (penting!)

| Merek | Setelan di menu kamera |
|---|---|
| Sony | USB Connection → **PC Remote** (atau Auto) |
| Canon / Nikon | **PTP** + Wi-Fi OFF |
| Fujifilm | **USB Tether Shooting Auto** |

Di Windows, kamera PTP umumnya langsung bisa diklaim (stack WPD/WinUSB). Bila
klaim gagal, pasang driver WinUSB untuk kamera Anda via
[Zadig](https://zadig.akeo.ie/) (pilih device kamera → driver WinUSB).

## Pengembangan

```bash
cd desktop
npm install
npm run build        # tsc → dist/
npm run smoke        # 48 assertion pipeline (tanpa hardware)
npm start            # jalankan aplikasi
npm run dist         # package installer + portable + AppImage
```

Struktur:

```
desktop/
├── build/icon.png|ico        # ikon aplikasi (kamera emas, lensa cyan)
├── src/
│   ├── main.ts               # main process: engine wiring, IPC, auto-save foto
│   ├── preload.ts            # bridge window.saatiril
│   └── renderer/             # UI (HTML/CSS/JS murni — tanpa framework)
├── smoke-test.js             # CI test: engine+mock, IPC contract, uniquePath
└── package.json              # electron-builder: nsis + portable + AppImage
```

Catatan teknis: `usb` (NAPI prebuilt) tidak di-rebuild saat packaging
(`npmRebuild: false`) — prebuild NAPI kompatibel dengan ABI Electron, jadi
installer/portable tetap kecil dan build tidak butuh compiler libusb.
