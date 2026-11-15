/**
 * Saatiril Desktop — E2E load test (menjalankan aplikasi TER-PACKAGE sungguhan).
 *
 * Membuktikan renderer benar-benar dimuat di app hasil electron-builder —
 * bug "blank purple" v1.1.0 lolos semua test lama justru karena tidak ada
 * yang menjalankan app-nya. Test ini:
 *   1. Launch executable di dist-app/linux-unpacked dengan SAATIRIL_E2E=1
 *      di atas X virtual (xvfb-run) — tanpa display fisik
 *   2. Kumpulkan stdout+stderr (Chromium log level 0 → console.log renderer
 *      ikut keluar karena enable-logging)
 *   3. PASS bila muncul SAATIRIL_RENDERER_OK dan TIDAK ada did-fail-load /
 *      ERROR:CONSOLE fatal
 *
 * Pemakaian: xvfb-run -a node e2e-load-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const appDir = process.env.SAATIRIL_E2E_APPDIR || path.join(__dirname, 'dist-app', 'linux-unpacked');
const exe = path.join(appDir, 'saatiril-desktop');

if (!fs.existsSync(exe)) {
  console.error('Executable tidak ada: ' + exe + ' — jalankan npm run pack:dir dulu.');
  process.exit(1);
}

const TIMEOUT_MS = 60_000;
let out = '';
const child = spawn(exe, ['--no-sandbox'], {
  env: {
    ...process.env,
    SAATIRIL_E2E: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    // GPU offscreen pada X virtual
    LIBGL_ALWAYS_SOFTWARE: '1',
    DISPLAY: process.env.DISPLAY || ':99',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const timer = setTimeout(() => {
  console.error('TIMEOUT: aplikasi tidak mencapai SAATIRIL_RENDERER_OK dalam ' + TIMEOUT_MS / 1000 + ' dtk');
  console.error('--- output yang tertangkap ---');
  console.error(out.slice(-4000));
  child.kill('SIGKILL');
  process.exit(1);
}, TIMEOUT_MS);

child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });

// Poll setiap 500ms — begitu penanda muncul, langsung selesai sukses
const poll = setInterval(() => {
  const loaded = out.includes('SAATIRIL_RENDERER_OK');
  const failedLoad = out.includes('did-fail-load') || /ERROR:CONSOLE.*Uncaught/.test(out);
  if (loaded && !failedLoad) {
    clearInterval(poll); clearTimeout(timer);
    console.log('E2E PASS: renderer termuat (SAATIRIL_RENDERER_OK diterima)');
    console.log('--- cuplikan log ---');
    console.log(out.split('\n').filter(l => /RENDERER_OK|saatiril|INFO:CONSOLE/.test(l)).slice(0, 8).join('\n'));
    child.kill('SIGTERM');
    process.exit(0);
  }
  if (failedLoad) {
    clearInterval(poll); clearTimeout(timer);
    console.error('E2E FAIL: renderer gagal dimuat');
    console.error('--- output yang tertangkap ---');
    console.error(out.slice(-4000));
    child.kill('SIGKILL');
    process.exit(1);
  }
}, 500);

child.on('exit', (code, sig) => {
  clearInterval(poll); clearTimeout(timer);
  if (!out.includes('SAATIRIL_RENDERER_OK')) {
    console.error('E2E FAIL: aplikasi keluar (' + code + '/' + sig + ') sebelum renderer termuat');
    console.error('--- output yang tertangkap ---');
    console.error(out.slice(-4000));
    process.exit(1);
  }
  process.exit(0);
});
