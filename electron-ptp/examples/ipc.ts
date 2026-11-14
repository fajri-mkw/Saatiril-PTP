/**
 * Integrasi PTP tether ke Electron main process (saatiril-operator-electron).
 *
 * Cara pakai di operator-main.ts (hanya 3 baris):
 *
 *   import { registerPtpIpc } from './ptp/ipc';
 *   // ... setelah app.whenReady():
 *   registerPtpIpc();   // registrasi semua handler di bawah
 *
 * Renderer lalu memanggil via preload bridge `window.satsetPtp`:
 *   window.satsetPtp.connect()
 *   window.satsetPtp.capture()          → Promise<{ handle: number | null }>
 *   window.satsetPtp.onPhoto(cb)        → Buffer JPEG base64 via IPC
 *   window.satsetPtp.onState(cb)        → status + label kamera
 *
 * Foto yang masuk otomatis diteruskan ke channel yang SAMA dengan pipeline
 * webcam/capture-card yang sudah ada di renderer (sendCapturedFrame dsb.),
 * jadi crop → filter → frame overlay → socket tidak perlu diubah.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { PtpEngine, PtpState, statusMessage } from '../src/engine';
import { NodeUsbBackend } from '../src/libusb-backend';
import { usbModeHint, vendorName } from '../src/constants';

export interface PtpIpcOptions {
  /** Backend injectable — default NodeUsbBackend (paket npm `usb`). */
  backend?: any;
  /** Callback saat foto siap disimpan (default: kirim ke renderer). */
  onPhoto?: (photo: { buffer: Buffer; filename: string; sizeBytes: number }) => void;
}

let engine: PtpEngine | null = null;
let mainWindow: BrowserWindow | null = null;

export function registerPtpIpc(win?: BrowserWindow, opts: PtpIpcOptions = {}): void {
  if (engine) return; // idempotent
  mainWindow = win ?? null;

  engine = new PtpEngine(opts.backend ?? new NodeUsbBackend(), {
    onState(st, label) {
      mainWindow?.webContents.send('ptp:state', {
        state: st,
        label,
        message: statusMessage(st),
        hint: st === PtpState.WRONG_MODE ? usbModeHint(0) : undefined,
      });
    },
    onPhoto(photo) {
      if (opts.onPhoto) { opts.onPhoto(photo); return; }
      // Kirim ke renderer sebagai base64 (Buffer tidak bisa lewat structured clone IPC)
      mainWindow?.webContents.send('ptp:photo', {
        base64: photo.buffer.toString('base64'),
        filename: photo.filename,
        sizeBytes: photo.sizeBytes,
      });
    },
    onError(err) {
      mainWindow?.webContents.send('ptp:error', { message: err.message, name: err.name });
    },
    onLog(msg) {
      mainWindow?.webContents.send('ptp:log', { msg });
    },
  });

  ipcMain.handle('ptp:connect', async () => {
    await engine!.connect();
    return { state: engine!.currentState, label: engine!.label };
  });

  ipcMain.handle('ptp:disconnect', async () => {
    await engine!.disconnect();
    return { ok: true };
  });

  ipcMain.handle('ptp:capture', async () => {
    const handle = await engine!.capture();
    return { handle: handle ?? null };
  });

  ipcMain.handle('ptp:status', () => ({
    state: engine!.currentState,
    label: engine!.label,
    message: statusMessage(engine!.currentState),
  }));
}

/** Ganti referensi window (mis. setelah window baru dibuat saat reconnect). */
export function setPtpWindow(win: BrowserWindow): void {
  mainWindow = win;
}
