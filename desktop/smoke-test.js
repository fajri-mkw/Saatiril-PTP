/**
 * Saatiril Desktop — smoke test (tanpa display, tanpa Electron runtime).
 *
 * Memverifikasi inti pipeline main-process yang di-compile tsc:
 *   1. PtpEngine + MockUsbBackend → connect → READY
 *   2. capture() → ObjectAdded → onPhoto dengan buffer JPEG
 *   3. uniquePath() tidak menimpa file yang sudah ada
 *   4. IPC contract: channel & shape payload yang dikirim renderer
 *
 * Berjalan di Node murni — CI Linux tidak perlu xvfb.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Hasil compile ada di dist/ (rootDir=.., outDir=dist)
const engineMod = require('./dist/electron-ptp/src/engine');
const mockMod = require('./dist/electron-ptp/src/mock-backend');
const { PtpEngine: PtpEngineC, PtpState: PtpStateE, statusMessage } = engineMod;
const { MockUsbBackend, MockSonyDevice } = mockMod;

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  OK   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function waitFor(pred, ms) {
  const deadline = Date.now() + (ms || 3000);
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return pred();
}

// ── Salin uniquePath dari main.ts (logika sama; main.ts tidak bisa di-require
//    karena mengimpor 'electron' — diuji lewat smoke di bawah dengan stub) ──
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = base + '_' + i + ext;
    if (!fs.existsSync(cand)) return cand;
  }
  return p;
}

async function main() {
  console.log('\n[1] Pipeline engine+mock: connect → READY → capture → photo');

  const photos = [];
  const states = [];
  const backend = new MockUsbBackend();
  const cam = new MockSonyDevice({ model: 'Sony α7 IV (Demo)' });
  backend.attach(cam);

  const engine = new PtpEngineC(backend, {
    onState(st, label) { states.push([st, label]); },
    onPhoto(p) { photos.push(p); },
    onError(e) { console.log('  onError:', e.message); },
    onLog() { /* quiet */ },
  });

  await engine.connect();
  ok(engine.currentState === PtpStateE.READY, 'engine READY setelah connect', 'dapat ' + engine.currentState);
  ok(engine.label === 'Sony α7 IV (Demo)', 'label kamera terbaca', 'dapat ' + engine.label);

  // Remote shutter
  const handle = await engine.capture();
  ok(handle !== null && handle !== undefined, 'capture() mengembalikan handle', 'dapat ' + handle);
  const gotPhoto = await waitFor(() => photos.length >= 1);
  ok(gotPhoto, 'foto terdownload via event ObjectAdded');
  if (photos[0]) {
    ok(photos[0].buffer.length >= 2048, 'ukuran foto ≥ MIN_PHOTO_BYTES', String(photos[0].buffer.length));
    ok(photos[0].buffer[0] === 0xff && photos[0].buffer[1] === 0xd8, 'magic bytes JPEG (SOI)');
    ok(/^DSC_000\d+\.JPG$/.test(photos[0].filename), 'nama file DSC_xxxxx.JPG', photos[0].filename);
  }

  // Shutter fisik: half-press AF → full-press (disimulasikan langsung di body kamera)
  await cam.handleTransact(0x9207, [0xd2c1]); // half-press AF
  await cam.handleTransact(0x9207, [0xd2c2]); // full-press shutter
  const gotTwo = await waitFor(() => photos.length >= 2);
  ok(gotTwo, 'foto kedua via shutter fisik (half→full press)');

  await engine.disconnect();
  ok(engine.currentState === PtpStateE.DISCONNECTED, 'disconnect bersih');

  console.log('\n[2] uniquePath — tidak menimpa file');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saatiril-smoke-'));
  const f1 = uniquePath(path.join(tmp, 'DSC_00001.JPG'));
  fs.writeFileSync(f1, 'x');
  const f2 = uniquePath(path.join(tmp, 'DSC_00001.JPG'));
  ok(f1 !== f2, 'kolisi nama → suffix _1', f2);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n[3] IPC contract — channel yang dipakai renderer vs main.ts');
  const mainSrc = fs.readFileSync(path.join(__dirname, 'src', 'main.ts'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, 'src', 'preload.ts'), 'utf8');
  for (const ch of ['ptp:connect', 'ptp:disconnect', 'ptp:capture', 'ptp:status', 'ptp:demo',
                    'app:chooseFolder', 'app:getFolder', 'app:openPath',
                    'ptp:state', 'ptp:photo', 'ptp:error', 'ptp:log']) {
    ok(mainSrc.includes("'" + ch + "'") && preloadSrc.includes("'" + ch + "'"),
      'channel ' + ch + ' ada di main+preload');
  }
  // renderer hanya memanggil API yang diekspos preload
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'renderer.js'), 'utf8');
  for (const fn of ['connect', 'disconnect', 'capture', 'status', 'demo', 'chooseFolder', 'getFolder', 'openPath', 'onState', 'onPhoto', 'onError', 'onLog']) {
    ok(rendererSrc.includes('.' + fn + '('), 'renderer memanggil saatiril.' + fn);
    ok(preloadSrc.includes(fn + ':'), 'preload mengekspos ' + fn);
  }

  console.log('\n[4] statusMessage — pesan human-friendly (paritas Android)');
  ok(statusMessage(PtpStateE.WRONG_MODE).includes('PC Remote'), 'pesan WRONG_MODE menyebut PC Remote');
  ok(statusMessage(PtpStateE.READY).includes('Tether'), 'pesan READY menyebut Tether');

  console.log('\n=========================================');
  console.log('  ' + passed + ' OK, ' + failed + ' FAIL');
  console.log('=========================================');
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });
