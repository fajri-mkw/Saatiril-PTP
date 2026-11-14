/**
 * Backend USB produksi menggunakan paket npm `usb`.
 * Dimuat DINAMIS (require('usb')) sehingga modul tetap bisa di-typecheck
 * dan diuji di lingkungan tanpa libusb — di sandbox ini kita pakai mock.
 */

import { UsbBackend, UsbDeviceLike, PtpUsbHandle, PtpResult, parseContainer, buildContainer } from './transport';
import { USB_CLASS_PTP, USB_CLASS_MASS_STORAGE } from './constants';

// Deklarasi tipe longgar untuk paket `usb` (optional dependency)
interface UsbModule {
  getDeviceList(): UsbDeviceLike[];
  findByIds(vid: number, pid: number): UsbDeviceLike | undefined;
  on(event: 'attach' | 'detach', cb: (dev: UsbDeviceLike) => void): void;
  WebUSB?: any;
}

function loadUsbModule(): UsbModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('usb');
    return mod as UsbModule;
  } catch {
    return null;
  }
}

/** Interface PTP: class 6 dengan bulk IN+OUT; fallback interface pertama. */
export function findPtpInterface(device: UsbDeviceLike): any | null {
  const ifaces = device.interfaces ?? [];
  let fallback: any = null;
  for (const iface of ifaces) {
    const cls = iface?.descriptor?.bInterfaceClass ?? (iface as any).interfaceClass;
    if (cls === USB_CLASS_PTP) return iface;
    if (fallback === null) fallback = iface;
  }
  return fallback ?? (ifaces.length > 0 ? ifaces[0] : null);
}

/**
 * True bila device hanya mengekspos interface Mass Storage (class 8)
 * tanpa PTP — mode USB kamera masih MSC (harus diganti ke PC Remote/PTP).
 */
export function hasMassStorageOnly(device: UsbDeviceLike): boolean {
  const ifaces = device.interfaces ?? [];
  let msc = false;
  for (const iface of ifaces) {
    const cls = iface?.descriptor?.bInterfaceClass ?? (iface as any).interfaceClass;
    if (cls === USB_CLASS_PTP) return false;
    if (cls === USB_CLASS_MASS_STORAGE) msc = true;
  }
  return msc;
}

class LibusbPtpHandle implements PtpUsbHandle {
  device: UsbDeviceLike;
  private iface: any;
  private epOut: any;
  private epIn: any;
  private tid = 0;

  constructor(device: UsbDeviceLike, iface: any, epOut: any, epIn: any) {
    this.device = device;
    this.iface = iface;
    this.epOut = epOut;
    this.epIn = epIn;
  }

  async transact(opcode: number, params: number[] = [], data?: Buffer): Promise<PtpResult> {
    const tid = this.tid++;
    const cmd = buildContainer(1, opcode, tid, params, data);
    await this.epOut.transfer(cmd);
    // Baca response/data dari bulk IN
    let response: PtpResult | null = null;
    for (let i = 0; i < 10; i++) {
      const inBuf = await this.epIn.transfer(512 * 1024);
      const parsed = parseContainer(inBuf);
      if (parsed.type === 3) {           // Response
        response = { code: parsed.code, data: null, params: parsed.params };
        break;
  	}
      if (parsed.type === 2 && parsed.tid === tid) {
        // Data block — simpan, response menyusul
        response = { code: -1, data: parsed.data, params: parsed.params };
      }
    }
    if (!response) throw new Error(`Timeout PTP: opcode 0x${opcode.toString(16)} tidak berespon`);
    if (response.code === -1) {
      // tunggu response final setelah data
      const inBuf = await this.epIn.transfer(512 * 1024);
      const parsed = parseContainer(inBuf);
      if (parsed.type === 3) return { code: parsed.code, data: response.data, params: parsed.params };
      throw new Error(`Protocol error: mengharapkan Response, dapat type ${parsed.type}`);
    }
    return response;
  }

  async readEvent(timeoutMs: number): Promise<Buffer | null> {
    try {
      // libusb interrupt IN dengan timeout — pakai API transfer dengan timeout
      const buf = await (this.epIn as any).transfer(512, timeoutMs as any);
      return buf as Buffer;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    try { await this.iface.release(); } catch { /* ignore */ }
    this.device.close();
  }
}

export class NodeUsbBackend implements UsbBackend {
  private mod: UsbModule | null = null;

  private ensureMod(): UsbModule {
    if (!this.mod) this.mod = loadUsbModule();
    if (!this.mod) {
      throw new Error(
        "Paket 'usb' belum terpasang. Jalankan: npm install usb " +
        '(butuh build tool di Linux; di Windows tersedia prebuilt binary).'
      );
    }
    return this.mod;
  }

  async listPtpCameras(): Promise<UsbDeviceLike[]> {
    const mod = this.ensureMod();
    return mod.getDeviceList().filter(d => {
      const ifaces: any[] = d.interfaces ?? [];
      return ifaces.some((iface: any) => {
        const cls = iface?.descriptor?.bInterfaceClass ?? iface?.interfaceClass;
        return cls === USB_CLASS_PTP;
      });
    });
  }

  async open(device: UsbDeviceLike): Promise<PtpUsbHandle> {
    await device.open();
    const iface = findPtpInterface(device);
    if (!iface) throw new Error('Interface PTP tidak ditemukan');
    await iface.claim();
    const epOut = iface.endpoint(1); // OUT
    const epIn = iface.endpoint(1);  // IN — lihat catatan endpoint direction di README
    return new LibusbPtpHandle(device, iface, epOut, epIn);
  }

  onAttach(cb: (device: UsbDeviceLike) => void): void {
    this.ensureMod()?.on('attach', cb as any);
  }

  onDetach(cb: (device: UsbDeviceLike) => void): void {
    this.ensureMod()?.on('detach', cb as any);
  }
}
