/**
 * Preload bridge untuk PTP tether — tambahkan isi fungsi ini ke preload.ts
 * operator (saatiril-operator-electron) di dalam contextBridge.exposeInMainWorld.
 *
 * Renderer mendapat objek `window.satsetPtp`:
 *   connect(): Promise<{state, label}>
 *   disconnect(): Promise<{ok}>
 *   capture(): Promise<{handle: number|null}>
 *   status(): Promise<{state, label, message}>
 *   onPhoto(cb): void     — unsubscribe otomatis saat unload
 *   onState(cb): void
 */

import { contextBridge, ipcRenderer } from 'electron';

export function exposePtpBridge(): void {
  contextBridge.exposeInMainWorld('satsetPtp', {
    connect: () => ipcRenderer.invoke('ptp:connect'),
    disconnect: () => ipcRenderer.invoke('ptp:disconnect'),
    capture: () => ipcRenderer.invoke('ptp:capture'),
    status: () => ipcRenderer.invoke('ptp:status'),

    onPhoto: (cb: (photo: { base64: string; filename: string; sizeBytes: number }) => void) => {
      const listener = (_e: unknown, photo: any) => cb(photo);
      ipcRenderer.on('ptp:photo', listener);
      window.addEventListener('unload', () => ipcRenderer.removeListener('ptp:photo', listener));
    },

    onState: (cb: (st: { state: string; label: string; message: string; hint?: string }) => void) => {
      const listener = (_e: unknown, st: any) => cb(st);
      ipcRenderer.on('ptp:state', listener);
      window.addEventListener('unload', () => ipcRenderer.removeListener('ptp:state', listener));
    },

    onError: (cb: (err: { name: string; message: string }) => void) => {
      const listener = (_e: unknown, err: any) => cb(err);
      ipcRenderer.on('ptp:error', listener);
      window.addEventListener('unload', () => ipcRenderer.removeListener('ptp:error', listener));
    },
  });
}
