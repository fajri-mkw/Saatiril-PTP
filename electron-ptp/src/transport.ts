/**
 * Transport PTP over USB untuk Electron/Node.
 *
 * Backend produksi: paket npm `usb` (WebUSB API) — di Windows kamera PTP
 * umumnya bisa diklaim langsung karena stack WPD (Windows Portable Devices)
 * memakai WinUSB; bila klaim gagal, instruksi Zadig ada di README modul.
 *
 * Backend test: MockUsbBackend — mensimulasikan kamera Sony lengkap
 * (OpenSession, SDIOConnect, remote shutter, ObjectAdded, GetObject)
 * sehingga seluruh state machine bisa diverifikasi tanpa hardware.
 */

// (Tidak ada import konstanta — modul ini murni util container/parsing byte.
//  Konstanta opcode ada di ./constants, dipakai oleh engine & backend.)

// ── Tipe data USB (subset yang kita pakai) ──
export interface UsbEndpointLike {
  transfer(length: number): Promise<Buffer>;
  transferWithStall(): Promise<void>;
  startPoll(raw?: boolean): void;
  stopPoll(raw?: boolean): void;
  on(event: 'data', cb: (data: Buffer) => void): void;
}

export interface UsbInterfaceLike {
  claim(): Promise<void>;
  release(): Promise<void>;
  /** 0 = OUT, 1 = IN (endpoint direction) */
  endpoint(dir: number): UsbEndpointLike;
  endpointDirection(dir: number): number;
  descriptor: { bInterfaceClass: number; bInterfaceSubClass: number };
  altInterface?: number;
}

export interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  deviceName?: string;
  open(): Promise<void>;
  close(): void;
  interfaces: UsbInterfaceLike[] | any;
  interfaceCount?: number;
  getInterface?(n: number): UsbInterfaceLike;
  configuration?: any;
  serialNumber?: string;
}

export interface UsbBackend {
  /** List device dengan class PTP (6) atau yang dikenal sebagai DSLR. */
  listPtpCameras(): Promise<UsbDeviceLike[]>;
  /** Buka koneksi + claim interface PTP. */
  open(device: UsbDeviceLike): Promise<PtpUsbHandle>;
  onAttach(cb: (device: UsbDeviceLike) => void): void;
  onDetach(cb: (device: UsbDeviceLike) => void): void;
}

export interface PtpUsbHandle {
  device: UsbDeviceLike;
  /** Kirim request PTP (container command) dan tunggu response. */
  transact(opcode: number, params?: number[], data?: Buffer): Promise<PtpResult>;
  /** Baca event/interrupt IN tanpa menunggu (timeout pendek). */
  readEvent(timeoutMs: number): Promise<Buffer | null>;
  /** Tutup koneksi dan lepaskan klaim interface. */
  close(): Promise<void>;
}

export interface PtpResult {
  code: number;
  data: Buffer | null;
  params: number[];
}

// ── Util byte (little-endian, sesuai spesifikasi PTP) ──
export function u16le(v: number): number { return v & 0xffff; }

export function buildContainer(type: number, opcode: number, transactionId: number, params: number[] = [], payload?: Buffer): Buffer {
  // Layout PIMA 15740: [length:4][type:2][code:2][transactionId:4][params:4×n][payload]
  const paramBytes = params.length * 4;
  const dataLen = payload ? payload.length : 0;
  const total = 12 + paramBytes + dataLen;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(total, 0);
  buf.writeUInt16LE(type, 4);           // 1=Command, 2=Data, 3=Response, 4=Event
  buf.writeUInt16LE(opcode, 6);
  buf.writeUInt32LE(transactionId, 8);
  params.forEach((p, i) => buf.writeUInt32LE(p >>> 0, 12 + i * 4));
  if (payload && dataLen > 0) payload.copy(buf, 12 + paramBytes);
  return buf;
}

export function parseContainer(buf: Buffer): { type: number; code: number; tid: number; params: number[]; data: Buffer | null } {
  if (buf.length < 12) throw new Error(`Container PTP terlalu pendek: ${buf.length}B`);
  const total = buf.readUInt32LE(0);
  const type = buf.readUInt16LE(4);
  const code = buf.readUInt16LE(6);
  const tid = buf.readUInt32LE(8);
  const params: number[] = [];
  let data: Buffer | null = null;
  const bodyStart = 12;
  const bodyEnd = Math.min(total, buf.length);
  if (type === 2) {
    // Data block: seluruh sisa adalah payload
    data = buf.subarray(bodyStart, bodyEnd);
  } else {
    // Command/Response/Event: body adalah array of uint32 params
    for (let o = bodyStart; o + 4 <= bodyEnd; o += 4) {
      params.push(buf.readUInt32LE(o));
    }
  }
  return { type, code, tid, params, data };
}

// ── Parsing ObjectInfo (PTP) ──
export interface ObjectInfo {
  storageId: number;
  objectFormat: number;
  objectCompressedSize: number;
  filename: string;
}

export function parseObjectInfo(data: Buffer): ObjectInfo {
  // [storageId:4][objectFormat:2][protection:2][compressedSize:4]...
  const storageId = data.readUInt32LE(0);
  const objectFormat = data.readUInt16LE(4);
  const objectCompressedSize = data.readUInt32LE(8);
  // filename: PTP string — [numChars:1][utf16le × numChars]
  let filename = '';
  const off = 52; // setelah 52 byte field tetap ObjectInfo standar
  if (off < data.length && data[off] > 0) {
    filename = readPtpString(data, off);
  }
  return { storageId, objectFormat, objectCompressedSize, filename };
}

export function parseModelFromDeviceInfo(data: Buffer): string {
  // GetDeviceInfo Data block: [standardVersion:2][vendorExtId:4][vendorExtVersion:2]
  // [vendorExtDesc: string][functionalMode:2][operations: array16][events: array16]
  // [deviceProps: array16][captureFormats: array16][imageFormats: array16][manufacturer: string][model: string]...
  try {
    let off = 0;
    const standardVersion = data.readUInt16LE(off); off += 2;
    const vendorExtId = data.readUInt32LE(off); off += 4;
    const vendorExtVersion = data.readUInt16LE(off); off += 2;
    off = skipPtpString(data, off); // vendorExtDesc
    off += 2;                       // functionalMode
    off = skipArray16(data, off);   // operationsSupported
    off = skipArray16(data, off);   // eventsSupported
    off = skipArray16(data, off);   // devicePropsSupported
    off = skipArray16(data, off);   // captureFormats
    off = skipArray16(data, off);   // imageFormats
    off = skipPtpString(data, off); // manufacturer
    return readPtpString(data, off); // model
  } catch {
    return '';
  }
}

function skipPtpString(data: Buffer, off: number): number {
  if (off >= data.length) return off;
  const n = data[off];          // jumlah KARAKTER utf16
  return off + 1 + n * 2;
}

function readPtpString(data: Buffer, off: number): string {
  if (off >= data.length || data[off] === 0) return '';
  const n = data[off];          // jumlah KARAKTER utf16
  return data.subarray(off + 1, off + 1 + n * 2).toString('utf16le').replace(/\0.*$/, '');
}

function skipArray16(data: Buffer, off: number): number {
  if (off + 2 > data.length) return off;
  const n = data.readUInt16LE(off);
  return off + 2 + n * 2;
}
