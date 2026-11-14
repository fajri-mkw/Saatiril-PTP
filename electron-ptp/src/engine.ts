/**
 * PtpEngine — port state machine PTPCameraManager.kt (Android) ke TypeScript.
 * Alur identik dengan versi Android (paritas perilaku):
 *
 *  CONNECTED:
 *    1. OpenSession(1)                       — TID pertama harus 0
 *    2. GetDeviceInfo                        — baca model kamera
 *    3. Sony: SDIOConnect(0x9201, 0xFFFFFFFF) — hanya lolos di mode PC Remote
 *    4. Sony: PriorityMode=0 (Body Priority), StoreDestination=17 (PC+Card)
 *    5. state = READY, mulai loop ingestion
 *
 *  INGESTION (loop):
 *    - prioritas 1: baca event interrupt ObjectAdded(0x4002) → download foto
 *    - prioritas 2: poll fallback GetObjectHandles tiap POLLING_INTERVAL_MS
 *    - foto valid (JPEG ≥ MIN_PHOTO_BYTES) → callback onPhoto
 *
 *  CAPTURE (remote shutter):
 *    Sony   : SetControlDeviceB half-press(0xD2C1) → delay 300ms → full-press(0xD2C2)
 *    Generik: InitiateCapture(0x100E)
 *    Timeout CAPTURE_TIMEOUT_MS (25 dtk).
 */

import {
  UsbBackend, UsbDeviceLike, PtpUsbHandle, PtpResult,
  parseContainer, parseModelFromDeviceInfo, parseObjectInfo,
} from './transport';
import {
  OP_GET_DEVICE_INFO, OP_OPEN_SESSION, OP_CLOSE_SESSION, OP_GET_OBJECT_HANDLES,
  OP_GET_OBJECT_INFO, OP_GET_OBJECT, OP_INITIATE_CAPTURE,
  OP_SONY_SDIO_CONNECT, OP_SONY_SET_CONTROL_DEVICE_A, OP_SONY_SET_CONTROL_DEVICE_B,
  SONY_CONTROL_HALF_PRESS, SONY_CONTROL_FULL_PRESS,
  SONY_PROP_PRIORITY_MODE, SONY_PROP_STORE_DESTINATION, SONY_LAST_OBJECT_HANDLE,
  EVENT_OBJECT_ADDED,
  RESP_OK, FORMAT_JPEG, FORMAT_UNDEFINED,
  VENDOR_SONY, VENDOR_CANON, VENDOR_NIKON, VENDOR_FUJIFILM, VENDOR_LEICA,
  POLLING_INTERVAL_MS, INGEST_INTERRUPT_TIMEOUT_MS, INGEST_IDLE_SLEEP_MS,
  OBJECT_INFO_WAIT_MS, CAPTURE_TIMEOUT_MS, MIN_PHOTO_BYTES,
  vendorName, usbModeHint,
} from './constants';
import { hasMassStorageOnly } from './libusb-backend';

export enum PtpState {
  DISCONNECTED = 'DISCONNECTED',
  DETECTED = 'DETECTED',
  CONNECTING = 'CONNECTING',
  READY = 'READY',
  WRONG_MODE = 'WRONG_MODE',
  ERROR = 'ERROR',
}

/** Pesan status human-friendly (paritas string SatsetMobile). */
export function statusMessage(st: PtpState): string {
  switch (st) {
    case PtpState.DISCONNECTED: return 'Kamera tidak terdeteksi — tancapkan kabel USB & nyalakan kamera';
    case PtpState.DETECTED: return 'Kamera terdeteksi — menghubungkan…';
    case PtpState.CONNECTING: return 'Menghubungkan kamera…';
    case PtpState.READY: return 'Terhubung — Mode Tether';
    case PtpState.WRONG_MODE:
      return "Mode USB kamera salah. Di menu kamera, set USB Connection ke 'PC Remote' / 'PTP' / 'Tether'.";
    case PtpState.ERROR: return 'Gagal terhubung — cek kabel & coba sambung ulang';
  }
}

export interface EngineEvents {
  onState(st: PtpState, label: string): void;
  onPhoto(photo: { buffer: Buffer; filename: string; sizeBytes: number }): void;
  onError(err: Error): void;
  onLog(msg: string): void;
}

export class WrongUsbModeError extends Error {
  constructor(msg: string) { super(msg); this.name = 'WrongUsbModeError'; }
}

export class PtpEngine {
  private backend: UsbBackend;
  private ev: EngineEvents;
  private handle: PtpUsbHandle | null = null;
  private device: UsbDeviceLike | null = null;
  private state: PtpState = PtpState.DISCONNECTED;
  private cameraLabel = '';
  private vendorId = 0;
  private ingestTimer: NodeJS.Timeout | null = null;
  private ingestRunning = false;
  private knownHandles = new Set<number>();
  private destroying = false;
  private busy = false; // guard: satu transaksi PTP pada satu waktu

  constructor(backend: UsbBackend, events: EngineEvents) {
    this.backend = backend;
    this.ev = events;
    this.backend.onAttach(dev => {
      if (isKnownCamera(dev.vendorId)) this.safeAttach(dev);
    });
    this.backend.onDetach(() => this.onDeviceDetached());
  }

  get currentState(): PtpState { return this.state; }
  get label(): string { return this.cameraLabel; }

  // ── Public API ──

  /** Scan dan sambungkan kamera PTP pertama yang ditemukan. */
  async connect(): Promise<void> {
    if (this.handle) return; // sudah terhubung
    const cams = await this.backend.listPtpCameras();
    if (cams.length === 0) {
      this.setState(PtpState.DISCONNECTED, '');
      return;
    }
    await this.connectDevice(cams[0]);
  }

  async disconnect(): Promise<void> {
    this.destroying = true;
    this.stopIngestion();
    await this.closeHandle();
    this.destroying = false;
    this.setState(PtpState.DISCONNECTED, '');
  }

  /**
   * Remote shutter dari layar. Sony: half-press AF → full-press.
   * Return object handle baru (bila kamera melaporkan) atau null.
   */
  async capture(): Promise<number | null> {
    const h = this.handle;
    if (!h || this.state !== PtpState.READY) throw new Error('Kamera belum READY');
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    if (this.vendorId === VENDOR_SONY) {
      // Half-press AF
      let r = await this.transact(h, OP_SONY_SET_CONTROL_DEVICE_B, [SONY_CONTROL_HALF_PRESS]);
      if (r.code !== RESP_OK) throw new Error(`Half-press AF gagal: 0x${r.code.toString(16)}`);
      await sleep(300);
      // Full-press shutter
      r = await this.transact(h, OP_SONY_SET_CONTROL_DEVICE_B, [SONY_CONTROL_FULL_PRESS]);
      if (r.code !== RESP_OK) throw new Error(`Full-press gagal: 0x${r.code.toString(16)}`);
      // ObjectAdded datang via event loop; handle juga bisa di params[0]
      return r.params[0] ?? null;
    }
    // Generik (Canon/Nikon/Fuji): InitiateCapture
    const r = await this.transact(h, OP_INITIATE_CAPTURE, [0, 0]);
    if (r.code !== RESP_OK && r.code !== 0x2019 /*DeviceBusy*/) {
      throw new Error(`InitiateCapture gagal: 0x${r.code.toString(16)}`);
    }
    if (Date.now() > deadline) throw new Error('Timeout capture');
    return r.params[1] ?? null;
  }

  // ── Koneksi & sesi ──

  private safeAttach(dev: UsbDeviceLike): void {
    if (this.destroying || this.handle) return;
    this.connectDevice(dev).catch(err => this.ev.onError(err));
  }

  private async connectDevice(dev: UsbDeviceLike): Promise<void> {
    if (this.handle) return;
    this.device = dev;
    this.setState(PtpState.CONNECTING, '');
    try {
      // ── Deteksi mode USB salah (Mass Storage tanpa PTP) ──
      if (hasMassStorageOnly(dev)) {
        this.ev.onLog(`Camera USB mode is wrong (Mass Storage terdeteksi) — ${usbModeHint(this.vendorId)}`);
        throw new WrongUsbModeError(
          "Mode USB kamera salah (Mass Storage). Set USB Connection ke 'PC Remote'/'PTP'/'Tether'."
        );
      }
      this.handle = await this.backend.open(dev);
      this.vendorId = dev.vendorId;

      // OpenSession(1) — transactionId pertama harus 0
      const open = await this.transact(this.handle, OP_OPEN_SESSION, [1]);
      if (open.code !== RESP_OK) {
        throw new Error(`OpenSession gagal: 0x${open.code.toString(16)}`);
      }

      // GetDeviceInfo — nama model kamera
      const info = await this.transact(this.handle, OP_GET_DEVICE_INFO, []);
      if (info.code === RESP_OK && info.data) {
        const model = parseModelFromDeviceInfo(info.data);
        this.cameraLabel = model || `${vendorName(this.vendorId)} DSLR`;
      } else {
        this.cameraLabel = `${vendorName(this.vendorId)} DSLR`;
      }

      // Sony: inisialisasi SDIO remote (hanya lolos di mode PC Remote)
      if (this.vendorId === VENDOR_SONY) {
        const sdio = await this.transact(this.handle, OP_SONY_SDIO_CONNECT, [0xFFFFFFFF]);
        if (sdio.code !== RESP_OK) {
          // 0x2019 DeviceBusy biasanya berarti mode USB bukan PC Remote
          this.ev.onLog(`SDIOConnect ditolak (0x${sdio.code.toString(16)}) — cek mode 'PC Remote' di kamera`);
        } else {
          // PriorityMode = 0 (Body Priority) & StoreDestination = 17 (PC+Card)
          await this.transact(this.handle, OP_SONY_SET_CONTROL_DEVICE_A, [SONY_PROP_PRIORITY_MODE, 0]);
          await this.transact(this.handle, OP_SONY_SET_CONTROL_DEVICE_A, [SONY_PROP_STORE_DESTINATION, 17]);
        }
      }

      // Baseline: tandai handle yang sudah ada supaya hanya foto BARU yang diingest
      const handles = await this.transact(this.handle, OP_GET_OBJECT_HANDLES, [0, 0, 0]);
      if (handles.code === RESP_OK && handles.data) {
        this.parseHandleList(handles.data).forEach(hd => this.knownHandles.add(hd));
      }

      this.setState(PtpState.READY, this.cameraLabel);
      this.startIngestion();
    } catch (err) {
      if (err instanceof WrongUsbModeError) {
        await this.closeHandle();
        this.setState(PtpState.WRONG_MODE, '');
        return; // tidak auto-retry — user harus ganti setelan kamera
      }
      this.ev.onError(err instanceof Error ? err : new Error(String(err)));
      await this.closeHandle();
      this.setState(PtpState.ERROR, '');
    }
  }

  private async closeHandle(): Promise<void> {
    if (this.handle) {
      try { await this.transact(this.handle, OP_CLOSE_SESSION, []); } catch { /* ignore */ }
      try { await this.handle.close(); } catch { /* ignore */ }
      this.handle = null;
    }
  }

  private onDeviceDetached(): void {
    this.stopIngestion();
    void this.closeHandle();
    this.setState(PtpState.DISCONNECTED, '');
    this.ev.onLog('Koneksi USB ke kamera terputus. Pastikan kabel tetap tertancap & kamera menyala.');
  }

  // ── Ingestion loop ──

  private startIngestion(): void {
    this.ingestRunning = true;
    this.ingestLoop().catch(err => this.ev.onError(err));
  }

  private stopIngestion(): void {
    this.ingestRunning = false;
    if (this.ingestTimer) { clearTimeout(this.ingestTimer); this.ingestTimer = null; }
  }

  private async ingestLoop(): Promise<void> {
    let lastPoll = 0;
    while (this.ingestRunning && this.handle) {
      // 1) Event interrupt (ObjectAdded) — prioritas utama
      const evBuf = await this.handle.readEvent(INGEST_INTERRUPT_TIMEOUT_MS);
      if (evBuf) {
        const ev = parseContainer(evBuf);
        if (ev.code === EVENT_OBJECT_ADDED) {
          const handle = ev.params[0];
          if (handle !== undefined && !this.knownHandles.has(handle)) {
            this.knownHandles.add(handle);
            await this.downloadObject(handle);
          }
        }
        continue;
      }
      // 2) Fallback poll tiap POLLING_INTERVAL_MS
      const now = Date.now();
      if (now - lastPoll >= POLLING_INTERVAL_MS) {
        lastPoll = now;
        await this.pollNewObjects();
      } else {
        await sleep(INGEST_IDLE_SLEEP_MS);
      }
    }
  }

  private async pollNewObjects(): Promise<void> {
    const h = this.handle;
    if (!h) return;
    try {
      const r = await this.transact(h, OP_GET_OBJECT_HANDLES, [0, 0, 0]);
      if (r.code !== RESP_OK || !r.data) return;
      const handles = this.parseHandleList(r.data);
      for (const hd of handles) {
        if (!this.knownHandles.has(hd)) {
          this.knownHandles.add(hd);
          await this.downloadObject(hd);
        }
      }
    } catch (err) {
      this.ev.onLog(`Poll GetObjectHandles gagal: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async downloadObject(handle: number): Promise<void> {
    const h = this.handle;
    if (!h) return;
    const info = await this.transact(h, OP_GET_OBJECT_INFO, [handle]);
    if (info.code !== RESP_OK || !info.data) return;
    const oi = parseObjectInfo(info.data);
    // Hanya foto (JPEG / RAW-undefined) — skip movie & lainnya
    if (oi.objectFormat !== FORMAT_JPEG && oi.objectFormat !== FORMAT_UNDEFINED) return;
    if (oi.objectCompressedSize < MIN_PHOTO_BYTES) return;
    const obj = await this.transact(h, OP_GET_OBJECT, [handle]);
    if (obj.code !== RESP_OK || !obj.data || obj.data.length < MIN_PHOTO_BYTES) return;
    this.ev.onPhoto({
      buffer: obj.data,
      filename: oi.filename || `IMG_${handle.toString(16).toUpperCase()}.JPG`,
      sizeBytes: obj.data.length,
    });
  }

  // ── Util ──

  /** Transaksi dengan guard busy — PTP tidak boleh paralel. */
  private async transact(h: PtpUsbHandle, opcode: number, params: number[] = [], data?: Buffer): Promise<PtpResult> {
    while (this.busy) await sleep(5);
    this.busy = true;
    try {
      return await h.transact(opcode, params, data);
    } finally {
      this.busy = false;
    }
  }

  private parseHandleList(data: Buffer): number[] {
    if (data.length < 4) return [];
    const n = data.readUInt32LE(0);
    const out: number[] = [];
    for (let i = 0; i < n && 4 + i * 4 + 4 <= data.length; i++) {
      out.push(data.readUInt32LE(4 + i * 4));
    }
    return out;
  }

  private setState(st: PtpState, label: string): void {
    this.state = st;
    if (label) this.cameraLabel = label;
    this.ev.onState(st, this.cameraLabel);
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** Filter device attach: hanya proses vendor DSLR yang dikenal. */
function isKnownCamera(vid: number): boolean {
  return [VENDOR_SONY, VENDOR_CANON, VENDOR_NIKON, VENDOR_FUJIFILM, VENDOR_LEICA].includes(vid);
}
