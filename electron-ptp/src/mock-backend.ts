/**
 * MockUsbBackend — kamera Sony tiruan lengkap untuk pengujian protokol
 * TANPA hardware. Mensimulasikan perilaku PTP sesuai spesifikasi yang
 * diimplementasi PTPCameraManager.kt:
 *
 *  - OpenSession(1) → OK
 *  - GetDeviceInfo → "Sony α7 IV" (dengan model string PTP utf16le)
 *  - SDIOConnect(0x9201, param1=0xFFFFFFFF) → OK (diteruskan di mode PC Remote)
 *  - SetControlDeviceA(0x9205) PriorityMode=0 (Body Priority)
 *  - SetControlDeviceA(0x9205) StoreDestination=17 (PC+Card)
 *  - SetControlDeviceB(0x9207) 0xD2C1 half-press → OK (AF)
 *  - SetControlDeviceB(0x9207) 0xD2C2 full-press → OK + ObjectAdded (0x4002)
 *  - GetObject → JPEG minimal (MIN_PHOTO_BYTES) bila handle valid
 *  - Bila "mode" diset Mass Storage → tidak ada interface PTP → WRONG_MODE
 */

import { UsbBackend, UsbDeviceLike, PtpUsbHandle, PtpResult, buildContainer } from './transport';
import {
  OP_GET_DEVICE_INFO, OP_OPEN_SESSION, OP_CLOSE_SESSION, OP_GET_OBJECT_HANDLES,
  OP_GET_OBJECT_INFO, OP_GET_OBJECT, OP_INITIATE_CAPTURE,
  OP_SONY_SDIO_CONNECT, OP_SONY_SET_CONTROL_DEVICE_A, OP_SONY_SET_CONTROL_DEVICE_B,
  SONY_CONTROL_HALF_PRESS, SONY_CONTROL_FULL_PRESS,
  EVENT_OBJECT_ADDED, RESP_OK, FORMAT_JPEG,
  VENDOR_SONY, USB_CLASS_PTP, USB_CLASS_MASS_STORAGE,
} from './constants';

/** Header JPEG (Start of Image + APP0 JFIF) + padding ke ukuran minimum. */
function makeFakeJpeg(size: number): Buffer {
  const jpeg = Buffer.alloc(size, 0xff, undefined);
  // SOI
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  // APP0/JFIF
  jpeg[2] = 0xff; jpeg[3] = 0xe0; jpeg.writeUInt32BE(0x4a464946, 6); // "JFIF"
  return jpeg;
}

function ptpString(s: string): Buffer {
  const utf16 = Buffer.from(s, 'utf16le');
  const buf = Buffer.alloc(1 + utf16.length);
  buf[0] = s.length; // jumlah karakter
  utf16.copy(buf, 1);
  return buf;
}

export interface MockCameraOptions {
  vendorId?: number;
  model?: string;
  /** 'ptp' (PC Remote) atau 'msc' (Mass Storage → WRONG_MODE) */
  usbMode?: 'ptp' | 'msc';
  /** Delay event ObjectAdded setelah full-press (ms). */
  captureDelayMs?: number;
}

export class MockSonyDevice implements UsbDeviceLike {
  vendorId: number;
  productId: number;
  interfaces: any[];
  model: string;
  usbMode: 'ptp' | 'msc';
  captureDelayMs: number;

  /** Log semua transaksi — untuk assertion di test. */
  transcript: Array<{ op: string; params?: number[] }> = [];
  capturedPhotos: Buffer[] = [];
  objectHandles: number[] = [];
  private nextHandle = 0x80000001;
  private eventQueue: Buffer[] = [];
  private sessionOpen = false;
  private sdioConnected = false;
  private halfPressed = false;

  constructor(opts: MockCameraOptions = {}) {
    this.vendorId = opts.vendorId ?? VENDOR_SONY;
    this.productId = 0x0a71; // contoh PID α7 IV
    this.model = opts.model ?? 'Sony α7 IV';
    this.usbMode = opts.usbMode ?? 'ptp';
    this.captureDelayMs = opts.captureDelayMs ?? 5;
    this.interfaces = this.usbMode === 'ptp'
      ? [{ descriptor: { bInterfaceClass: USB_CLASS_PTP } }]
      : [{ descriptor: { bInterfaceClass: USB_CLASS_MASS_STORAGE } }];
  }

  // UsbDeviceLike
  async open(): Promise<void> { /* noop */ }
  close(): void { /* noop */ }

  // ── Mesin protokol PTP mock ──
  private buildGetDeviceInfo(): Buffer {
    // Susun GetDeviceInfo Data block secara manual
    const parts: Buffer[] = [];
    const w = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const d = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
    parts.push(w(100));                 // standardVersion = 100 (1.0)
    parts.push(d(0xFFFFFFFF));          // vendorExtId
    parts.push(w(100));                 // vendorExtVersion
    parts.push(ptpString('SonyExt'));   // vendorExtensionDesc
    parts.push(w(0));                   // functionalMode
    const ops = [OP_GET_DEVICE_INFO, OP_OPEN_SESSION, OP_CLOSE_SESSION, OP_GET_OBJECT_HANDLES,
      OP_GET_OBJECT_INFO, OP_GET_OBJECT, OP_INITIATE_CAPTURE,
      OP_SONY_SDIO_CONNECT, OP_SONY_SET_CONTROL_DEVICE_A, OP_SONY_SET_CONTROL_DEVICE_B];
    parts.push(w(ops.length)); ops.forEach(o => parts.push(w(o)));
    const evs = [EVENT_OBJECT_ADDED];
    parts.push(w(evs.length)); evs.forEach(e => parts.push(w(e)));
    const props = [0x0500 /*battery*/, 0x5007 /*fNumber*/];
    parts.push(w(props.length)); props.forEach(p => parts.push(w(p)));
    const caps = [FORMAT_JPEG];
    parts.push(w(caps.length)); caps.forEach(c => parts.push(w(c)));
    const imgFormats = [FORMAT_JPEG];
    parts.push(w(imgFormats.length)); imgFormats.forEach(f => parts.push(w(f)));
    parts.push(ptpString('Sony'));      // manufacturer
    parts.push(ptpString(this.model));  // model ← yang kita baca
    parts.push(ptpString('v1.0'));      // deviceVersion
    parts.push(ptpString('SN123456'));  // serialNumber
    return Buffer.concat(parts);
  }

  /** Proses container command dari handle; return response params. */
  async handleTransact(opcode: number, params: number[], data?: Buffer): Promise<PtpResult> {
    const opName = `0x${opcode.toString(16).padStart(4, '0')}`;
    this.transcript.push({ op: opName, params });
    switch (opcode) {
      case OP_GET_DEVICE_INFO:
        return { code: RESP_OK, data: this.buildGetDeviceInfo(), params: [] };
      case OP_OPEN_SESSION:
        if (this.sessionOpen) return { code: 0x201e /* SessionAlreadyOpen */, data: null, params: [] };
        this.sessionOpen = true;
        return { code: RESP_OK, data: null, params: [] };
      case OP_CLOSE_SESSION:
        this.sessionOpen = false;
        return { code: RESP_OK, data: null, params: [] };
      case OP_SONY_SDIO_CONNECT:
        // Hanya diterima bila kamera dalam PC Remote — di mock selalu OK
        this.sdioConnected = true;
        return { code: RESP_OK, data: null, params: [] };
      case OP_SONY_SET_CONTROL_DEVICE_A: {
        // param[0] = propCode, param[1] = nilai
        const [prop, value] = params;
        if (prop === 0xd25a /*PriorityMode*/) {
          this.transcript.push({ op: 'PriorityMode', params: [value] });
          return { code: RESP_OK, data: null, params: [] };
        }
        if (prop === 0xd222 /*StoreDestination*/) {
          this.transcript.push({ op: 'StoreDestination', params: [value] });
          return { code: RESP_OK, data: null, params: [] };
        }
        return { code: RESP_OK, data: null, params: [] };
      }
      case OP_SONY_SET_CONTROL_DEVICE_B: {
        const control = params[0];
        if (control === SONY_CONTROL_HALF_PRESS) {
          this.halfPressed = true;
          return { code: RESP_OK, data: null, params: [] };
        }
        if (control === SONY_CONTROL_FULL_PRESS) {
          if (!this.halfPressed) return { code: 0x2002 /* GeneralError */, data: null, params: [] };
          this.halfPressed = false;
          // Foto "tercaptur" → handle baru + event ObjectAdded setelah delay
          const handle = this.nextHandle++;
          const photo = makeFakeJpeg(4096);
          this.objectHandles.push(handle);
          this.capturedPhotos.push(photo);
          setTimeout(() => {
            this.eventQueue.push(buildContainer(4, EVENT_OBJECT_ADDED, 0, [handle]));
          }, this.captureDelayMs);
          return { code: RESP_OK, data: null, params: [handle] };
        }
        return { code: 0x2005 /* ParameterNotSupported */, data: null, params: [] };
      }
      case OP_GET_OBJECT_HANDLES:
        return { code: RESP_OK, data: packHandles(this.objectHandles), params: [] };
      case OP_GET_OBJECT_INFO: {
        const handle = params[0];
        const idx = this.objectHandles.indexOf(handle);
        if (idx < 0) return { code: 0x2009 /* InvalidObjectHandle */, data: null, params: [] };
        const photo = this.capturedPhotos[idx];
        const info = buildObjectInfo(photo.length, `DSC_${(idx + 1).toString().padStart(5, '0')}.JPG`);
        return { code: RESP_OK, data: info, params: [] };
      }
      case OP_GET_OBJECT: {
        const handle = params[0];
        const idx = this.objectHandles.indexOf(handle);
        if (idx < 0) return { code: 0x2009, data: null, params: [] };
        return { code: RESP_OK, data: this.capturedPhotos[idx], params: [] };
      }
      case OP_INITIATE_CAPTURE:
        // Seperti shutter fisik: capture + ObjectAdded event
        return this.handleTransact(OP_SONY_SET_CONTROL_DEVICE_B, [SONY_CONTROL_FULL_PRESS], data);
      default:
        return { code: 0x2005 /* OperationNotSupported */, data: null, params: [] };
    }
  }

  /** Ambil event pending (ObjectAdded dsb.) — dipakai loop ingestion. */
  pollEvent(): Buffer | null {
    return this.eventQueue.shift() ?? null;
  }
}

// ── helper pack ──
function packHandles(handles: number[]): Buffer {
  const buf = Buffer.alloc(4 + handles.length * 4);
  buf.writeUInt32LE(handles.length, 0);
  handles.forEach((h, i) => buf.writeUInt32LE(h, 4 + i * 4));
  return buf;
}

function buildObjectInfo(size: number, filename: string): Buffer {
  // Layout ObjectInfo sesuai PIMA 15740 (paritas parser parseObjectInfo):
  // off 0 : storageId(4) | off 4: objectFormat(2) | off 6: protection(2)
  // off 8 : compressedSize(4) | off 12: thumbFormat(2) | off 14: thumbSize(4)
  // off 18: thumbPixW(4) | off 22: thumbPixH(4) | off 26: imgPixW(4)
  // off 30: imgPixH(4) | off 34: bitDepth(4) | off 38: parentObject(4)
  // off 42: associationType(2) | off 44: associationDesc(4) | off 48: seqNo(4)
  // off 52: filename (PTP string) | lalu captureDate(4), modificationDate(4)
  const buf = Buffer.alloc(52 + 1 + filename.length * 2 + 8);
  buf.writeUInt32LE(0x00010001, 0);   // storageId
  buf.writeUInt16LE(FORMAT_JPEG, 4);  // objectFormat
  buf.writeUInt16LE(0, 6);            // protectionStatus
  buf.writeUInt32LE(size, 8);         // objectCompressedSize
  buf.writeUInt16LE(0, 12);           // thumbFormat
  buf.writeUInt32LE(0, 14);           // thumbCompressedSize
  buf.writeUInt32LE(0, 18);           // thumbPixWidth
  buf.writeUInt32LE(0, 22);           // thumbPixHeight
  buf.writeUInt32LE(6000, 26);        // imagePixWidth
  buf.writeUInt32LE(4000, 30);        // imagePixHeight
  buf.writeUInt32LE(24, 34);          // imageBitDepth
  buf.writeUInt32LE(0, 38);           // parentObject
  buf.writeUInt16LE(0, 42);           // associationType
  buf.writeUInt32LE(0, 44);           // associationDesc
  buf.writeUInt32LE(0, 48);           // sequenceNumber
  // filename PTP string di offset 52
  buf[52] = filename.length;
  Buffer.from(filename, 'utf16le').copy(buf, 53);
  const now = Math.floor(Date.now() / 1000);
  buf.writeUInt32LE(now, 53 + filename.length * 2);        // captureDate
  buf.writeUInt32LE(now, 53 + filename.length * 2 + 4);    // modificationDate
  return buf;
}

export class MockUsbBackend implements UsbBackend {
  attached: MockSonyDevice[] = [];
  private attachCbs: Array<(d: UsbDeviceLike) => void> = [];
  private detachCbs: Array<(d: UsbDeviceLike) => void> = [];

  async listPtpCameras(): Promise<UsbDeviceLike[]> {
    return this.attached.filter(d => d.usbMode === 'ptp');
  }

  async open(device: UsbDeviceLike): Promise<PtpUsbHandle> {
    const cam = device as MockSonyDevice;
    return new MockPtpHandle(cam);
  }

  attach(device: MockSonyDevice): void {
    this.attached.push(device);
    this.attachCbs.forEach(cb => cb(device));
  }

  detach(device: MockSonyDevice): void {
    this.attached = this.attached.filter(d => d !== device);
    this.detachCbs.forEach(cb => cb(device));
  }

  onAttach(cb: (device: UsbDeviceLike) => void): void { this.attachCbs.push(cb); }
  onDetach(cb: (device: UsbDeviceLike) => void): void { this.detachCbs.push(cb); }
}

/** Handle yang terhubung langsung ke mesin mock (tanpa USB sungguhan). */
class MockPtpHandle implements PtpUsbHandle {
  device: UsbDeviceLike;
  private cam: MockSonyDevice;
  private tid = 0;

  constructor(cam: MockSonyDevice) {
    this.cam = cam;
    this.device = cam;
  }

  async transact(opcode: number, params: number[] = [], data?: Buffer): Promise<PtpResult> {
    return this.cam.handleTransact(opcode, params, data);
  }

  async readEvent(timeoutMs: number): Promise<Buffer | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ev = this.cam.pollEvent();
      if (ev) return ev;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> { /* noop */ }
}
