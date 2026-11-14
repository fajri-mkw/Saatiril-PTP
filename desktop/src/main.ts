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
    icon: path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
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
