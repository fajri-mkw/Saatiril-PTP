# saatiril-electron-ptp

DSLR USB tether (PTP/MTP) untuk **saatiril-operator-electron** — port 1:1 dari
`PTPCameraManager.kt` (Saatiril-Andro) ke TypeScript/Node.

Membawa fitur yang sama dengan APK Android ke versi Electron/Windows:

| Kemampuan | Detail |
|---|---|
| Koneksi tether USB | Sony, Canon, Nikon, Fujifilm, Leica (PTP class 6) |
| Sony PC Remote | Handshake `SDIOConnect 0x9201` → `PriorityMode=0` (Body Priority) → `StoreDestination=17` (PC+Card) |
| Remote shutter dari layar | Sony: half-press AF (`0xD2C1`) → 300 ms → full-press (`0xD2C2`); generik: `InitiateCapture` |
| Ingestion otomatis | Event interrupt `ObjectAdded 0x4002` + fallback poll `GetObjectHandles` tiap 2 dtk |
| Deteksi mode USB salah | Kamera nyala sebagai Mass Storage → state `WRONG_MODE` + petunjuk per-merek (tanpa retry sia-sia) |
| Validasi foto | Hanya JPEG/RAW ≥ 2 KB — film & thumbnail di-skip |

## Struktur

```
electron-ptp/
├── src/
│   ├── constants.ts        # Opcode PTP/Sony, Vendor ID, tuning (paritas .kt)
│   ├── transport.ts        # Container PTP build/parse + parser DeviceInfo/ObjectInfo
│   ├── libusb-backend.ts   # Backend produksi: paket npm `usb` (libusb)
│   ├── mock-backend.ts     # Kamera Sony tiruan lengkap untuk test tanpa hardware
│   └── engine.ts           # State machine (port PTPCameraManager.kt)
├── examples/
│   ├── ipc.ts              # registerPtpIpc() — handler Electron main process
│   ├── preload-bridge.ts   # window.satsetPtp (contextBridge)
│   ├── renderer-example.ts # Kartu status tether di halaman operator
│   └── electron-stub.d.ts  # Stub tipe (hapus bila pakai electron asli)
├── test/
│   └── engine.test.ts      # 21 assertion end-to-end dengan mock
├── package.json
├── tsconfig.json           # build inti → dist/
├── tsconfig.examples.json  # typecheck contoh integrasi
└── tsconfig.test.json      # build test → dist-test/
```

## Cara pakai di saatiril-operator-electron

### 1. Salin modul

```bash
cp -r electron-ptp/ <repo-saatiril>/electron-clients/ptp/
cd <repo-saatiril>/electron-clients/ptp
npm install            # typescript + @types/node (usb = optionalDependencies)
```

### 2. Tambah dependency `usb` ke package-operator.json

```jsonc
// electron-clients/package-operator.json
{
  "dependencies": {
    "usb": "^2.14.0"
  }
}
```

Paket `usb` di Windows tersedia sebagai **prebuilt binary** (tidak perlu
compiler). Di Linux perlu `build-essential` + `libudev-dev`.

### 3. Registrasi IPC di operator-main.ts

```ts
import { registerPtpIpc } from './ptp/examples/ipc';
// ...di app.whenReady(), setelah mainWindow dibuat:
registerPtpIpc(mainWindow);
```

### 4. Expose bridge di preload.ts

```ts
import { exposePtpBridge } from './ptp/examples/preload-bridge';
contextBridge.exposeInMainWorld('satsetPtp', exposePtpBridge());
```

### 5. Aktifkan kartu tether di renderer

```ts
import { initPtpCard } from './ptp/examples/renderer-example';

// setelah halaman operator termuat:
initPtpCard({
  onPhoto: (dataUrl, filename) => {
    // teruskan ke pipeline foto yang sudah ada (crop → filter → overlay → socket)
    submitCapturedFrame(dataUrl, filename);
  },
});
```

Tombol AMBIL FOTO yang sudah ada tinggal menambahkan cabang:

```ts
if (window.satsetPtp && (await window.satsetPtp.status()).state === 'READY') {
  await window.satsetPtp.capture();
} else {
  // fallback: webcam / capture card (getUserMedia)
}
```

Prioritas kamera jadi: **DSLR USB (PTP) → capture card (UVC) → webcam** —
sama dengan versi Android.

## ⚠️ Driver Windows (penting!)

Kamera PTP di Windows secara default diklaim oleh **WPD (Windows Portable
Devices)** sehingga libusb tidak bisa membukanya. Solusi:

1. Download **Zadig** (<https://zadig.akeo.ie>).
2. Colok kamera (mode USB sudah benar: Sony = *PC Remote*).
3. Options → *List All Devices* → pilih kamera (mis. "ILCE-7M4").
4. Ganti driver ke **WinUSB** → *Install Driver*.
5. Cabut-pasang kabel. Aplikasi Electron sekarang bisa `claim` interface PTP.

> Tanpa langkah ini, `usb.getDeviceList()` tetap melihat kamera, tetapi
> `openDevice()` gagal dengan `LIBUSB_ERROR_ACCESS`. Ini perbedaan utama
> dari Android (tidak ada driver khusus — izin via dialog USB Android).

Alternatif tanpa ganti driver: jalankan aplikasi sebagai Administrator
*tidak* membantu; WPD harus dilepas dari device tersebut.

## Mode USB per-merek (sama seperti tutorial SatsetMobile)

| Merek | Setelan menu kamera |
|---|---|
| **Sony** | `PC Remote` (atau `Auto`) — remote shutter & ingestion hanya aktif di mode ini |
| **Canon** | `PTP` + Wi-Fi OFF |
| **Nikon** | `PTP` + Wi-Fi OFF |
| **Fujifilm** | `USB Tether Shooting Auto` |

Bila mode salah, aplikasi menampilkan:
> "Mode USB kamera salah. Di menu kamera, set USB Connection ke 'PC Remote' / 'PTP' / 'Tether'."

## Pengujian tanpa hardware

```bash
npm test
```

Menjalankan 21 assertion terhadap `MockSonyDevice` — kamera Sony tiruan
yang mengimplementasikan OpenSession, GetDeviceInfo, SDIO handshake,
remote shutter, event ObjectAdded, GetObject, dan mode Mass Storage.
Seluruh state machine engine dieksekusi nyata; hanya lapisan USB yang
dimock. Hasil terakhir: **21 lulus, 0 gagal**.

## Paritas dengan Android (PTPCameraManager.kt)

| Aspek | Android | Modul ini |
|---|---|---|
| Opcode Sony | `0x9201/0x9205/0x9207/0xD2C1/0xD2C2/0xD25A/0xD222` | identik |
| State | `DISCONNECTED…WRONG_MODE…READY` | identik |
| Ingestion | interrupt 100 ms + poll 2 dtk | identik |
| Timeout capture | 25 dtk | identik |
| Validasi foto | JPEG ≥ 2048 B | identik |
| Pesan status | string SatsetMobile | identik |

Perbedaan yang disengaja:
- **Live view tidak ada** — PTP tidak menyediakan video; kartu status tether
  menggantikan preview (sama seperti Android).
- **Downscale 2560 px** di Android terjadi di pipeline foto renderer —
  di Electron, scaling/filters sudah ditangani canvas renderer, jadi engine
  meneruskan buffer JPEG apa adanya.
- **Izin USB**: Android pakai dialog izin; Windows pakai driver WinUSB (Zadig).

## Lisensi

MIT — mengikuti repo utama.
