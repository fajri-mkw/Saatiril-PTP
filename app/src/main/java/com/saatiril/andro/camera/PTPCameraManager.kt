package com.saatiril.andro.camera

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Base64
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * ═════════════════════════════════════════════════════════════════════════
 * PTP Camera Manager — v19 Direct USB Cable Tethering (SatsetMobile parity)
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ENGINE UNTUK KAMERA DSLR/MIRRORLESS YANG DISAMBUNGKAN LANGSUNG LEWAT
 * KABEL USB (OTG) — BUKAN capture card HDMI.
 *
 * Berbeda dari UVCCameraManager (yang membaca *video stream* dari UVC
 * capture card), manager ini berbicara **PTP/MTP (USB Still Image Class,
 * interface class 6)** langsung ke body kamera — persis seperti aplikasi
 * SatsetMobile: hubungkan kamera Sony / Canon / Nikon / Fujifilm dengan
 * kabel USB, foto yang diambil otomatis masuk ("Tethering Ingestion"),
 * dan aplikasi juga bisa memicu shutter dari layar.
 *
 * Perilaku yang ditiru dari SatsetMobile v2.8 ( hasil dekompilasi ):
 *  1. Deteksi kamera PTP berdasarkan Vendor ID (Sony 0x054C, Canon 0x04A9,
 *     Nikon 0x04B0, Fujifilm 0x04CB, Leica 0x04DA), deviceClass == 6,
 *     atau interface class 6/255 dengan endpoint bulk IN+OUT.
 *  2. Alur sesi: GetDeviceInfo → OpenSession(1) → (Sony: SDIOConnect
 *     1/2/3 + GetExtDeviceInfo + PriorityMode=Body + StoreDestination=PC+Card)
 *     → lepaskan state shutter agar tombol fisik body tetap bisa dipakai.
 *  3. "Tethering Ingestion Mode": loop event (endpoint interrupt / poll
 *     GetObjectHandles). Saat event ObjectAdded 0x4002 (shutter fisik
 *     ditekan fotografer) → GetObjectInfo → tunggu size>0 → GetObject →
 *     foto dikirim ke pipeline Saatiril sebagai base64 data URL.
 *  4. Remote shutter dari aplikasi:
 *     - Sony: SetControlDeviceB(0xD2C1 half-press AF) → (0xD2C2 full-press)
 *       → release — timeout 25 detik menunggu foto.
 *     - Generic (Canon/Nikon/Fujifilm): InitiateCapture(0,0).
 *  5. Auto-reconnect: attach/detach broadcast + polling UsbManager tiap 2s
 *     (fallback Android 14+), retry 3x pada kegagalan koneksi.
 *  6. Foto dinormalisasi: rotasi EXIF + downscale sisi terpanjang ≤ 2560px
 *     agar aman memori (24MP JPEG mentah bisa 96MB sebagai bitmap).
 *
 * PTP tidak menyediakan live preview — area preview menampilkan kartu
 * status tether (model kamera, jumlah foto masuk, instruksi).
 */
class PTPCameraManager(private val context: Context) {

    // ═══════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════

    companion object {
        private const val TAG = "PTPCameraManager"

        const val ACTION_PTP_USB_PERMISSION = "com.saatiril.andro.PTP_USB_PERMISSION"

        // ── Standard PTP opcodes (PIMA 15740) ──
        private const val OP_GET_DEVICE_INFO = 0x1001
        private const val OP_OPEN_SESSION = 0x1002
        private const val OP_CLOSE_SESSION = 0x1003
        private const val OP_GET_OBJECT_HANDLES = 0x1007
        private const val OP_GET_OBJECT_INFO = 0x1008
        private const val OP_GET_OBJECT = 0x1009
        private const val OP_INITIATE_CAPTURE = 0x100E

        // ── Sony PMR/SDIO extensions (seperti SatsetMobile) ──
        private const val OP_SONY_SDIO_CONNECT = 0x9201
        private const val OP_SONY_GET_EXT_DEVICE_INFO = 0x9202
        private const val OP_SONY_SET_CONTROL_DEVICE_A = 0x9205
        private const val OP_SONY_SET_CONTROL_DEVICE_B = 0x9207
        private const val OP_SONY_QUERY_9209 = 0x9209
        private const val OP_SONY_GET_PARTIAL_LARGE_OBJECT = 0x9211

        // Sony control codes (SetControlDeviceB)
        private const val SONY_CONTROL_HALF_PRESS = 0xD2C1  // 53953 — AF / half press
        private const val SONY_CONTROL_FULL_PRESS = 0xD2C2  // 53954 — shutter / full press

        // Sony device properties (SetControlDeviceA)
        private const val SONY_PROP_PRIORITY_MODE = 0xD25A        // 53850 — 0 = Body Priority
        private const val SONY_PROP_STORE_DESTINATION = 0xD222    // 53794 — 17 = PC+Card

        // Sony pseudo-handle untuk "objek terakhir yang diambil"
        private const val SONY_LAST_OBJECT_HANDLE = 0xFFFFC001.toInt()

        // ── PTP events & responses ──
        private const val EVENT_OBJECT_ADDED = 0x4002
        private const val EVENT_CAPTURE_COMPLETE = 0x400D
        private const val RESP_OK = 0x2001

        // Object format codes
        private const val FORMAT_JPEG = 0x3801
        private const val FORMAT_UNDEFINED = 0x3000

        // ── Known camera Vendor IDs (DECIMAL — sesuai device_filter.xml) ──
        private const val VENDOR_CANON = 1193      // 0x04A9
        private const val VENDOR_SONY = 1356       // 0x054C
        private const val VENDOR_NIKON = 1200      // 0x04B0
        private const val VENDOR_FUJIFILM = 1227   // 0x04CB
        private const val VENDOR_LEICA = 1242      // 0x04DA

        private const val USB_CLASS_PTP = 6        // Still Image / PTP
        private const val USB_CLASS_VENDOR = 255

        private const val POLLING_INTERVAL_MS = 2000L        // fallback poll tiap 2 dtk
        private const val INGEST_INTERRUPT_TIMEOUT_MS = 100  // per-read interrupt timeout
        private const val INGEST_IDLE_SLEEP_MS = 50L
        private const val OBJECT_INFO_WAIT_MS = 5000L        // tunggu file ditulis ke buffer
        private const val CAPTURE_TIMEOUT_MS = 25000L        // timeout remote shutter (25 dtk)
        private const val MIN_PHOTO_BYTES = 2048             // validasi minimal JPEG
        private const val MAX_INGEST_EDGE_PX = 2560          // downscale sisi terpanjang

        private fun vendorName(vid: Int): String = when (vid) {
            VENDOR_SONY -> "Sony"
            VENDOR_CANON -> "Canon"
            VENDOR_NIKON -> "Nikon"
            VENDOR_FUJIFILM -> "Fujifilm"
            VENDOR_LEICA -> "Leica"
            else -> "PTP"
        }

        /**
         * Petunjuk pengaturan mode USB per-merek — persis string tutorial
         * SatsetMobile v2.8:
         * "Pengaturan mode kamera: Sony ('PC Remote'), Canon & Nikon ('PTP' /
         * Wi-Fi OFF), atau Fujifilm ('USB Tether Shooting Auto')."
         */
        fun usbModeHint(vid: Int): String = when (vid) {
            VENDOR_SONY -> "Mode USB: 'PC Remote' (atau 'Auto')"
            VENDOR_CANON -> "Mode USB: 'PTP' + Wi-Fi OFF"
            VENDOR_NIKON -> "Mode USB: 'PTP' + Wi-Fi OFF"
            VENDOR_FUJIFILM -> "Mode USB: 'USB Tether Shooting Auto'"
            else -> "Mode USB: PTP / PC Remote"
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Public state (paritas dengan UVCCameraManager / Camera2Manager)
    // ═══════════════════════════════════════════════════════════

    enum class PtpState {
        DISCONNECTED,   // tidak ada kamera
        DETECTED,       // kamera terpasang, belum minta izin
        CONNECTING,     // sesi PTP sedang dibuka
        READY,          // tether aktif — ingestion berjalan
        WRONG_MODE,     // kamera nyala sebagai Mass Storage dsb. — mode USB harus diganti
        ERROR           // gagal setelah retry
    }

    /** Pesan status human-friendly untuk kartu tether (meniru SatsetMobile). */
    fun statusMessage(st: PtpState): String = when (st) {
        PtpState.DISCONNECTED -> "Kamera tidak terdeteksi — tancapkan kabel OTG & nyalakan kamera"
        PtpState.DETECTED -> "Menunggu izin USB…"
        PtpState.CONNECTING -> "Menghubungkan kamera…"
        PtpState.READY -> "Terhubung — Mode Tether"
        PtpState.WRONG_MODE ->
            "Mode USB kamera salah. Di menu kamera, set USB Connection ke 'PC Remote' / 'PTP' / 'Tether'."
        PtpState.ERROR -> "Gagal terhubung — cek kabel & coba sambung ulang"
    }

    private val _state = MutableStateFlow(PtpState.DISCONNECTED)
    val state: StateFlow<PtpState> = _state.asStateFlow()

    private val _cameraLabel = MutableStateFlow("")
    val cameraLabel: StateFlow<String> = _cameraLabel.asStateFlow()

    private val _ingestedCount = MutableStateFlow(0)
    val ingestedCount: StateFlow<Int> = _ingestedCount.asStateFlow()

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    private val _cameraType = MutableStateFlow("none")
    val cameraType: StateFlow<String> = _cameraType.asStateFlow()

    private val _currentCameraId = MutableStateFlow("")
    val currentCameraIdFlow: StateFlow<String> = _currentCameraId.asStateFlow()

    private val _availableCameras = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    val availableCameras: StateFlow<List<Pair<String, String>>> = _availableCameras.asStateFlow()

    private val _isUSBCamera = MutableStateFlow(true)
    val isUSBCamera: StateFlow<Boolean> = _isUSBCamera.asStateFlow()

    /** Dipanggil tiap foto berhasil diingest dari body kamera (base64 data URL). */
    var onPhotoIngested: ((String?) -> Unit)? = null

    // ═══════════════════════════════════════════════════════════
    // Internals
    // ═══════════════════════════════════════════════════════════

    private val mainHandler = Handler(Looper.getMainLooper())
    private var ioThread: HandlerThread? = null
    private var ioHandler: Handler? = null

    private var usbReceiver: BroadcastReceiver? = null
    private var usbPollingRunnable: Runnable? = null

    private val discoveredDevices = mutableMapOf<String, UsbDevice>()
    private var currentDevice: UsbDevice? = null
    private var transport: PtpTransport? = null
    private var ingestionThread: Thread? = null
    private val ingestionRunning = AtomicBoolean(false)

    private var vendorId = 0
    private var cameraModel = ""
    private var retryCount = 0
    private var isInitialized = false
    private var isDestroying = false

    /** Callback remote-shutter yang sedang menunggu foto. */
    @Volatile private var pendingCaptureCallback: ((String?) -> Unit)? = null
    private var pendingCaptureCallbackRef = java.lang.ref.WeakReference<((String?) -> Unit)?>(null)

    // Handles yang sudah dikenal — untuk diff poll GetObjectHandles
    private val knownHandles = mutableSetOf<Int>()

    // ═══════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════

    fun init() {
        if (isInitialized) {
            Log.i(TAG, "init: already initialized, skipping")
            return
        }
        isInitialized = true
        isDestroying = false

        Log.i(TAG, "═══════════════════════════════════════════════════")
        Log.i(TAG, "init: PTP Direct Tether (SatsetMobile parity)")
        Log.i(TAG, "═══════════════════════════════════════════════════")

        ioThread = HandlerThread("PTP-IO").also { it.start() }
        ioHandler = Handler(ioThread!!.looper)

        registerUsbReceiver()
        enumerateConnectedDevices()
        startUsbPolling()
    }

    fun destroy() {
        Log.i(TAG, "destroy: tearing down PTP camera")
        isDestroying = true
        isInitialized = false
        stopUsbPolling()
        unregisterUsbReceiver()
        stopIngestion()

        ioHandler?.post {
            closeSessionAndTransport()
        }
        try {
            ioThread?.quitSafely()
            ioThread?.join(2000)
        } catch (_: Exception) {}
        ioThread = null
        ioHandler = null

        discoveredDevices.clear()
        currentDevice = null
        transport = null
        pendingCaptureCallback = null
        _state.value = PtpState.DISCONNECTED
        _isConnected.value = false
        _cameraType.value = "none"
        _availableCameras.value = emptyList()
        _ingestedCount.value = 0
    }

    // ═══════════════════════════════════════════════════════════
    // USB device detection (attach/detach + permission + poll fallback)
    // ═══════════════════════════════════════════════════════════

    private fun usbManager(): UsbManager? =
        context.getSystemService(Context.USB_SERVICE) as? UsbManager

    /**
     * Apakah device ini kamera PTP? (logika identik SatsetMobile)
     * VID dikenal → deviceClass == 6 → interface class 6/255 dengan bulk IN+OUT.
     */
    fun isPtpDevice(device: UsbDevice): Boolean {
        if (device.vendorId in intArrayOf(VENDOR_CANON, VENDOR_SONY, VENDOR_NIKON, VENDOR_FUJIFILM, VENDOR_LEICA)) {
            Log.i(TAG, "PTP camera detected by vendor ID: 0x${Integer.toHexString(device.vendorId)} (${device.deviceName})")
            return true
        }
        if (device.deviceClass == USB_CLASS_PTP) {
            Log.i(TAG, "PTP camera detected by deviceClass=6 (${device.deviceName})")
            return true
        }
        try {
            for (i in 0 until device.interfaceCount) {
                val iface = device.getInterface(i)
                if (iface.interfaceClass == USB_CLASS_PTP && hasBulkInOut(iface)) return true
                // Beberapa firmware meng-expose PTP di class 255 (vendor-specific)
                if (iface.interfaceClass == USB_CLASS_VENDOR && hasBulkInOut(iface) &&
                    device.interfaceCount <= 2) return true
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error checking interfaces for ${device.deviceName}: ${e.message}")
        }
        return false
    }

    private fun hasBulkInOut(iface: UsbInterface): Boolean {
        var hasIn = false
        var hasOut = false
        for (i in 0 until iface.endpointCount) {
            val ep = iface.getEndpoint(i)
            if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                if (ep.direction == UsbConstants.USB_DIR_IN) hasIn = true
                if (ep.direction == UsbConstants.USB_DIR_OUT) hasOut = true
            }
        }
        return hasIn && hasOut
    }

    private fun registerUsbReceiver() {
        if (usbReceiver != null) return
        usbReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                        @Suppress("DEPRECATION")
                        val device = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
                        Log.i(TAG, "USB Device attached via Intent: ${device?.deviceName}")
                        device?.let { handleDeviceAttached(it) }
                    }
                    UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                        @Suppress("DEPRECATION")
                        val device = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
                        Log.i(TAG, "USB device detached: ${device?.deviceName}")
                        device?.let { handleDeviceDetached(it) }
                    }
                    ACTION_PTP_USB_PERMISSION -> {
                        synchronized(this) {
                            @Suppress("DEPRECATION")
                            val device = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
                            val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                            Log.i(TAG, "USB permission result: device=${device?.deviceName}, granted=$granted")
                            if (granted && device != null) {
                                connectDevice(device)
                            } else if (device != null) {
                                _state.value = PtpState.DETECTED
                            }
                        }
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(ACTION_PTP_USB_PERMISSION)
        }
        // Android 13+ wajib RECEIVER_NOT_EXPORTED untuk receiver internal
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(usbReceiver, filter)
        }
        Log.i(TAG, "USB BroadcastReceiver registered")
    }

    private fun unregisterUsbReceiver() {
        try {
            usbReceiver?.let { context.unregisterReceiver(it) }
        } catch (_: Exception) {}
        usbReceiver = null
    }

    /** Enumerasi device yang sudah menancap saat app start. */
    private fun enumerateConnectedDevices() {
        val mgr = usbManager() ?: return
        for (device in mgr.deviceList.values) {
            if (isPtpDevice(device)) {
                Log.i(TAG, "★ Already-connected PTP camera found: ${device.deviceName}")
                handleDeviceAttached(device)
            }
        }
    }

    /** Fallback polling 2 dtk — untuk Android 14+ yang registerReceiver-nya gagal. */
    private fun startUsbPolling() {
        stopUsbPolling()
        usbPollingRunnable = object : Runnable {
            override fun run() {
                if (isDestroying) return
                try {
                    pollUsbDevices()
                } catch (e: Exception) {
                    Log.e(TAG, "USB polling error: ${e.message}")
                }
                usbPollingRunnable?.let { mainHandler.postDelayed(it, POLLING_INTERVAL_MS) }
            }
        }
        usbPollingRunnable?.let { mainHandler.postDelayed(it, POLLING_INTERVAL_MS) }
        Log.i(TAG, "USB polling fallback started (every ${POLLING_INTERVAL_MS}ms)")
    }

    private fun stopUsbPolling() {
        usbPollingRunnable?.let { mainHandler.removeCallbacks(it) }
        usbPollingRunnable = null
    }

    private fun pollUsbDevices() {
        val mgr = usbManager() ?: return
        val present = mgr.deviceList

        // Device baru
        for (device in present.values) {
            if (discoveredDevices.containsKey(device.deviceName)) continue
            if (isPtpDevice(device)) {
                Log.i(TAG, "★ Polling found PTP camera (reattached): ${device.deviceName}")
                handleDeviceAttached(device)
            }
        }
        // Device dicabut sejak poll terakhir
        val removed = discoveredDevices.keys.filter { it !in present.keys }
        for (key in removed) {
            discoveredDevices.remove(key)?.let {
                Log.i(TAG, "Polling detected USB disconnect: ${it.deviceName}")
                handleDeviceDetached(it)
            }
        }
        updateAvailableCameras()
    }

    // ═══════════════════════════════════════════════════════════
    // Attach / detach / permission / connect
    // ═══════════════════════════════════════════════════════════

    private fun handleDeviceAttached(device: UsbDevice) {
        if (isDestroying) return
        discoveredDevices[device.deviceName] = device
        updateAvailableCameras()

        val mgr = usbManager() ?: return
        if (mgr.hasPermission(device)) {
            connectDevice(device)
        } else {
            _state.value = PtpState.DETECTED
            requestUsbPermission(device)
        }
    }

    private fun handleDeviceDetached(device: UsbDevice) {
        discoveredDevices.remove(device.deviceName)
        updateAvailableCameras()
        if (currentDevice?.deviceName == device.deviceName) {
            Log.w(TAG, "PTP camera detached while in use — USB teardown: ending camera session")
            ioHandler?.post { closeSessionAndTransport() }
            stopIngestion()
            currentDevice = null
            retryCount = 0
            _isConnected.value = false
            _cameraType.value = "none"
            _state.value = PtpState.DISCONNECTED
        }
    }

    private fun requestUsbPermission(device: UsbDevice) {
        val mgr = usbManager() ?: run {
            Log.e(TAG, "UsbManager not available!")
            return
        }
        try {
            if (mgr.hasPermission(device)) {
                connectDevice(device)
                return
            }
            val flags = if (android.os.Build.VERSION.SDK_INT >= 31) {
                android.app.PendingIntent.FLAG_MUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
            } else {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
            }
            val pi = android.app.PendingIntent.getBroadcast(
                context, 0,
                Intent(ACTION_PTP_USB_PERMISSION).apply {
                    setPackage(context.packageName)
                    putExtra(UsbManager.EXTRA_DEVICE, device)
                },
                flags
            )
            mgr.requestPermission(device, pi)
            Log.i(TAG, "Requesting USB permission for ${device.deviceName}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to request USB permission: ${e.message}")
        }
    }

    /** Buka sesi PTP ke device (dijalankan di IO thread). */
    private fun connectDevice(device: UsbDevice) {
        if (isDestroying) return
        if (currentDevice?.deviceName == device.deviceName && _state.value == PtpState.READY) {
            Log.i(TAG, "connectDevice() -> camera sudah Ready")
            return
        }
        currentDevice = device
        vendorId = device.vendorId
        _state.value = PtpState.CONNECTING
        _cameraType.value = "external"

        ioHandler?.post {
            Log.i(TAG, "connectCamera() -> Membuka koneksi kamera melalui USB.")
            try {
                openTransport(device)
                openPtpSession()
                // ── Vendor-specific init ──
                when (vendorId) {
                    VENDOR_SONY -> sonyInit()
                }
                // Lepaskan state half/full-press yang mungkin nyangkut,
                // agar tombol shutter fisik di body tetap aktif.
                releaseShutterStates()
                retryCount = 0
                _isConnected.value = true
                _state.value = PtpState.READY
                updateAvailableCameras()
                startIngestion()
                Log.i(TAG, "═══════════════════════════════════════════════════")
                Log.i(TAG, "★ USB camera connected and Ready — Tethering Ingestion Mode")
                Log.i(TAG, "═══════════════════════════════════════════════════")
            } catch (e: WrongUsbModeException) {
                // Mode USB salah (Mass Storage) — retry tidak akan menolong;
                // user harus ganti setelan di menu kamera (mis. Sony → PC Remote).
                Log.e(TAG, "Camera USB mode is wrong: ${e.message}")
                closeSessionAndTransport()
                retryCount = 0
                _state.value = PtpState.WRONG_MODE
            } catch (e: Exception) {
                Log.e(TAG, "Connection error with camera attached: ${e.message}", e)
                closeSessionAndTransport()
                if (retryCount < 3) {
                    retryCount++
                    Log.w(TAG, "Connection error with camera attached — auto-retry $retryCount/3")
                    mainHandler.postDelayed({
                        if (!isDestroying && currentDevice != null) connectDevice(currentDevice!!)
                    }, 1000L)
                } else {
                    _state.value = PtpState.ERROR
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Transport & session (IO thread)
    // ═══════════════════════════════════════════════════════════

    private fun openTransport(device: UsbDevice) {
        val mgr = usbManager() ?: throw IllegalStateException("UsbManager null")
        val connection = mgr.openDevice(device)
            ?: throw IllegalStateException("openDevice() gagal — kabel OTG / izin USB?")

        // ── Deteksi mode USB salah (meniru SatsetMobile) ──
        // Kamera Sony/Canon/Nikon yang diset "Mass Storage" (atau Auto yang jatuh
        // ke MSC) mengekspos interface class 8 tanpa interface PTP class 6.
        // Pesan SatsetMobile: "Camera USB mode is wrong. In the camera menu,
        // set USB Connection to 'PC Remote' or 'Auto'."
        if (findPtpInterface(device) == null && hasMassStorageInterface(device)) {
            Log.e(TAG, "Camera USB mode is wrong (Mass Storage terdeteksi, interface PTP tidak ada)")
            throw WrongUsbModeException(
                "Mode USB kamera salah (Mass Storage). Set USB Connection ke 'PC Remote'/'PTP'/'Tether'."
            )
        }

        val iface = findPtpInterface(device)
            ?: throw IllegalStateException("Interface PTP (class 6) tidak ditemukan")
        if (!connection.claimInterface(iface, true)) {
            throw IllegalStateException("claimInterface() gagal")
        }
        transport = PtpTransport(connection, iface).also { it.open() }
        Log.i(TAG, "PTP transport opened: ${device.deviceName} (${iface.name})")
    }

    /** Exception khusus: kamera menyala di mode USB yang salah (bukan PTP). */
    class WrongUsbModeException(message: String) : Exception(message)

    /** Interface PTP: class 6 dengan bulk IN+OUT; fallback interface pertama. */
    private fun findPtpInterface(device: UsbDevice): UsbInterface? {
        var fallback: UsbInterface? = null
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.interfaceClass == USB_CLASS_PTP && hasBulkInOut(iface)) return iface
            if (fallback == null && hasBulkInOut(iface)) fallback = iface
        }
        return fallback ?: (if (device.interfaceCount > 0) device.getInterface(0) else null)
    }

    /**
     * True bila device hanya mengekspos interface Mass Storage (class 8)
     * tanpa PTP — berarti pengaturan USB di menu kamera masih MSC.
     */
    private fun hasMassStorageInterface(device: UsbDevice): Boolean {
        var msc = false
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.interfaceClass == USB_CLASS_PTP) return false
            if (iface.interfaceClass == 8) msc = true   // 8 = Mass Storage
        }
        return msc
    }

    private fun openPtpSession() {
        val t = transport ?: throw IllegalStateException("transport null")

        // GetDeviceInfo — nama model kamera
        val info = t.transactData(OP_GET_DEVICE_INFO, IntArray(0))
        if (info.code == RESP_OK && info.data != null) {
            parseModelFromDeviceInfo(info.data)
        } else {
            Log.w(TAG, "GetDeviceInfo gagal: 0x${Integer.toHexString(info.code)}")
        }

        // OpenSession(session=1) — transactionId pertama harus 0
        val open = t.transact(OP_OPEN_SESSION, intArrayOf(1))
        if (open.code != RESP_OK) {
            // Mungkin ada sesi stale — CloseSession lalu ulang (trik SatsetMobile)
            Log.w(TAG, "OpenSession pertama gagal (0x${Integer.toHexString(open.code)}) — mencoba stale-session close")
            try { t.transact(OP_CLOSE_SESSION, intArrayOf(1)) } catch (_: Exception) {}
            val retry = t.transact(OP_OPEN_SESSION, intArrayOf(1))
            if (retry.code != RESP_OK) {
                throw IllegalStateException("OpenSession gagal: 0x${Integer.toHexString(retry.code)}")
            }
        }
        Log.i(TAG, "PTP session opened (session=1, model=$cameraModel)")

        // Seed handle yang sudah ada agar ingestion hanya melihat foto BARU
        seedKnownHandles()
    }

    private fun closeSessionAndTransport() {
        val t = transport ?: return
        try {
            t.transact(OP_CLOSE_SESSION, intArrayOf(1))
            Log.i(TAG, "PTP CloseSession(session=1): OK")
        } catch (e: Exception) {
            Log.w(TAG, "Error closing session: ${e.message}")
        }
        try { t.close() } catch (_: Exception) {}
        transport = null
    }

    /** Parse model + serial dari dataset GetDeviceInfo. */
    private fun parseModelFromDeviceInfo(data: ByteArray) {
        try {
            val bb = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
            bb.position(bb.position() + 8)              // StandardVersion(u16) + VendorExtensionID(u32)
            bb.short                                    // VendorExtensionVersion
            skipPtpString(bb)                           // VendorExtensionDesc
            bb.short                                    // FunctionalMode
            skipAarray(bb)                              // OperationsSupported
            skipAarray(bb)                              // EventsSupported
            skipAarray(bb)                              // DevicePropsSupported
            skipAarray(bb)                              // CaptureFormats
            skipAarray(bb)                              // ImageFormats
            val manufacturer = readPtpString(bb)
            val model = readPtpString(bb)
            val ver = readPtpString(bb)
            val serial = readPtpString(bb)
            cameraModel = model.ifBlank { vendorName(vendorId) }
            _cameraLabel.value = buildString {
                append(vendorName(vendorId))
                if (model.isNotBlank()) append(" $model")
                if (ver.isNotBlank()) append(" $ver")
            }
            Log.i(TAG, "Camera model identified: $manufacturer $cameraModel, Serial: $serial")
        } catch (e: Exception) {
            Log.w(TAG, "Error parsing device info: ${e.message}")
            cameraModel = vendorName(vendorId)
            _cameraLabel.value = vendorName(vendorId)
        }
    }

    private fun skipPtpString(bb: ByteBuffer) {
        if (bb.remaining() < 1) return
        val n = bb.get().toInt() and 0xFF
        for (i in 0 until n) {
            if (bb.remaining() >= 2) bb.short else break
        }
    }

    private fun readPtpString(bb: ByteBuffer): String {
        if (bb.remaining() < 1) return ""
        val n = bb.get().toInt() and 0xFF
        val sb = StringBuilder()
        for (i in 0 until n) {
            if (bb.remaining() >= 2) {
                val c = bb.short.toInt()
                if (c == 0) break
                sb.append(c.toChar())
            } else break
        }
        return sb.toString()
    }

    private fun skipAarray(bb: ByteBuffer) {
        if (bb.remaining() < 4) return
        val n = bb.int
        for (i in 0 until n) {
            if (bb.remaining() >= 2) bb.short else break
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Sony extensions (alur SatsetMobile "sonycamera")
    // ═══════════════════════════════════════════════════════════

    /**
     * Init Sony SDIO + set mode remote:
     * - SDIOConnect 1, 2, 3 (0x9201)
     * - GetExtDeviceInfo (0x9202, mode 200 → fallback 300)
     * - PriorityMode = 0 (Body Priority) → tombol fisik tetap aktif
     * - StillImageStoreDestination = 17 (PC+Card) → foto masuk app DAN kartu
     */
    private fun sonyInit() {
        val t = transport ?: return
        Log.i(TAG, "Initializing Sony SDIO extension...")
        try {
            Log.i(TAG, "SDIOConnect(1): ${t.transact(OP_SONY_SDIO_CONNECT, intArrayOf(1, 0, 0)).ok}")
            Log.i(TAG, "SDIOConnect(2): ${t.transact(OP_SONY_SDIO_CONNECT, intArrayOf(2, 0, 0)).ok}")
            val ext = t.transactData(OP_SONY_GET_EXT_DEVICE_INFO, intArrayOf(200))
            if (!ext.ok || ext.data == null || ext.data.isEmpty()) {
                Log.i(TAG, "GetExtDeviceInfo(0xC8) non-success, trying mode 300 (0x12C)...")
                t.reset()
                t.transactData(OP_SONY_GET_EXT_DEVICE_INFO, intArrayOf(300))
            }
            try {
                Log.i(TAG, "SDIOConnect(3): ${t.transact(OP_SONY_SDIO_CONNECT, intArrayOf(3, 0, 0)).ok}")
            } catch (e: Exception) {
                Log.w(TAG, "SDIOConnect(3) warning (non-fatal): ${e.message}")
                t.reset()
            }
            try {
                t.transact(OP_SONY_QUERY_9209, IntArray(0))
            } catch (_: Exception) {}
        } catch (e: Exception) {
            Log.w(TAG, "Sony SDIO init partial failure (non-fatal): ${e.message}")
        }

        // PriorityMode = 0 (Body Priority) — fotografer tetap pegang kendali body
        setControlDeviceA(SONY_PROP_PRIORITY_MODE, byteArrayOf(0))
        Log.i(TAG, "Explicitly set Sony PriorityMode = 0 (Body Priority)")
        // StoreDestination = 17 (PC+Card) — foto tersimpan ke kartu DAN ke app
        setControlDeviceA(SONY_PROP_STORE_DESTINATION, byteArrayOf(17, 0))
        Log.i(TAG, "Explicitly set Sony StillImageStoreDestination = 17 (PC+Card)")
    }

    /** SetControlDeviceA(prop, payload u8/u16) — opcode Sony 0x9205. */
    private fun setControlDeviceA(prop: Int, payload: ByteArray): Boolean {
        val t = transport ?: return false
        return try {
            t.transactOut(OP_SONY_SET_CONTROL_DEVICE_A, intArrayOf(prop), payload).ok
        } catch (e: Exception) {
            Log.w(TAG, "SetControlDeviceA(0x${Integer.toHexString(prop)}) gagal: ${e.message}")
            false
        }
    }

    /** SetControlDeviceB(control, value u16) — opcode Sony 0x9207. */
    private fun setControlDeviceB(control: Int, value: Int): Boolean {
        val t = transport ?: return false
        val payload = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN)
            .putShort(value.toShort()).array()
        return try {
            t.transactOut(OP_SONY_SET_CONTROL_DEVICE_B, intArrayOf(control), payload).ok
        } catch (e: Exception) {
            Log.w(TAG, "SetControlDeviceB(0x${Integer.toHexString(control)}, $value) gagal: ${e.message}")
            false
        }
    }

    /** Lepaskan state half/full press — shutter fisik body tidak terkunci. */
    private fun releaseShutterStates() {
        if (vendorId == VENDOR_SONY) {
            try {
                setControlDeviceB(SONY_CONTROL_FULL_PRESS, 1)
                setControlDeviceB(SONY_CONTROL_HALF_PRESS, 1)
                Log.i(TAG, "Explicitly released shutter states — physical shutter on camera body unlocked")
            } catch (e: Exception) {
                Log.w(TAG, "Shutter release signal ignored by camera: ${e.message}")
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Tethering ingestion loop — "foto otomatis masuk"
    // ═══════════════════════════════════════════════════════════

    private fun startIngestion() {
        if (ingestionRunning.get()) return
        ingestionRunning.set(true)
        ingestionThread = Thread({
            Log.i(TAG, "CameraManager.start() - Tethering Ingestion Mode")
            var lastHandlePoll = 0L
            while (ingestionRunning.get() && !isDestroying) {
                try {
                    val t = transport
                    if (t == null) { Thread.sleep(200); continue }

                    // 1) Event dari interrupt endpoint (cepat — <200ms)
                    val event = t.pollInterrupt(INGEST_INTERRUPT_TIMEOUT_MS)
                    if (event != null) {
                        if (event.code == EVENT_OBJECT_ADDED && event.params.isNotEmpty()) {
                            Log.i(TAG, "Shutter event received from camera. ObjectAdded handle=0x${Integer.toHexString(event.params[0])}")
                            downloadAndDeliver(event.params[0])
                        }
                    }

                    // 2) Fallback: poll GetObjectHandles tiap 2 dtk
                    //    (kamera tanpa interrupt endpoint / event tidak keluar)
                    val now = System.currentTimeMillis()
                    if (now - lastHandlePoll >= POLLING_INTERVAL_MS) {
                        lastHandlePoll = now
                        pollObjectHandles(t)
                    }
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    Log.e(TAG, "Ingestion loop error: ${e.message}")
                    Thread.sleep(500)
                }
            }
            Log.i(TAG, "Camera body-shutter monitor ended")
        }, "PTP-Ingestion").also { it.start() }
    }

    private fun stopIngestion() {
        ingestionRunning.set(false)
        try { ingestionThread?.join(1500) } catch (_: Exception) {}
        ingestionThread = null
    }

    /** Seed handle yang sudah ada di memori kamera (abaikan foto lama). */
    private fun seedKnownHandles() {
        try {
            val t = transport ?: return
            val resp = t.transactData(
                OP_GET_OBJECT_HANDLES,
                intArrayOf(-1, 0, -1)   // allStorage, allFormats, allObjects
            )
            if (resp.ok && resp.data != null && resp.data.size >= 4) {
                val bb = ByteBuffer.wrap(resp.data).order(ByteOrder.LITTLE_ENDIAN)
                val n = bb.int
                repeat(n) { if (bb.remaining() >= 4) knownHandles.add(bb.int) }
                Log.i(TAG, "Seeded ${knownHandles.size} existing object handles")
            }
        } catch (e: Exception) {
            Log.w(TAG, "GetObjectHandles seed failed (non-fatal): ${e.message}")
        }
    }

    private fun pollObjectHandles(t: PtpTransport) {
        try {
            val resp = t.transactData(OP_GET_OBJECT_HANDLES, intArrayOf(-1, 0, -1))
            if (!resp.ok || resp.data == null || resp.data.size < 4) return
            val bb = ByteBuffer.wrap(resp.data).order(ByteOrder.LITTLE_ENDIAN)
            val n = bb.int
            val fresh = mutableListOf<Int>()
            repeat(n) {
                if (bb.remaining() >= 4) {
                    val h = bb.int
                    if (h !in knownHandles) { fresh.add(h); knownHandles.add(h) }
                }
            }
            for (h in fresh) {
                Log.i(TAG, "PTP camera reattached (poll) — new object handle 0x${Integer.toHexString(h)}")
                downloadAndDeliver(h)
            }
        } catch (e: Exception) {
            Log.w(TAG, "GetObjectHandles poll failed: ${e.message}")
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Download foto dari kamera
    // ═══════════════════════════════════════════════════════════

    private data class ObjectInfo(
        val handle: Int,
        val format: Int,
        var size: Long,
        val filename: String
    )

    private fun getObjectInfo(handle: Int): ObjectInfo? {
        val t = transport ?: return null
        val resp = t.transactData(OP_GET_OBJECT_INFO, intArrayOf(handle))
        if (!resp.ok || resp.data == null || resp.data.size < 52) return null
        val bb = ByteBuffer.wrap(resp.data).order(ByteOrder.LITTLE_ENDIAN)
        bb.int                                       // StorageID
        val format = bb.short.toInt() and 0xFFFF
        bb.short                                     // ProtectionStatus
        val size = bb.int.toLong() and 0xFFFFFFFFL   // ObjectCompressedSize
        bb.short                                     // ThumbFormat
        bb.int                                       // ThumbCompressedSize
        bb.int; bb.int                               // Thumb width/height
        bb.int; bb.int                               // Image width/height
        bb.int                                       // ImageBitDepth
        bb.int                                       // ParentObject
        bb.short                                     // AssociationType
        bb.int                                       // AssociationDesc
        bb.int                                       // SequenceNumber
        val filename = readPtpString(bb)
        return ObjectInfo(handle, format, size, filename)
    }

    /**
     * Unduh foto dari handle tertentu, normalisasi (EXIF rotate + downscale),
     * lalu kirim sebagai base64 data URL ke pendingCaptureCallback (remote
     * shutter) atau onPhotoIngested (shutter fisik).
     */
    private fun downloadAndDeliver(rawHandle: Int) {
        try {
            // Sony: ObjectAdded kadang datang dengan handle 0 / handle umum —
            // pakai pseudo-handle "objek terakhir" (trik SatsetMobile).
            var handle = rawHandle
            if (vendorId == VENDOR_SONY && (handle == 0 || handle == -1)) {
                handle = SONY_LAST_OBJECT_HANDLE
            }

            // Tunggu file selesai ditulis kamera (size > 0), max 5 dtk
            var info: ObjectInfo? = null
            val start = System.currentTimeMillis()
            var polls = 0
            while (System.currentTimeMillis() - start < OBJECT_INFO_WAIT_MS) {
                info = getObjectInfo(handle)
                if (info != null && info.size > 0) break
                polls++
                Thread.sleep(100)
            }
            if (info == null || info.size <= 0) {
                Log.w(TAG, "GetObjectInfo 0x${Integer.toHexString(handle)} gagal setelah $polls polls")
                return
            }
            Log.i(TAG, "GetObjectInfo 0x${Integer.toHexString(handle)}: ${info.filename}, size=${info.size}B")

            // Hanya JPEG yang dikirim ke server (RAW dilewati — ukurannya besar
            // dan server Saatiril menyimpan sebagai .jpg)
            val isJpeg = info.format == FORMAT_JPEG ||
                info.filename.endsWith(".jpg", true) || info.filename.endsWith(".jpeg", true)
            if (!isJpeg) {
                Log.i(TAG, "Skip non-JPEG object (${info.filename}, format=0x${Integer.toHexString(info.format)})")
                return
            }

            var bytes = getObject(handle, info.size)
            // Fallback Sony: GetPartialLargeObject(0x9211)
            if (bytes == null && vendorId == VENDOR_SONY) {
                bytes = getSonyPartialObject(handle)
            }
            if (bytes == null || bytes.size < MIN_PHOTO_BYTES) {
                Log.e(TAG, "Download foto gagal / terlalu kecil (${bytes?.size ?: 0}B)")
                return
            }

            val normalized = normalizePhoto(bytes)
            if (normalized == null) {
                Log.e(TAG, "Gagal decode foto (bukan JPEG valid?)")
                return
            }
            val dataUrl = "data:image/jpeg;base64,${Base64.encodeToString(normalized, Base64.NO_WRAP)}"
            _ingestedCount.value = _ingestedCount.value + 1
            Log.i(TAG, "Physical shutter photo downloaded successfully: ${normalized.size / 1024}KB " +
                "(total=${_ingestedCount.value})")

            deliverPhoto(dataUrl)
        } catch (e: Exception) {
            Log.e(TAG, "Physical shutter photo download failed: ${e.message}", e)
        }
    }

    private fun getObject(handle: Int, expectedSize: Long): ByteArray? {
        val t = transport ?: return null
        return try {
            val resp = t.transactData(OP_GET_OBJECT, intArrayOf(handle), 60000)
            if (resp.ok && resp.data != null && resp.data.size >= MIN_PHOTO_BYTES) {
                Log.i(TAG, "GetObject success: ${resp.data.size / 1024}KB (expected ${expectedSize / 1024}KB)")
                resp.data
            } else null
        } catch (e: Exception) {
            Log.w(TAG, "GetObject failed: ${e.message}")
            null
        }
    }

    /** GetPartialLargeObject(handle, 0, 0, 64MB) — fallback Sony untuk file besar. */
    private fun getSonyPartialObject(handle: Int): ByteArray? {
        val t = transport ?: return null
        return try {
            val resp = t.transactData(
                OP_SONY_GET_PARTIAL_LARGE_OBJECT,
                intArrayOf(handle, 0, 0, 64 * 1024 * 1024),
                60000
            )
            if (resp.ok && resp.data != null && resp.data.size >= MIN_PHOTO_BYTES) {
                Log.i(TAG, "GetPartialLargeObject success: ${resp.data.size / 1024}KB")
                resp.data
            } else null
        } catch (e: Exception) {
            Log.w(TAG, "GetPartialLargeObject failed: ${e.message}")
            null
        }
    }

    /**
     * EXIF-rotate + downscale sisi terpanjang ke ≤2560px.
     * (24MP JPEG mentah = bitmap ~96MB → OOM; 2560px aman & tetap "HD+")
     */
    private fun normalizePhoto(jpegBytes: ByteArray): ByteArray? {
        try {
            if (jpegBytes.size < 4 ||
                ((jpegBytes[0].toInt() and 0xFF) != 0xFF || (jpegBytes[1].toInt() and 0xFF) != 0xD8)
            ) {
                Log.w(TAG, "Bukan JPEG (magic bytes salah) — dilewatkan")
                return null
            }

            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_INGEST_EDGE_PX) {
                sample *= 2
            }
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            var bitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size, opts) ?: return null

            // Rotasi EXIF (kamera portrait)
            val orientation = try {
                android.media.ExifInterface(ByteArrayInputStream(jpegBytes))
                    .getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)
            } catch (_: Exception) { 1 }
            val matrix = Matrix()
            when (orientation) {
                2 -> matrix.setScale(-1f, 1f)
                3 -> matrix.setRotate(180f)
                4 -> matrix.setScale(1f, -1f)
                5 -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                6 -> matrix.setRotate(90f)
                7 -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
                8 -> matrix.setRotate(-90f)
            }
            if (orientation != 1) {
                val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                if (rotated != bitmap) bitmap.recycle()
                bitmap = rotated
            }

            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out)
            bitmap.recycle()
            return out.toByteArray()
        } catch (e: Exception) {
            Log.e(TAG, "normalizePhoto failed: ${e.message}")
            return null
        }
    }

    /** Kirim foto ke callback remote-shutter bila menunggu, kalau tidak ke ingestion. */
    private fun deliverPhoto(dataUrl: String) {
        val pending = pendingCaptureCallback
        if (pending != null) {
            pendingCaptureCallback = null
            mainHandler.post { pending(dataUrl) }
        } else {
            val cb = onPhotoIngested
            if (cb != null) {
                mainHandler.post { cb(dataUrl) }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Remote shutter (tombol Ambil Foto di layar)
    // ═══════════════════════════════════════════════════════════

    /**
     * Picu shutter dari aplikasi:
     * - Sony: half-press (AF) → full-press → release, lalu foto dikirim
     *   dari ingestion loop ke callback (timeout 25 dtk seperti SatsetMobile).
     * - Generic: InitiateCapture(0,0).
     */
    fun capturePhoto(onResult: (String?) -> Unit) {
        val t = transport
        if (t == null || _state.value != PtpState.READY) {
            Log.e(TAG, "capturePhoto: kamera PTP belum Ready")
            onResult(null)
            return
        }
        pendingCaptureCallback = onResult

        // Timeout 25 detik
        mainHandler.postDelayed({
            val pending = pendingCaptureCallback
            if (pending != null) {
                Log.e(TAG, "takePhoto timed out after 25s")
                pendingCaptureCallback = null
                pending(null)
            }
        }, CAPTURE_TIMEOUT_MS)

        ioHandler?.post {
            try {
                if (vendorId == VENDOR_SONY) {
                    Log.i(TAG, "Capture: half-press shutter (AF)")
                    setControlDeviceB(SONY_CONTROL_HALF_PRESS, 2)
                    Thread.sleep(500)
                    Log.i(TAG, "Capture: full-press shutter")
                    setControlDeviceB(SONY_CONTROL_FULL_PRESS, 2)
                    Thread.sleep(350)
                    setControlDeviceB(SONY_CONTROL_FULL_PRESS, 1)
                    setControlDeviceB(SONY_CONTROL_HALF_PRESS, 1)
                } else {
                    t.transact(OP_INITIATE_CAPTURE, intArrayOf(0, 0))
                }
                // Foto dikirim oleh ingestion loop → deliverPhoto → callback
            } catch (e: Exception) {
                Log.e(TAG, "Camera didn't respond to shutter: ${e.message}")
                val pending = pendingCaptureCallback
                pendingCaptureCallback = null
                pending?.let { mainHandler.post { it(null) } }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Camera list / switching / rescan (paritas API manager lain)
    // ═══════════════════════════════════════════════════════════

    private fun updateAvailableCameras() {
        val cameras = mutableListOf<Pair<String, String>>()
        for ((name, device) in discoveredDevices) {
            val label = if (currentDevice?.deviceName == name && _cameraLabel.value.isNotBlank()) {
                "PTP: ${_cameraLabel.value}"
            } else {
                "PTP: ${vendorName(device.vendorId)} (0x${Integer.toHexString(device.vendorId)})"
            }
            cameras.add(name to label)
        }
        _availableCameras.value = cameras
        if (currentDevice != null) _currentCameraId.value = currentDevice!!.deviceName
    }

    fun switchCamera(deviceId: String) {
        val device = discoveredDevices[deviceId] ?: return
        val mgr = usbManager() ?: return
        if (currentDevice?.deviceName == deviceId && _isConnected.value) return
        if (mgr.hasPermission(device)) {
            connectDevice(device)
        } else {
            requestUsbPermission(device)
        }
    }

    fun forceRescan() {
        Log.i(TAG, "forceRescan: re-scanning USB untuk kamera PTP")
        discoveredDevices.clear()
        updateAvailableCameras()
        enumerateConnectedDevices()
    }

    // PTP tidak punya live preview — hand trigger / preview bitmap tidak tersedia
    fun getPreviewBitmap(): Bitmap? = null

    fun showPreview() { Log.i(TAG, "showPreview — tether aktif, tidak ada video preview") }
    fun hidePreview() { Log.i(TAG, "hidePreview") }
    fun setFilter(preset: String) { Log.d(TAG, "setFilter: $preset") }
    fun updateConfig(aspectRatio: Double, filterPreset: String) { setFilter(filterPreset) }

    // ═══════════════════════════════════════════════════════════
    // PTP Transport — container layer di atas bulk endpoint
    // ═══════════════════════════════════════════════════════════

    data class PtpResponse(val code: Int, val params: IntArray, val data: ByteArray?) {
        val ok: Boolean get() = code == RESP_OK
        override fun equals(other: Any?) = this === other
        override fun hashCode() = System.identityHashCode(this)
    }

    /** Event PTP dari interrupt endpoint (mis. ObjectAdded 0x4002). */
    data class PtpEvent(val code: Int, val params: IntArray)

    /**
     * Transport PTP: kirim Command Block → (Data Block in/out) → Response Block.
     * Semua container little-endian. Thread-safe via ReentrantLock karena
     * ingestion loop dan perintah kontrol berbagi endpoint yang sama.
     */
    inner class PtpTransport(
        private val connection: UsbDeviceConnection,
        private val iface: UsbInterface
    ) {
        private var epIn: UsbEndpoint? = null
        private var epOut: UsbEndpoint? = null
        private var epInterrupt: UsbEndpoint? = null
        private val lock = ReentrantLock(true)
        private val txCounter = AtomicInteger(0)
        private val chunk = ByteArray(16384)
        private val interruptBuf = ByteArray(64)

        fun open() {
            for (i in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(i)
                when {
                    ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_IN && epIn == null ->
                        epIn = ep
                    ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT && epOut == null ->
                        epOut = ep
                    ep.type == UsbConstants.USB_ENDPOINT_XFER_INTERRUPT && ep.direction == UsbConstants.USB_DIR_IN && epInterrupt == null ->
                        epInterrupt = ep
                }
            }
            if (epIn == null || epOut == null) {
                throw IllegalStateException("Bulk endpoint IN/OUT tidak ditemukan")
            }
            Log.i(TAG, "Endpoints: bulkIn=${epIn!!.address}, bulkOut=${epOut!!.address}, " +
                "interrupt=${epInterrupt?.address ?: "none"}")
        }

        fun close() {
            try { connection.releaseInterface(iface) } catch (_: Exception) {}
            try { connection.close() } catch (_: Exception) {}
        }

        /** Buang sisa paket yang nyangkut (mis. setelah error). */
        fun reset() {
            lock.lock()
            try {
                // Baca habis data tersisa dengan timeout pendek
                var guard = 0
                while (guard++ < 4) {
                    val n = connection.bulkTransfer(epIn, chunk, chunk.size, 50)
                    if (n <= 0) break
                }
            } catch (_: Exception) {
            } finally {
                lock.unlock()
            }
        }

        private fun nextTxId(): Int {
            val id = txCounter.getAndIncrement()
            return if (id == 0) 0 else id  // OpenSession memakai txId 0
        }

        private fun buildCommand(code: Int, txId: Int, params: IntArray): ByteArray {
            val bb = ByteBuffer.allocate(12 + params.size * 4).order(ByteOrder.LITTLE_ENDIAN)
            bb.putInt(12 + params.size * 4)
            bb.putShort(1)                       // Command Block
            bb.putShort(code.toShort())
            bb.putInt(txId)
            for (p in params) bb.putInt(p)
            return bb.array()
        }

        private fun send(bytes: ByteArray, timeout: Int): Boolean =
            connection.bulkTransfer(epOut, bytes, bytes.size, timeout) >= 0

        /** Baca container data (type 2) — akumulasi sampai total len tercapai. */
        private fun readDataBlock(txId: Int, timeout: Int): ByteArray? {
            var n = connection.bulkTransfer(epIn, chunk, chunk.size, timeout)
            if (n < 12) return null
            val totalLen = ((chunk[3].toLong() and 0xFF) shl 24) or
                ((chunk[2].toLong() and 0xFF) shl 16) or
                ((chunk[1].toLong() and 0xFF) shl 8) or
                (chunk[0].toLong() and 0xFF)
            val type = leU16(chunk, 4)
            if (type != 2) return null            // bukan data phase
            if (totalLen <= 12L) return ByteArray(0)
            val dataLen = (totalLen - 12).toInt()
            if (dataLen > 128 * 1024 * 1024) return null  // sanity: >128MB tolak
            val data = ByteArray(dataLen)
            var copied = minOf(n - 12, dataLen)
            if (copied > 0) System.arraycopy(chunk, 12, data, 0, copied)
            while (copied < dataLen) {
                n = connection.bulkTransfer(epIn, chunk, minOf(chunk.size, dataLen - copied), timeout)
                if (n <= 0) break
                System.arraycopy(chunk, 0, data, copied, n)
                copied += n
            }
            return if (copied >= dataLen) data else {
                Log.w(TAG, "Data block terpotong: $copied/$dataLen")
                null
            }
        }

        /** Baca Response Block (type 3). */
        private fun readResponse(timeout: Int): PtpResponse {
            val buf = ByteArray(64)
            var n = connection.bulkTransfer(epIn, buf, buf.size, timeout)
            if (n < 8) return PtpResponse(-1, IntArray(0), null)
            val len = leU32ToInt(buf, 0)
            while (n < len && n < buf.size) {
                val m = connection.bulkTransfer(epIn, buf, buf.size - n, 200)
                if (m <= 0) break
                n += m
            }
            val type = leU16(buf, 4)
            val code = leU16(buf, 6)
            if (type != 3) {
                Log.w(TAG, "Response block salah type=$type code=0x${Integer.toHexString(code)}")
            }
            val paramCount = (maxOf(len, 12) - 12) / 4
            val params = IntArray(paramCount)
            for (i in 0 until paramCount) {
                val off = 12 + i * 4
                if (off + 4 <= n) {
                    params[i] = leU32ToInt(buf, off)
                }
            }
            return PtpResponse(code, params, null)
        }

        /** Operasi TANPA data phase: command → response. */
        fun transact(code: Int, params: IntArray, timeout: Int = 15000): PtpResponse {
            lock.lock()
            try {
                val txId = nextTxId()
                if (!send(buildCommand(code, txId, params), timeout)) {
                    return PtpResponse(-2, IntArray(0), null)
                }
                return readResponse(timeout)
            } finally {
                lock.unlock()
            }
        }

        /** Operasi DENGAN data-in: command → data → response. */
        fun transactData(code: Int, params: IntArray, timeout: Int = 15000): PtpResponse {
            lock.lock()
            try {
                val txId = nextTxId()
                if (!send(buildCommand(code, txId, params), timeout)) {
                    return PtpResponse(-2, IntArray(0), null)
                }
                val data = readDataBlock(txId, timeout)
                val resp = readResponse(timeout)
                return PtpResponse(resp.code, resp.params, data)
            } finally {
                lock.unlock()
            }
        }

        /** Operasi dengan data-OUT (SetControlDeviceA/B Sony): command → data-out → response. */
        fun transactOut(code: Int, params: IntArray, payload: ByteArray, timeout: Int = 15000): PtpResponse {
            lock.lock()
            try {
                val txId = nextTxId()
                if (!send(buildCommand(code, txId, params), timeout)) {
                    return PtpResponse(-2, IntArray(0), null)
                }
                val dataContainer = ByteBuffer.allocate(12 + payload.size).order(ByteOrder.LITTLE_ENDIAN)
                dataContainer.putInt(12 + payload.size)
                dataContainer.putShort(2)          // Data Block
                dataContainer.putShort(code.toShort())
                dataContainer.putInt(txId)
                dataContainer.put(payload)
                if (!send(dataContainer.array(), timeout)) {
                    Log.e(TAG, "DataOutIn data-out phase send failed")
                    return PtpResponse(-2, IntArray(0), null)
                }
                return readResponse(timeout)
            } finally {
                lock.unlock()
            }
        }

        /** Poll event dari interrupt endpoint (timeout pendek). */
        fun pollInterrupt(timeout: Int): PtpEvent? {
            val ep = epInterrupt ?: return null
            lock.lock()
            try {
                val n = connection.bulkTransfer(ep, interruptBuf, interruptBuf.size, timeout)
                if (n < 12) return null
                val type = leU16(interruptBuf, 4)
                if (type != 4) return null         // Event Block
                val code = leU16(interruptBuf, 6)
                val len = leU32ToInt(interruptBuf, 0)
                val paramCount = (maxOf(len, 12) - 12) / 4
                val params = IntArray(paramCount)
                for (i in 0 until paramCount) {
                    val off = 12 + i * 4
                    if (off + 4 <= n) params[i] = leU32ToInt(interruptBuf, off)
                }
                return PtpEvent(code, params)
            } finally {
                lock.unlock()
            }
        }

        private fun leU16(b: ByteArray, off: Int): Int =
            (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)

        private fun leU32ToInt(b: ByteArray, off: Int): Int =
            (b[off].toInt() and 0xFF) or
                ((b[off + 1].toInt() and 0xFF) shl 8) or
                ((b[off + 2].toInt() and 0xFF) shl 16) or
                ((b[off + 3].toInt() and 0xFF) shl 24)
    }
}
