/**
 * Saatiril Desktop — main process.
 *
 * Aplikasi tether DSLR via USB (PTP) untuk SAATIRIL:
 *   - Pakai PtpEngine dari modul electron-ptp (port PTPCameraManager.kt)
 *   - Backend produksi: NodeUsbBackend (paket npm `usb`)
 *   - Mode demo: MockUsbBackend (kamera Sony tiruan) — tanpa hardware
 *   - Foto otomatis tersimpan ke folder pilihan user (default Pictures/Saatiril)
 *   - IPC: ptp:connect/disconnect/capture/status/demo, app:chooseFolder
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { PtpEngine, PtpState, statusMessage } from '../../electron-ptp/src/engine';
import { NodeUsbBackend } from '../../electron-ptp/src/libusb-backend';
import { MockUsbBackend, MockSonyDevice } from '../../electron-ptp/src/mock-backend';
import { usbModeHint } from '../../electron-ptp/src/constants';

// Akar aplikasi (berisi package.json): __dirname = <root>/dist/desktop/src,
// sehingga root = tiga level ke atas. Path renderer & ikon SELALU relatif
// ke root ini — benar baik saat dev (desktop/) maupun ter-package (asar).
const APP_ROOT = path.join(__dirname, '..', '..', '..');
const RENDERER_INDEX = path.join(APP_ROOT, 'src/renderer/index.html');
const ICON_PATH = path.join(APP_ROOT, 'build/icon.png');

// E2E hook: smoke CI menjalankan app ter-package dan menunggu string ini
// di stdout renderer (lihat desktop/e2e-load-test.js). Tanpa ini, kegagalan
// memuat renderer hanya berupa jendela kosong (blank) tanpa pesan.
if (process.env.SAATIRIL_E2E) {
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('log-level', '0');
}

// Beberapa mesin Windows dengan GPU Intel lama / driver USB tertentu gagal
// merender isi jendela Electron 38 — software GL lebih lambat tapi pasti tampil.
if (!process.env.SAATIRIL_KEEP_GPU) {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
let engine: PtpEngine | null = null;
let currentBackend: NodeUsbBackend | MockUsbBackend | null = null;
let mockCam: MockSonyDevice | null = null;
let photoDir: string = path.join(app.getPath('pictures'), 'Saatiril');

// ── Events → renderer ──

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function attachEngine(backend: NodeUsbBackend | MockUsbBackend): void {
  engine?.disconnect().catch(() => undefined);
  currentBackend = backend;
  engine = new PtpEngine(backend, {
    onState(st, label) {
      send('ptp:state', {
        state: st,
        label,
        message: statusMessage(st),
        hint: st === PtpState.WRONG_MODE ? usbModeHint(mockCam ? mockCam.vendorId : 0) : undefined,
      });
    },
    onPhoto(photo) {
      // Simpan ke disk lalu beri tahu renderer
      const dest = uniquePath(path.join(photoDir, photo.filename));
      try {
        fs.mkdirSync(photoDir, { recursive: true });
        fs.writeFileSync(dest, photo.buffer);
        send('ptp:photo', {
          path: dest,
          filename: path.basename(dest),
          sizeBytes: photo.sizeBytes,
        });
        send('ptp:log', { msg: `Foto tersimpan: ${path.basename(dest)} (${(photo.sizeBytes / 1024).toFixed(0)} KB)` });
      } catch (err) {
        send('ptp:error', { name: 'SaveError', message: `Gagal menyimpan foto: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    onError(err) {
      send('ptp:error', { name: err.name, message: err.message });
    },
    onLog(msg) {
      send('ptp:log', { msg });
    },
  });
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${base}_${i}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
  return p;
}

// ── IPC handlers ──

function registerIpc(): void {
  ipcMain.handle('ptp:connect', async () => {
    if (!engine) attachEngine(new NodeUsbBackend());
    await engine!.connect();
    return { state: engine!.currentState, label: engine!.label };
  });

  ipcMain.handle('ptp:disconnect', async () => {
    if (engine) await engine.disconnect();
    return { ok: true };
  });

  ipcMain.handle('ptp:capture', async () => {
    if (!engine) throw new Error('Kamera belum terhubung');
    const handle = await engine.capture();
    return { handle: handle ?? null };
  });

  ipcMain.handle('ptp:status', () => {
    if (!engine) return { state: PtpState.DISCONNECTED, label: '', message: statusMessage(PtpState.DISCONNECTED) };
    return { state: engine.currentState, label: engine.label, message: statusMessage(engine.currentState) };
  });

  ipcMain.handle('ptp:demo', async () => {
    // Mode demo: kamera Sony α7 IV tiruan — full pipeline tanpa hardware
    mockCam = new MockSonyDevice({ model: 'Sony α7 IV (Demo)' });
    const backend = new MockUsbBackend();
    backend.attach(mockCam);
    attachEngine(backend);
    await engine!.connect();
    return { state: engine!.currentState, label: engine!.label };
  });

  ipcMain.handle('app:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Pilih folder penyimpanan foto',
      defaultPath: photoDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) photoDir = r.filePaths[0];
    return { folder: photoDir };
  });

  ipcMain.handle('app:getFolder', () => ({ folder: photoDir }));

  ipcMain.handle('app:openPath', (_e, p: string) => {
    void shell.openPath(p);
    return { ok: true };
  });
}

// ── Window ──

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#1a0b2e',
    title: 'Saatiril Desktop',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(RENDERER_INDEX);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Jangan per lagi "blank ungu" tanpa keterangan: bila renderer gagal
  // dimuat (path salah, asar korup, dsb.) tampilkan dialog + log yang jelas.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const msg = `Gagal memuat antarmuka (kode ${code}).
  File : ${RENDERER_INDEX}
  URL  : ${url}
  Sebab: ${desc}`;
    console.error('[saatiril] did-fail-load:', msg);
    dialog.showErrorBox('Saatiril — Antarmuka gagal dimuat', msg);
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  engine?.disconnect().catch(() => undefined);
});
