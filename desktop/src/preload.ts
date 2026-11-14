/**
 * Saatiril Desktop — preload bridge.
 * Renderer mendapat window.saatiril (contextIsolation aktif).
 */

import { contextBridge, ipcRenderer } from 'electron';

type Unsubscribe = () => void;

function subscribe(channel: string, cb: (payload: any) => void): Unsubscribe {
  const listener = (_e: unknown, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('saatiril', {
  // PTP
  connect: (): Promise<{ state: string; label: string }> => ipcRenderer.invoke('ptp:connect'),
  disconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('ptp:disconnect'),
  capture: (): Promise<{ handle: number | null }> => ipcRenderer.invoke('ptp:capture'),
  status: (): Promise<{ state: string; label: string; message: string }> => ipcRenderer.invoke('ptp:status'),
  demo: (): Promise<{ state: string; label: string }> => ipcRenderer.invoke('ptp:demo'),

  // App
  chooseFolder: (): Promise<{ folder: string }> => ipcRenderer.invoke('app:chooseFolder'),
  getFolder: (): Promise<{ folder: string }> => ipcRenderer.invoke('app:getFolder'),
  openPath: (p: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:openPath', p),

  // Events
  onState: (cb: (st: { state: string; label: string; message: string; hint?: string }) => void): Unsubscribe =>
    subscribe('ptp:state', cb),
  onPhoto: (cb: (photo: { path: string; filename: string; sizeBytes: number }) => void): Unsubscribe =>
    subscribe('ptp:photo', cb),
  onError: (cb: (err: { name: string; message: string }) => void): Unsubscribe =>
    subscribe('ptp:error', cb),
  onLog: (cb: (log: { msg: string }) => void): Unsubscribe =>
    subscribe('ptp:log', cb),
});
