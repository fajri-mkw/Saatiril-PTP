/**
 * Test end-to-end PtpEngine dengan MockUsbBackend (kamera Sony tiruan).
 * Memverifikasi seluruh alur yang ada di PTPCameraManager.kt:
 *   1. connect → OpenSession → GetDeviceInfo (model terbaca)
 *   2. init Sony SDIO (PC Remote) → PriorityMode=0, StoreDestination=17
 *   3. remote shutter → half-press → full-press → ObjectAdded → foto terdownload
 *   4. shutter fisik (event ObjectAdded dari luar) → foto terdownload
 *   5. WRONG_MODE: kamera Mass Storage → state WRONG_MODE, tanpa retry
 *   6. disconnect bersih
 */

import { PtpEngine, PtpState, WrongUsbModeError } from '../src/engine';
import { MockUsbBackend, MockSonyDevice } from '../src/mock-backend';
import {
  OP_OPEN_SESSION, OP_GET_DEVICE_INFO, OP_SONY_SDIO_CONNECT,
  OP_SONY_SET_CONTROL_DEVICE_A, OP_SONY_SET_CONTROL_DEVICE_B,
  SONY_CONTROL_HALF_PRESS, SONY_CONTROL_FULL_PRESS,
  SONY_PROP_PRIORITY_MODE, SONY_PROP_STORE_DESTINATION, OP_GET_OBJECT,
} from '../src/constants';

let passed = 0, failed = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return pred();
}

async function test1_sonyHappyPath(): Promise<void> {
  console.log('\n[1] Sony happy path — connect + SDIO init + remote shutter + ingestion');
  const backend = new MockUsbBackend();
  const cam = new MockSonyDevice({ model: 'Sony α7 IV' });
  backend.attach(cam);

  const photos: Array<{ filename: string; size: number }> = [];
  const states: PtpState[] = [];
  const engine = new PtpEngine(backend, {
    onState(st, label) { states.push(st); },
    onPhoto(p) { photos.push({ filename: p.filename, size: p.sizeBytes }); },
    onError(e) { console.log('  onError:', e.message); },
    onLog(m) { /* quiet */ },
  });

  await engine.connect();
  ok(states.includes(PtpState.CONNECTING), 'state CONNECTING sempat terjadi');
  ok(engine.currentState === PtpState.READY, `state READY (dapat: ${engine.currentState})`);
  ok(engine.label === 'Sony α7 IV', `model terbaca dari GetDeviceInfo (dapat: "${engine.label}")`);

  // Verifikasi urutan init Sony (PC Remote handshake) di transcript kamera
  const ops = cam.transcript.map(t => t.op);
  ok(ops.includes(`0x${OP_OPEN_SESSION.toString(16)}`), 'OpenSession dikirim');
  ok(ops.includes(`0x${OP_GET_DEVICE_INFO.toString(16)}`), 'GetDeviceInfo dikirim');
  ok(ops.includes(`0x${OP_SONY_SDIO_CONNECT.toString(16)}`), 'SDIOConnect dikirim (PC Remote)');
  const prioIdx = cam.transcript.findIndex(t => t.op === 'PriorityMode');
  const storeIdx = cam.transcript.findIndex(t => t.op === 'StoreDestination');
  ok(prioIdx >= 0 && cam.transcript[prioIdx].params?.[0] === 0, 'PriorityMode = 0 (Body Priority)');
  ok(storeIdx >= 0 && cam.transcript[storeIdx].params?.[0] === 17, 'StoreDestination = 17 (PC+Card)');

  // Remote shutter dari layar
  const handle = await engine.capture();
  ok(handle !== null, `capture() return handle (dapat: ${handle})`);
  const halfIdx = cam.transcript.findIndex(t => t.op === '0x9207' && t.params?.[0] === SONY_CONTROL_HALF_PRESS);
  const fullIdx = cam.transcript.findIndex(t => t.op === '0x9207' && t.params?.[0] === SONY_CONTROL_FULL_PRESS);
  ok(halfIdx >= 0 && fullIdx > halfIdx, 'urutan half-press → full-press benar');

  // Event ObjectAdded (delay 5ms) → ingestion harus men-download foto
  const got = await waitFor(() => photos.length >= 1);
  ok(got, `foto ter-ingest otomatis via event ObjectAdded (dapat ${photos.length})`);
  ok(photos[0]?.size >= 2048, `foto valid ≥ MIN_PHOTO_BYTES (${photos[0]?.size}B)`);
  ok((photos[0]?.filename ?? '').endsWith('.JPG'), `filename ObjectInfo terbaca (${photos[0]?.filename})`);

  await engine.disconnect();
  ok(engine.currentState === PtpState.DISCONNECTED, 'disconnect bersih');
}

async function test2_wrongMode(): Promise<void> {
  console.log('\n[2] WRONG_MODE — kamera Mass Storage (mode USB salah)');
  const backend = new MockUsbBackend();

  let wrongModeReached = false;
  let wrongModeError = false;
  const engine = new PtpEngine(backend, {
    onState(st) { if (st === PtpState.WRONG_MODE) wrongModeReached = true; },
    onPhoto() {},
    onError(e) { if (e.name === 'WrongUsbModeError') wrongModeError = true; },
    onLog() {},
  });

  // Kamera MSC dicolok SETELAH engine dibuat → jalur onAttach.
  // listPtpCameras() memfilter hanya interface PTP, tapi onAttach
  // tetap memproses vendor dikenal → connectDevice → hasMassStorageOnly
  // → WrongUsbModeError → state WRONG_MODE (tanpa retry).
  const cam = new MockSonyDevice({ usbMode: 'msc' });
  backend.attach(cam);
  await waitFor(() => wrongModeReached, 1500);

  ok(wrongModeReached, `state WRONG_MODE tercapai via onAttach (state: ${engine.currentState})`);
  ok(cam.transcript.length === 0, 'tidak ada transaksi PTP dikirim ke device MSC (tidak retry sia-sia)');
  await engine.disconnect();
  ok(engine.currentState === PtpState.DISCONNECTED, 'disconnect setelah WRONG_MODE bersih');

  // Verifikasi label vendor → petunjuk mode (paritas SatsetMobile)
  const { usbModeHint, VENDOR_SONY, VENDOR_CANON, VENDOR_FUJIFILM } = await import('../src/constants');
  ok(usbModeHint(VENDOR_SONY).includes('PC Remote'), 'hint Sony menyebut PC Remote');
  ok(usbModeHint(VENDOR_CANON).includes('PTP'), 'hint Canon menyebut PTP');
  ok(usbModeHint(VENDOR_FUJIFILM).includes('Tether'), 'hint Fujifilm menyebut Tether');
}

async function test3_physicalShutter(): Promise<void> {
  console.log('\n[3] Shutter fisik — ObjectAdded muncul dari body kamera (tanpa capture())');
  const backend = new MockUsbBackend();
  const cam = new MockSonyDevice({});
  backend.attach(cam);

  const photos: number[] = [];
  const engine = new PtpEngine(backend, {
    onState() {},
    onPhoto(p) { photos.push(p.sizeBytes); },
    onError(e) { console.log('  onError:', e.message); },
    onLog() {},
  });

  await engine.connect();

  // Simulasikan fotografer menekan shutter di body kamera:
  // (half+full press langsung ke mock, tanpa lewat engine)
  await cam.handleTransact(OP_SONY_SET_CONTROL_DEVICE_B, [SONY_CONTROL_HALF_PRESS]);
  await cam.handleTransact(OP_SONY_SET_CONTROL_DEVICE_B, [SONY_CONTROL_FULL_PRESS]);

  const got = await waitFor(() => photos.length >= 1);
  ok(got, `ingestion menangkap foto shutter fisik via event/poll (dapat ${photos.length})`);
  await engine.disconnect();
}

async function test4_containerFormat(): Promise<void> {
  console.log('\n[4] Format container PTP — build/parse roundtrip');
  const { buildContainer, parseContainer } = await import('../src/transport');
  const cmd = buildContainer(1, OP_OPEN_SESSION, 0, [1]);
  ok(cmd.length === 16, `panjang container command 1-param = 16B (dapat ${cmd.length})`);
  const p = parseContainer(cmd);
  ok(p.type === 1 && p.code === OP_OPEN_SESSION && p.tid === 0 && p.params[0] === 1,
    'roundtrip command: type/code/tid/param benar');
  const data = buildContainer(2, OP_GET_OBJECT, 7, [], Buffer.from([1, 2, 3]));
  const d = parseContainer(data);
  ok(d.type === 2 && d.tid === 7 && d.data?.length === 3, 'roundtrip data block benar');
}

(async () => {
  await test1_sonyHappyPath();
  await test2_wrongMode();
  await test3_physicalShutter();
  test4_containerFormat();
  console.log(`\n══════════════════════════════════════════`);
  console.log(`HASIL: ${passed} lulus, ${failed} gagal`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
