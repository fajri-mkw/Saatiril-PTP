/**
 * Saatiril Desktop — verifikasi asar hasil electron-builder (tanpa menjalankan app).
 *
 * Menangkap kelas bug "blank purple" v1.1.0: main.js memuat renderer/ikon dari
 * path yang tidak ada di dalam asar. Tes ini:
 *   1. Buka app.asar hasil build (--dir)
 *   2. Pastikan file kunci ada: main.js, preload.js, renderer/index.html,
 *      engine PTP, ikon
 *   3. Parse path yang dipakai main.js (RENDERER_INDEX/ICON_PATH dihitung dari
 *      __dirname) dan pastikan file itu benar-benar ada di dalam asar —
 *      simulasi matematis yang sama dengan runtime loadFile.
 *   4. Pastikan prebuild usb NAPI ada (linux-x64 & win32-x64) agar kamera
 *      berfungsi tanpa rebuild.
 *
 * Pemakaian: node verify-package.js [path-linux-unpacked]
 */

const fs = require('fs');
const path = require('path');

// asar list lokal — bila @electron/asar tidak ada, fallback pakai modul dari
// node_modules electron-builder
function loadAsar() {
  try {
    return require('@electron/asar');
  } catch {
    return require(path.join(__dirname, 'node_modules', '@electron', 'asar'));
  }
}

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  OK   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function main() {
  // Auto-detect folder unpacked (linux-unpacked / win-unpacked) — hasil step
  // package electron-builder. Override: SAATIRIL_VERIFY_DIR / argv[2].
  const distApp = path.join(__dirname, 'dist-app');
  let appDir = process.argv[2] || process.env.SAATIRIL_VERIFY_DIR || '';
  if (!appDir) {
    if (!fs.existsSync(distApp)) {
      console.error('Tidak ada dist-app/ — build dulu (npm run pack:dir / dist)');
      process.exit(1);
    }
    const cand = fs.readdirSync(distApp)
      .filter(d => d.endsWith('-unpacked'))
      .map(d => path.join(distApp, d))
      .filter(d => fs.existsSync(path.join(d, 'resources', 'app.asar')));
    if (cand.length === 0) {
      console.error('Tidak ada folder *-unpacked berisi resources/app.asar di dist-app/');
      process.exit(1);
    }
    appDir = cand[0];
  }
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  console.log('app dir :', appDir);

  if (!fs.existsSync(asarPath)) {
    console.error('TIDAK ADA app.asar di ' + asarPath + ' — build dulu (npm run pack:dir)');
    process.exit(1);
  }
  const asar = loadAsar();

  console.log('\n[1] File kunci ada di dalam asar');
  // Normalisasi: listPackage memakai path.sep platform — di Windows backslash.
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\/+/, '');
  const list = asar.listPackage(asarPath).map(norm);
  const has = (rel) => list.includes(norm(rel));
  // extractFile juga perlu separator platform — coba dua-duanya
  const extract = (rel) => {
    const n = norm(rel);
    try { return asar.extractFile(asarPath, n); }
    catch { return asar.extractFile(asarPath, n.replace(/\//g, path.sep)); }
  };
  for (const rel of [
    '/dist/desktop/src/main.js',
    '/dist/desktop/src/preload.js',
    '/src/renderer/index.html',
    '/src/renderer/renderer.js',
    '/src/renderer/style.css',
    '/dist/electron-ptp/src/engine.js',
    '/build/icon.png',
    '/package.json',
  ]) {
    ok(has(rel), 'aset ' + rel + ' ada di asar', 'tidak ditemukan');
  }

  console.log('\n[2] Path yang dimuat main.js benar-benar ada (regresi blank v1.1.0)');
  // Ambil source main.js dari dalam asar
  const mainSrc = extract('dist/desktop/src/main.js').toString('utf8');
  const usesAppRoot = /APP_ROOT\s*=\s*path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'\.\.'\)/.test(mainSrc);
  ok(usesAppRoot, 'main.js menghitung APP_ROOT 3-level dari __dirname');
  ok(mainSrc.includes("path.join(APP_ROOT, 'src/renderer/index.html')"),
    'loadFile memakai APP_ROOT/src/renderer/index.html');

  // Simulasi matematis runtime:
  //   __dirname (di asar) = <asar>/dist/desktop/src
  //   RENDERER_INDEX      = join(__dirname, '../../../src/renderer/index.html')
  const asarRoot = '/app.asar'; // prefiks logis dalam asar
  const dirname = asarRoot + '/dist/desktop/src';
  const rendererIndex = path.join(dirname, '..', '..', '..', 'src/renderer/index.html');
  const iconPath = path.join(dirname, '..', '..', '..', 'build/icon.png');
  const relRenderer = rendererIndex.replace(asarRoot, '').replace(/^\/+/, '');
  const relIcon = iconPath.replace(asarRoot, '').replace(/^\/+/, '');
  ok(has('/' + relRenderer), 'loadFile → ' + relRenderer + ' ADA di asar', 'path kosong — renderer akan blank!');
  ok(has('/' + relIcon), 'ikon → ' + relIcon + ' ada di asar');

  // preload dimuat relatif __dirname — pastikan valid juga
  const relPreload = path.join(dirname, 'preload.js').replace(asarRoot, '').replace(/^\/+/, '');
  ok(has('/' + relPreload), 'preload → ' + relPreload + ' ada di asar');

  console.log('\n[3] Native module usb (prebuild NAPI)');
  ok(list.some(p => p.includes('node_modules/usb/prebuilds/linux-x64/')), 'prebuild usb linux-x64 ada');
  ok(list.some(p => p.includes('node_modules/usb/prebuilds/win32-x64/')), 'prebuild usb win32-x64 ada');
  ok(list.some(p => p.endsWith('usb/prebuilds/win32-x64/node.napi.node')),
    'binary .node win32-x64 ada');

  console.log('\n[4] index.html mereferensikan aset yang benar');
  const html = extract('src/renderer/index.html').toString('utf8');
  ok(html.includes('style.css') && html.includes('renderer.js'), 'index.html memuat style.css + renderer.js');
  // CSP tidak memblokir file lokal
  ok(!/script-src\s+'none'/.test(html), 'CSP tidak memblokir script lokal');

  console.log('\n=========================================');
  console.log('  ' + passed + ' OK, ' + failed + ' FAIL');
  console.log('=========================================');
  if (failed > 0) process.exit(1);
}

main();
