# Saatiril PTP

[![Build Android APK](https://github.com/fajri-mkw/Saatiril-PTP/actions/workflows/build-android.yml/badge.svg)](https://github.com/fajri-mkw/Saatiril-PTP/actions/workflows/build-android.yml)
[![Electron PTP Module](https://github.com/fajri-mkw/Saatiril-PTP/actions/workflows/electron-ptp.yml/badge.svg)](https://github.com/fajri-mkw/Saatiril-PTP/actions/workflows/electron-ptp.yml)

**DSLR USB PTP tether untuk SAATIRIL** — *Sistem Auto Track Input, Raw Into Live* —
sistem manajemen fotografi wisuda real-time berbasis LAN.

Repo ini berisi dua komponen saling melengkapi:

1. **`app/` — Saatiril Andro (Android, Kotlin/Compose)**: aplikasi Android lengkap
   (Admin + MC + Operator dalam satu APK) dengan tether DSLR via kabel USB
   (`PTPCameraManager.kt`), capture card HDMI UVC, hand-trigger MediaPipe,
   dan klien Socket.io LAN.
2. **`electron-ptp/` — Modul PTP untuk saatiril-operator-electron (TypeScript)**:
   port 1:1 dari `PTPCameraManager.kt` agar versi Electron/Windows juga bisa
   tether DSLR (Sony PC Remote, Canon/Nikon PTP, Fujifilm Tether) — diuji
   21 assertion end-to-end dengan mock kamera Sony, tanpa hardware.

## What it does

During a graduation ceremony (wisuda), the Admin runs the Electron desktop app
on a Windows laptop. The laptop:

- Creates the project and imports the student Excel list.
- Owns the Socket.io relay server (port `3003`).
- Saves photos to the chosen output folder.

Phones/tablets running **Saatiril Andro** connect to that server over LAN Wi-Fi
and act as **Operator** (camera), **MC** (call students to the stage), or
**Admin** (live observation dashboard) — depending on the role selected at the
connect screen. All three panels are available in every install via the bottom
navigation bar, mirroring the unified view of the Electron app.

## Features (parity with the Electron/Windows version)

- **Operator panel — DSLR via kabel USB (PTP tether, baru)** — hubungkan
  kamera Sony / Canon / Nikon / Fujifilm langsung dengan kabel USB (OTG),
  tanpa capture card. Mode "Tethering Ingestion": foto otomatis masuk ke
  aplikasi saat tombol shutter fisik di body kamera ditekan, lalu dikirim
  ke server Saatiril. Tombol AMBIL FOTO di layar juga memicu shutter
  kamera (remote shutter, Sony half-press AF → full-press). Auto-reconnect
  saat kabel tercabut/terpasang ulang.
- **Operator panel — capture card HDMI (UVC)** — native Camera2 + USB UVC
  capture-card support (MacroSilicon / Magewell / Elgato HDMI capture cards),
  shutter modes (manual, 3s/5s/10s timer, hand-trigger via MediaPipe),
  gridline overlay, photo filter presets, frame overlay, capture-state
  machine. This is the same hardened camera stack shipped in
  `android-operator` v35.
- **MC panel** — searchable student queue, one-tap call to channel 1 or 2,
  active-target cards with reset/done, live sent/done/pending counters.
- **Admin panel** — project summary, live progress bar, photo gallery,
  filterable student database table, per-status counters, live latency badge.
- **Socket.io LAN client** — Engine.IO v3 compatible, 20 MB photo payloads,
  5-minute connection-state recovery, critical-event queue (photos, MC calls,
  sync, done, reset) replayed on reconnect.
- **Session password** — SHA-256 hashed, matches the Admin-set session password.
- **USB device filter** — auto-launches the camera when a PTP camera (DSLR)
  or a UVC capture card is plugged in.
- **Keep screen on** + portrait lock for field operation.

## Architecture

```
app/src/main/java/com/saatiril/andro/
├── MainActivity.kt              # Entry, permissions, USB intent, screen routing
├── SaatirilApp.kt               # Application + global crash handler
├── camera/
│   ├── PTPCameraManager.kt      # DSLR tether via kabel USB (PTP/USB SIC) — ingestion + remote shutter
│   ├── Camera2Manager.kt        # Built-in camera (front/back) via Camera2 API
│   ├── CameraCapture.kt         # Crop, filter presets, base64 encoding
│   ├── HandTriggerDetector.kt   # MediaPipe HandLandmarker (waving gesture)
│   └── UVCCameraManager.kt      # USB UVC capture cards (MacroSilicon fix)
├── data/
│   ├── Models.kt                # Student, Project, SocketEvents, ConnectionState
│   ├── OperatorViewModel.kt     # Central state, camera orchestration, MC/Admin actions
│   └── SocketManager.kt         # io.socket client, critical-event queue, ping/pong
├── ui/
│   ├── connection/ConnectionScreen.kt  # Server IP + role + channel + password
│   ├── operator/OperatorScreen.kt      # Camera preview + capture controls
│   ├── mc/McScreen.kt                  # MC panel (call/reset/done)
│   ├── admin/AdminScreen.kt            # Admin dashboard (gallery + DB + stats)
│   ├── gridline/GridlineOverlay.kt     # Compose Canvas grid overlay
│   └── main/MainScaffold.kt            # Top bar + bottom nav (Operator/MC/Admin)
└── util/
    ├── FilenameUtils.kt         # NIM_Nama_1_Toga.jpg naming + versioning
    ├── PhotoSaver.kt            # (legacy, unused — photos go via socket)
    └── Sha256.kt
```

## Unduh / Rilis

**Link unduh permanen — selalu build terbaru setiap ada update:**

| Saluran | Link | Isi |
|---|---|---|
| **Latest (update tiap push)** | [`releases/download/latest/saatiril-andro.apk`](https://github.com/fajri-mkw/Saatiril-PTP/releases/download/latest/saatiril-andro.apk) | APK release (R8, 32 MB) — **link ini tidak pernah berubah, isinya selalu build terbaru** |
| Latest — debug | [`releases/download/latest/saatiril-andro-debug.apk`](https://github.com/fajri-mkw/Saatiril-PTP/releases/download/latest/saatiril-andro-debug.apk) | APK debug (50 MB) |
| Rilis resmi | [`releases/latest`](https://github.com/fajri-mkw/Saatiril-PTP/releases/latest) | Rilis bertag `v*` terbaru |
| Semua rilis | [`releases`](https://github.com/fajri-mkw/Saatiril-PTP/releases) | Riwayat semua versi |

Mekanisme update: setiap push ke `main` otomatis mem-build APK dan **menimpa aset
di release `latest`** (`--clobber`) serta memperbarui catatan rilisnya (daftar
commit sejak tag terakhir + checksum SHA-256). Rilis bertag `v*` bersifat
permanen dan tidak pernah ditimpa.

## Build

Requirements: JDK 17, Android SDK 34, Kotlin 1.9.22, AGP 8.2.2.

```bash
# Local build
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease      # → app/build/outputs/apk/release/app-release-unsigned.apk
```

CI builds both debug and release APKs on every push to `main` and publishes
them to the `latest` GitHub Release. See
[.github/workflows/build-android.yml](.github/workflows/build-android.yml).

## Compatibility

- **minSdk 24** (Android 7.0) / **targetSdk 34** (Android 14)
- **ABI**: `arm64-v8a`, `armeabi-v7a` (real devices; x86 emulators excluded to
  keep the APK ~25 MB after R8).
- The Socket.io server must set `allowEIO3: true` because the Android client
  (`io.socket:socket.io-client:2.1.0`) speaks Engine.IO v3. The Saatiril
  Electron `main.ts` and `mini-services/saatiril-socket/index.ts` already do.

## How to use

1. Start the Saatiril Admin desktop app on a Windows laptop (it runs the
   Socket.io relay on port `3003`).
2. On the Android device, open **Saatiril Andro**, enter the laptop's LAN IP
   (e.g. `192.168.1.100`), pick a role (Operator / MC / Admin), pick a channel
   (1 or 2), and tap **Hubungkan**.
3. Use the bottom navigation to switch between Operator / MC / Admin panels.
4. The Admin role on Android is read-only observation — project creation and
   photo saving still happen on the Windows Electron side.

### Menghubungkan kamera DSLR via kabel USB (PTP tether)

1. Sambungkan kamera (Sony / Canon / Nikon / Fujifilm) ke HP dengan **kabel
   USB + OTG adapter** dan pastikan kamera menyala. Sesuaikan pengaturan
   mode USB di menu kamera (sama seperti tutorial SatsetMobile):
   - **Sony → `PC Remote`** (atau `Auto`) — remote shutter & ingestion
     hanya aktif di mode ini; mode `Mass Storage`/MTP biasa tidak cukup.
   - **Canon & Nikon → `PTP`** + **Wi-Fi OFF**.
   - **Fujifilm → `USB Tether Shooting Auto`**.
2. Muncul dialog izin USB → izinkan. Kartu status tether akan muncul di
   area preview (PTP tidak menyediakan live view video). Jika muncul
   peringatan **"Mode USB kamera salah"**, ubah setelan USB di menu kamera
   ke mode di atas, lalu cabut-pasang kabel.
3. **Foto otomatis masuk**: setiap kali fotografer menekan tombol shutter
   di body kamera, foto terdownload otomatis lalu dikirim ke server dengan
   pipeline yang sama (crop → filter → frame overlay → socket).
4. **Shutter dari layar**: tombol AMBIL FOTO memicu remote shutter kamera
   (Sony: half-press AF → full-press, timeout 25 detik).
5. Bila kabel tercabut, aplikasi otomatis mencoba menyambung ulang saat
   kabel dipasang kembali (retry hingga 3x, plus polling tiap 2 detik).

Prioritas kamera: **DSLR kabel USB (PTP) → capture card (UVC) → kamera HP
(Camera2)**. Kamera DSLR otomatis dipilih begitu sesi PTP siap.

## Acknowledgements

Built on top of the hardened `android-operator` v35 camera stack from the
Saatiril-Fullset repository, extended with native MC and Admin Compose panels
to achieve full parity with the Electron/Windows desktop application.

## CI / GitHub Actions

Kedua workflow sudah **aktif** di [`.github/workflows/`](.github/workflows/)
(salinan arsip di [`ci/workflows/`](ci/workflows/)):

- **`build-android.yml`** — unit test JVM → build APK debug+release → publish.
  Push ke `main` menimpa aset di release [`latest`](https://github.com/fajri-mkw/Saatiril-PTP/releases/tag/latest)
  beserta catatan rilis otomatisnya; tag `v*` membuat release permanen.
- **`electron-ptp.yml`** — build + 21 test mock modul `electron-ptp`, matrix
  Ubuntu + Windows.
