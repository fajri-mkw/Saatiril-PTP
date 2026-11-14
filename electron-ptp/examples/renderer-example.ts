/**
 * Contoh renderer — kartu status tether DSLR untuk halaman operator Electron.
 * Ini paritas UI dengan kartu PTP di OperatorScreen.kt (Android):
 * badge "Mode: PC Remote / Tether", jumlah foto masuk, peringatan mode salah.
 *
 * Tempel blok HTML berikut ke operator page, lalu jalankan initPtpCard().
 * Foto yang diterima diteruskan ke pipeline foto yang sudah ada
 * (submitPhotoToSocket dsb.) — tidak perlu mengubah backend sama sekali.
 */

export function initPtpCard(opts: {
  onPhoto?: (dataUrl: string, filename: string) => void;
}): void {
  const ptp = (window as any).satsetPtp;
  if (!ptp) return; // bridge tidak tersedia — tetap pakai webcam/capture card

  let ingested = 0;

  // Buat elemen kartu (atau tempel ke elemen yang sudah ada #ptp-card)
  let card = document.getElementById('ptp-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'ptp-card';
    card.style.cssText =
      'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;background:#000;color:#fff;font-family:sans-serif;z-index:5';
    const video = document.querySelector('video');
    (video?.parentElement ?? document.body).appendChild(card);
  }
  card.innerHTML = `
    <div style="font-size:44px">📷</div>
    <div id="ptp-status" style="font-size:17px;font-weight:700;margin-top:8px;text-align:center">
      Kamera tidak terdeteksi — tancapkan kabel USB &amp; nyalakan kamera
    </div>
    <div id="ptp-sub" style="font-size:12px;opacity:.65;margin-top:6px;text-align:center"></div>
    <div id="ptp-hint" style="font-size:12px;color:#fbbf24;margin-top:8px;text-align:center"></div>
  `;

  const statusEl = card.querySelector<HTMLElement>('#ptp-status')!;
  const subEl = card.querySelector<HTMLElement>('#ptp-sub')!;
  const hintEl = card.querySelector<HTMLElement>('#ptp-hint')!;

  ptp.onState((st: { state: string; label: string; message: string; hint?: string }) => {
    if (st.state === 'READY') {
      statusEl.textContent = st.label || 'Kamera DSLR Terhubung';
      statusEl.style.color = '#4ade80';
      subEl.textContent = ingested > 0
        ? `Mode: PC Remote / Tether • ${ingested} foto masuk otomatis`
        : 'Mode: PC Remote / Tether — foto otomatis masuk saat shutter ditekan';
      hintEl.textContent = '';
    } else if (st.state === 'WRONG_MODE') {
      statusEl.textContent = st.message;
      statusEl.style.color = '#f87171';
      subEl.textContent = "Ganti setelan USB di menu kamera, lalu cabut-pasang kabel.";
      hintEl.textContent =
        "Sony → 'PC Remote' • Canon/Nikon → 'PTP' (Wi-Fi OFF) • Fujifilm → 'USB Tether Shooting Auto'";
    } else {
      statusEl.textContent = st.message;
      statusEl.style.color = '#fff';
      subEl.textContent = '';
      hintEl.textContent = '';
    }
  });

  ptp.onPhoto((photo: { base64: string; filename: string; sizeBytes: number }) => {
    ingested++;
    const dataUrl = `data:image/jpeg;base64,${photo.base64}`;
    subEl.textContent = `Mode: PC Remote / Tether • ${ingested} foto masuk otomatis`;
    // Teruskan ke pipeline yang sudah ada (crop → filter → overlay → socket)
    opts.onPhoto?.(dataUrl, photo.filename);
  });

  ptp.onError((err: { name: string; message: string }) => {
    console.warn('[ptp]', err.name, err.message);
  });

  // Tombol AMBIL FOTO yang sudah ada cukup memanggil ptp.capture()
  // saat engine DSLR aktif (prioritas DSLR > capture card > webcam).
  void ptp.connect();
}
