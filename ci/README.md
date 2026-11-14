# Aktifasi GitHub Actions (1 menit)

File workflow CI di repo ini **sengaja disimpan di `ci/workflows/`** (bukan
`.github/workflows/`) karena token yang dipakai untuk push awal repo tidak
memiliki scope `workflow` — GitHub menolak semua penulisan file di
`.github/workflows/` (via git push, Contents API, maupun Git Data API)
tanpa scope tersebut.

## Yang perlu Anda lakukan (pilih salah satu)

### Opsi A — Tambahkan workflow via Web UI (paling cepat, tanpa token baru)

1. Buka <https://github.com/fajri-mkw/Saatiril-PTP/actions/new>
2. Klik link **"set up a workflow yourself"** (tombol kanan atas area editor)
3. Hapus isi `blank.yml`, salin seluruh isi `ci/workflows/build-android.yml`
   (atau `electron-ptp.yml`), commit dengan nama file `build-android.yml`
   (atau `electron-ptp.yml` — bukan `blank.yml`)
4. Ulangi untuk file kedua. Selesai — Actions langsung berjalan pada push berikutnya.

### Opsi B — Regenerate token dengan scope `workflow`

1. Buka <https://github.com/settings/tokens>
2. Edit token yang dipakai (atau buat baru) → centang **`workflow`** (selain `repo`)
3. Simpan, lalu dari mesin lokal:

```bash
git clone https://github.com/fajri-mkw/Saatiril-PTP.git
cd Saatiril-PTP
mkdir -p .github/workflows
cp ci/workflows/build-android.yml   .github/workflows/
cp ci/workflows/electron-ptp.yml    .github/workflows/
git add .github && git commit -m "ci: aktifkan workflow Android + Electron PTP"
git push origin main
```

Setelah file workflow masuk `.github/workflows/`, push/commit berikutnya
dengan token lama (scope `repo` saja) **tetap diizinkan** — pembatasan hanya
berlaku saat membuat/mengubah file workflow itu sendiri.

## Isi workflow

| File | Trigger | Yang dilakukan |
|---|---|---|
| `build-android.yml` | push ke main, tag `v*`, manual | Unit test JVM (15) → build APK debug & release → upload artifact → publish Release `latest` (branch) / permanen (tag) |
| `electron-ptp.yml` | push, PR, manual | Matrix Ubuntu + Windows: `npm ci` → build (tsc) → test mock Sony (21 assertion) → verifikasi paket `usb` |

## Release

- Push ke `main` → release **`latest`** diperbarui otomatis (prerelease, APK di-clobber)
- Push tag `v*` (mis. `v1.0.0`) → release permanen dibuat dengan APK debug+release
