/* Saatiril Desktop — renderer logic.
 * Berkomunikasi dengan main process via window.saatiril (preload bridge).
 * Tidak ada require/import — murni browser script (contextIsolation). */

(function () {
  'use strict';

  var saatiril = window.saatiril;

  // ── Elemen ──
  var el = {
    statusCard: document.getElementById('status-card'),
    stateLabel: document.getElementById('state-label'),
    stateMsg: document.getElementById('state-msg'),
    stateHint: document.getElementById('state-hint'),
    btnConnect: document.getElementById('btn-connect'),
    btnDisconnect: document.getElementById('btn-disconnect'),
    btnDemo: document.getElementById('btn-demo'),
    btnCapture: document.getElementById('btn-capture'),
    btnFolder: document.getElementById('btn-folder'),
    btnOpenFolder: document.getElementById('btn-open-folder'),
    camLabel: document.getElementById('cam-label'),
    folderPath: document.getElementById('folder-path'),
    gallery: document.getElementById('gallery'),
    galleryEmpty: document.getElementById('gallery-empty'),
    log: document.getElementById('log'),
    statPhotos: document.getElementById('stat-photos'),
    statMb: document.getElementById('stat-mb'),
    statLast: document.getElementById('stat-last'),
  };

  var photoCount = 0;
  var totalBytes = 0;
  var logCount = 0;

  // ── Log ──
  function log(msg, cls) {
    logCount++;
    var t = new Date();
    var hh = String(t.getHours()).padStart(2, '0');
    var mm = String(t.getMinutes()).padStart(2, '0');
    var ss = String(t.getSeconds()).padStart(2, '0');
    var line = document.createElement('div');
    line.innerHTML = '<span class="t">' + hh + ':' + mm + ':' + ss + '</span>' +
      '<span class="' + (cls || '') + '">' + escapeHtml(msg) + '</span>';
    el.log.appendChild(line);
    // Batasi jumlah baris agar DOM ringan
    while (el.log.childElementCount > 300) el.log.removeChild(el.log.firstChild);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Status ──
  function renderState(st) {
    el.statusCard.dataset.state = st.state;
    el.stateLabel.textContent = st.label || stateTitle(st.state);
    el.stateMsg.innerHTML = st.message || '';
    if (st.hint) {
      el.stateHint.hidden = false;
      el.stateHint.textContent = '💡 ' + st.hint;
    } else {
      el.stateHint.hidden = true;
    }
    var ready = st.state === 'READY';
    el.btnCapture.disabled = !ready;
    el.btnConnect.hidden = ready;
    el.btnDisconnect.hidden = !ready;
    el.camLabel.textContent = ready && st.label ? st.label : '—';
  }

  function stateTitle(state) {
    var map = {
      DISCONNECTED: 'Kamera tidak terdeteksi',
      DETECTED: 'Kamera terdeteksi',
      CONNECTING: 'Menghubungkan…',
      READY: 'Terhubung — Mode Tether',
      WRONG_MODE: 'Mode USB kamera salah',
      ERROR: 'Gagal terhubung',
    };
    return map[state] || state;
  }

  // ── Galeri ──
  function addPhoto(photo) {
    photoCount++;
    totalBytes += photo.sizeBytes;
    el.statPhotos.textContent = String(photoCount);
    el.statMb.textContent = (totalBytes / 1048576).toFixed(1);
    var t = new Date();
    el.statLast.textContent =
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');

    if (el.galleryEmpty && el.galleryEmpty.parentNode) {
      el.gallery.removeChild(el.galleryEmpty);
    }
    var cell = document.createElement('div');
    cell.className = 'thumb';
    var img = document.createElement('img');
    // Muat dari disk via file:// → data: tidak aman; pakai protocol khusus? Paling sederhana:
    // file:// diblokir default; kita baca ulang lewat openPath saat klik, thumbnail = placeholder.
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgThumb(photo.filename));
    img.alt = photo.filename;
    var cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = photo.filename + ' · ' + (photo.sizeBytes / 1024).toFixed(0) + ' KB';
    cell.appendChild(img);
    cell.appendChild(cap);
    cell.title = 'Buka folder penyimpanan';
    cell.addEventListener('click', function () {
      saatiril.openPath(photo.path);
    });
    el.gallery.insertBefore(cell, el.gallery.firstChild);
  }

  function svgThumb(name) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="148" height="111">' +
      '<rect width="100%" height="100%" fill="#3b2263"/>' +
      '<circle cx="74" cy="50" r="22" fill="none" stroke="#d4af37" stroke-width="3"/>' +
      '<path d="M60 86h28" stroke="#06b6d4" stroke-width="3" stroke-linecap="round"/>' +
      '<text x="74" y="100" font-size="7" fill="#c4b5fd" text-anchor="middle" font-family="monospace">' +
      escapeXml(name.slice(0, 22)) + '</text></svg>';
  }

  function escapeXml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  // ── Events dari main ──
  saatiril.onState(renderState);
  saatiril.onPhoto(addPhoto);
  saatiril.onError(function (err) {
    log(err.message, 'err');
  });
  saatiril.onLog(function (l) {
    log(l.msg, 'sys');
  });

  // ── Aksi user ──
  el.btnConnect.addEventListener('click', function () {
    log('Mencari kamera PTP…');
    saatiril.connect().then(function (r) {
      log('Connect → ' + r.state + (r.label ? ' (' + r.label + ')' : ''), r.state === 'READY' ? 'ok' : '');
    }).catch(function (e) {
      log('Connect gagal: ' + e.message, 'err');
    });
  });

  el.btnDisconnect.addEventListener('click', function () {
    saatiril.disconnect().then(function () {
      log('Kamera diputuskan.');
    });
  });

  el.btnDemo.addEventListener('click', function () {
    log('Mode demo aktif — kamera Sony α7 IV tiruan (tanpa hardware).', 'sys');
    saatiril.demo().then(function (r) {
      log('Demo → ' + r.state + ' (' + r.label + ')', r.state === 'DEMO READY' ? 'ok' : 'ok');
    }).catch(function (e) {
      log('Demo gagal: ' + e.message, 'err');
    });
  });

  el.btnCapture.addEventListener('click', function () {
    el.btnCapture.disabled = true;
    log('Remote shutter: half-press AF → full-press…');
    saatiril.capture().then(function (r) {
      log('Shutter OK (handle ' + (r.handle === null ? 'via event' : r.handle) + ')', 'ok');
    }).catch(function (e) {
      log('Capture gagal: ' + e.message, 'err');
    }).finally(function () {
      // Re-enable saat state READY berikutnya (atau langsung bila masih READY)
      saatiril.status().then(function (st) {
        if (st.state === 'READY') el.btnCapture.disabled = false;
      });
    });
  });

  el.btnFolder.addEventListener('click', function () {
    saatiril.chooseFolder().then(function (r) {
      el.folderPath.textContent = r.folder;
      log('Folder penyimpanan: ' + r.folder, 'sys');
    });
  });

  el.btnOpenFolder.addEventListener('click', function () {
    var f = currentFolder();
    if (f) saatiril.openPath(f);
  });
  function currentFolder() {
    return el.folderPath.textContent === '…' ? '' : el.folderPath.textContent;
  }

  // ── Init ──
  saatiril.getFolder().then(function (r) {
    el.folderPath.textContent = r.folder;
  });
  saatiril.status().then(renderState);
  log('Saatiril Desktop siap. Tekan "Hubungkan" bila kamera sudah tertancap, atau "Mode Demo" untuk mencoba tanpa kamera.', 'sys');
})();
