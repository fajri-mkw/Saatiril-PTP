/**
 * Stub tipe minimal `electron` untuk typecheck file contoh integrasi
 * TANPA meng-install electron (yakni di CI/sandbox). Saat dipakai di
 * repo saatiril-operator-electron sungguhan, hapus file ini —
 * types berasal dari paket electron asli.
 */
declare module 'electron' {
  export interface BrowserWindow {
    webContents: { send(channel: string, ...args: unknown[]): void };
  }
  export const ipcMain: {
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void;
    on(channel: string, fn: (event: unknown, ...args: unknown[]) => void): void;
  };
  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  };
  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };
}
