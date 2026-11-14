# Workflow CI (sudah aktif)

Workflow resmi berada di `.github/workflows/`. Salinan di `ci/workflows/`
hanya arsip referensi.

## Ringkasan

## Isi workflow

| File | Trigger | Yang dilakukan |
|---|---|---|
| `build-android.yml` | push ke main, tag `v*`, manual | Unit test JVM (15) → build APK debug & release → upload artifact → publish Release `latest` (branch) / permanen (tag) |
| `electron-ptp.yml` | push, PR, manual | Matrix Ubuntu + Windows: `npm ci` → build (tsc) → test mock Sony (21 assertion) → verifikasi paket `usb` |

## Release

- Push ke `main` → release **`latest`** diperbarui otomatis (prerelease, APK di-clobber)
- Push tag `v*` (mis. `v1.0.0`) → release permanen dibuat dengan APK debug+release
