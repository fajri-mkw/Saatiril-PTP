/**
 * Saatiril Electron PTP — konstanta protokol PTP/USB.
 * Port 1:1 dari PTPCameraManager.kt (Android) agar opcode, Vendor ID,
 * dan aturan mode USB identik di kedua platform.
 */

// ── Opcode standar PTP (ISO 15740) ──
export const OP_GET_DEVICE_INFO = 0x1001;
export const OP_OPEN_SESSION = 0x1002;
export const OP_CLOSE_SESSION = 0x1003;
export const OP_GET_OBJECT_HANDLES = 0x1007;
export const OP_GET_OBJECT_INFO = 0x1008;
export const OP_GET_OBJECT = 0x1009;
export const OP_INITIATE_CAPTURE = 0x100e;
export const OP_GET_STILL_IMAGE = 0x90c2; // gPhoto "GetStillImage" fallback

// ── Opcode vendor Sony (SDIO / Remote Camera API over USB) ──
export const OP_SONY_SDIO_CONNECT = 0x9201;
export const OP_SONY_GET_EXT_DEVICE_INFO = 0x9202;
export const OP_SONY_SET_CONTROL_DEVICE_A = 0x9205;
export const OP_SONY_SET_CONTROL_DEVICE_B = 0x9207;
export const OP_SONY_QUERY_9209 = 0x9209;
export const OP_SONY_GET_PARTIAL_LARGE_OBJECT = 0x9211;
export const SONY_CONTROL_HALF_PRESS = 0xd2c1; // AF / half press
export const SONY_CONTROL_FULL_PRESS = 0xd2c2; // shutter / full press
export const SONY_PROP_PRIORITY_MODE = 0xd25a; // 0 = Body Priority
export const SONY_PROP_STORE_DESTINATION = 0xd222; // 17 = PC+Card
export const SONY_LAST_OBJECT_HANDLE = 0xffffc001;

// ── Event PTP ──
export const EVENT_OBJECT_ADDED = 0x4002;
export const EVENT_CAPTURE_COMPLETE = 0x400d;

// ── Response code ──
export const RESP_OK = 0x2001;
export const RESP_DEVICE_BUSY = 0x2019;
export const RESP_INVALID_OBJECT_HANDLE = 0x2009;
export const RESP_ACCESS_DENIED = 0x200f;

// ── Format objek ──
export const FORMAT_JPEG = 0x3801;
export const FORMAT_UNDEFINED = 0x3000;

// ── Vendor ID USB ──
export const VENDOR_CANON = 0x04a9; // 1193
export const VENDOR_SONY = 0x054c; // 1356
export const VENDOR_NIKON = 0x04b0; // 1200
export const VENDOR_FUJIFILM = 0x04cb; // 1227
export const VENDOR_LEICA = 0x04da; // 1242

// ── Kelas USB ──
export const USB_CLASS_PTP = 6; // Still Image / PTP
export const USB_CLASS_MASS_STORAGE = 8;

// ── Tuning (paritas dengan Android) ──
export const POLLING_INTERVAL_MS = 2000;
export const INGEST_INTERRUPT_TIMEOUT_MS = 100;
export const INGEST_IDLE_SLEEP_MS = 50;
export const OBJECT_INFO_WAIT_MS = 5_000;
export const CAPTURE_TIMEOUT_MS = 25_000;
export const MIN_PHOTO_BYTES = 2048;
export const MAX_INGEST_EDGE_PX = 2560;

export function vendorName(vid: number): string {
  switch (vid) {
    case VENDOR_SONY: return 'Sony';
    case VENDOR_CANON: return 'Canon';
    case VENDOR_NIKON: return 'Nikon';
    case VENDOR_FUJIFILM: return 'Fujifilm';
    case VENDOR_LEICA: return 'Leica';
    default: return 'PTP';
  }
}

/**
 * Petunjuk mode USB per-merek — persis string tutorial SatsetMobile:
 * "Pengaturan mode kamera: Sony ('PC Remote'), Canon & Nikon ('PTP' /
 * Wi-Fi OFF), atau Fujifilm ('USB Tether Shooting Auto')."
 */
export function usbModeHint(vid: number): string {
  switch (vid) {
    case VENDOR_SONY: return "Mode USB: 'PC Remote' (atau 'Auto')";
    case VENDOR_CANON:
    case VENDOR_NIKON: return "Mode USB: 'PTP' + Wi-Fi OFF";
    case VENDOR_FUJIFILM: return "Mode USB: 'USB Tether Shooting Auto'";
    default: return 'Mode USB: PTP / PC Remote';
  }
}
