// Bluetooth LE link to a QVAC-BOARD desktop (Android, central role).
// Same JS API as ios/QvacBleModule.swift:
//   state(): String                                  "poweredOn", "poweredOff", "unauthorized", ...
//   connect(uuids: [String], timeoutMs: Int) async   find a desktop advertising one of the
//                                                    hourly service UUIDs and open the link
//   write(base64: String)                            queue bytes for the desktop
//   disconnect()
// Events: onData { data: base64 } · onClose { error?: String } · onState { state }
//
// It only moves bytes: encryption (Noise, one-time keys) and the check that the other side
// really is the paired desktop happen in the P2P worker on top.
package expo.modules.qvacble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

private val RX_UUID: UUID = UUID.fromString("7a1c0002-9d2e-4b7f-8c51-3f6a2e9b1d40") // phone → desktop
private val TX_UUID: UUID = UUID.fromString("7a1c0003-9d2e-4b7f-8c51-3f6a2e9b1d40") // desktop → phone
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

class QvacBleModule : Module() {
  private var link: BleLink? = null

  private fun link(): BleLink {
    link?.let { return it }
    val context = appContext.reactContext ?: throw IllegalStateException("No context")
    return BleLink(
      context.applicationContext,
      onData = { data -> sendEvent("onData", mapOf("data" to Base64.encodeToString(data, Base64.NO_WRAP))) },
      onClose = { error -> sendEvent("onClose", if (error != null) mapOf("error" to error) else emptyMap<String, Any>()) },
      onState = { state -> sendEvent("onState", mapOf("state" to state)) },
    ).also { link = it }
  }

  override fun definition() = ModuleDefinition {
    Name("QvacBle")

    Events("onData", "onClose", "onState")

    OnDestroy { link?.disconnect(null) }

    Function("state") { link().stateName() }

    AsyncFunction("connect") { uuids: List<String>, timeoutMs: Int, promise: Promise ->
      link().connect(uuids.map { UUID.fromString(it) }, timeoutMs) { error ->
        if (error != null) promise.reject("BLE_CONNECT", error, null) else promise.resolve("ok")
      }
    }

    Function("write") { base64: String ->
      link().write(Base64.decode(base64, Base64.DEFAULT))
    }

    Function("disconnect") { link?.disconnect(null) }
  }
}

// Everything runs on the main looper: GATT callbacks are posted there, so state is never shared
// between threads. One write at a time (Android has no write queue of its own).
@SuppressLint("MissingPermission") // checked in hasPermissions() before every operation
class BleLink(
  private val context: Context,
  private val onData: (ByteArray) -> Unit,
  private val onClose: (String?) -> Unit,
  private val onState: (String) -> Unit,
) {
  private val main = Handler(Looper.getMainLooper())
  private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private var gatt: BluetoothGatt? = null
  private var rx: BluetoothGattCharacteristic? = null
  private var wanted: List<UUID> = emptyList()
  private var pendingConnect: ((String?) -> Unit)? = null
  private var timeout: Runnable? = null
  private var scanning = false
  private var open = false
  private var mtu = 23
  private val outbox = ArrayDeque<ByteArray>()
  private var writing = false
  private var writeSeq = 0

  private fun hasPermissions(): Boolean {
    val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
      listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    else listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    return needed.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
  }

  fun stateName(): String {
    val adapter = manager?.adapter ?: return "unsupported"
    if (!hasPermissions()) return "unauthorized"
    return if (adapter.isEnabled) "poweredOn" else "poweredOff"
  }

  fun connect(uuids: List<UUID>, timeoutMs: Int, done: (String?) -> Unit) { main.post {
    closeLink(null, notify = false)
    pendingConnect?.invoke("Sostituito da un nuovo tentativo")
    pendingConnect = done
    wanted = uuids
    val t = Runnable { finishConnect("Nessun desktop trovato via Bluetooth qui vicino") }
    timeout = t
    main.postDelayed(t, maxOf(1000, timeoutMs).toLong())
    val adapter = manager?.adapter
    when {
      adapter == null -> finishConnect("Bluetooth non disponibile su questo dispositivo")
      !hasPermissions() -> finishConnect("Bluetooth non autorizzato per QVAC-BOARD")
      !adapter.isEnabled -> finishConnect("Bluetooth spento sul telefono")
      else -> startScan()
    }
  } }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      main.post { onFound(result.device) }
    }

    override fun onScanFailed(errorCode: Int) {
      main.post { finishConnect("Ricerca Bluetooth non riuscita ($errorCode)") }
    }
  }

  private fun startScan() {
    val scanner = manager?.adapter?.bluetoothLeScanner ?: return finishConnect("Bluetooth non disponibile")
    val filters = wanted.map { ScanFilter.Builder().setServiceUuid(ParcelUuid(it)).build() }
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    try {
      scanner.startScan(filters, settings, scanCallback)
      scanning = true
    } catch (e: SecurityException) {
      finishConnect("Bluetooth non autorizzato per QVAC-BOARD")
    }
  }

  private fun stopScan() {
    if (!scanning) return
    scanning = false
    try { manager?.adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
  }

  private fun onFound(device: BluetoothDevice) {
    if (pendingConnect == null || gatt != null) return
    stopScan()
    gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
  }

  private fun finishConnect(error: String?) {
    timeout?.let { main.removeCallbacks(it) }
    timeout = null
    stopScan()
    val done = pendingConnect ?: return
    pendingConnect = null
    if (error != null) closeLink(null, notify = false) else open = true
    done(error)
  }

  fun write(data: ByteArray) { main.post {
    if (!open) return@post
    val max = maxOf(20, mtu - 3)
    var offset = 0
    while (offset < data.size) {
      val end = minOf(offset + max, data.size)
      outbox.addLast(data.copyOfRange(offset, end))
      offset = end
    }
    flush()
  } }

  private fun flush() {
    val g = gatt ?: return
    val c = rx ?: return
    if (writing || outbox.isEmpty()) return
    val piece = outbox.removeFirst()
    writing = true
    val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      g.writeCharacteristic(c, piece, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION")
      c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      @Suppress("DEPRECATION")
      c.value = piece
      @Suppress("DEPRECATION")
      g.writeCharacteristic(c)
    }
    if (!ok) {
      // the stack is busy: try the same piece again shortly
      outbox.addFirst(piece)
      writing = false
      main.postDelayed({ flush() }, 10)
      return
    }
    // Some phones never report writes without response: don't wait more than a moment
    val seq = ++writeSeq
    main.postDelayed({ if (writing && seq == writeSeq) { writing = false; flush() } }, 60)
  }

  fun disconnect(reason: String?) { main.post { closeLink(reason, notify = true) } }

  private fun closeLink(reason: String?, notify: Boolean) {
    val wasOpen = open
    open = false
    outbox.clear()
    writing = false
    rx = null
    gatt?.let {
      try { it.disconnect(); it.close() } catch (_: Exception) {}
    }
    gatt = null
    mtu = 23
    if (notify && wasOpen) onClose(reason)
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) = main.post {
      if (g != gatt) return@post
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        // a bigger MTU means fewer, larger pieces (the desktop accepts up to 512)
        if (!g.requestMtu(247)) g.discoverServices()
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        if (pendingConnect != null) return@post finishConnect("Collegamento Bluetooth interrotto")
        val wasOpen = open
        open = false
        outbox.clear()
        writing = false
        rx = null
        try { g.close() } catch (_: Exception) {}
        gatt = null
        if (wasOpen) onClose(if (status == BluetoothGatt.GATT_SUCCESS) null else "Bluetooth scollegato ($status)")
      }
    }.let {}

    override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) = main.post {
      if (g != gatt) return@post
      if (status == BluetoothGatt.GATT_SUCCESS) mtu = newMtu
      g.discoverServices()
    }.let {}

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) = main.post {
      if (g != gatt) return@post
      val service = g.services.firstOrNull { wanted.contains(it.uuid) } ?: return@post finishConnect("Servizio QVAC non trovato")
      val rxChar = service.getCharacteristic(RX_UUID)
      val txChar = service.getCharacteristic(TX_UUID)
      if (rxChar == null || txChar == null) return@post finishConnect("Servizio QVAC incompleto")
      rx = rxChar
      g.setCharacteristicNotification(txChar, true)
      val cccd = txChar.getDescriptor(CCCD_UUID) ?: return@post finishConnect("Servizio QVAC incompleto")
      val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        g.writeDescriptor(cccd, enable)
      } else {
        @Suppress("DEPRECATION")
        cccd.value = enable
        @Suppress("DEPRECATION")
        g.writeDescriptor(cccd)
      }
    }.let {}

    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = main.post {
      if (g != gatt || descriptor.uuid != CCCD_UUID) return@post
      if (status == BluetoothGatt.GATT_SUCCESS) finishConnect(null) else finishConnect("Notifiche Bluetooth non attivate ($status)")
    }.let {}

    override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) = main.post {
      if (g != gatt) return@post
      writing = false
      flush()
    }.let {}

    // Android 13+
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (characteristic.uuid != TX_UUID) return
      val copy = value.copyOf()
      main.post { if (open && g == gatt) onData(copy) }
    }

    // Android 10-12
    @Deprecated("Deprecated in Java")
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
      if (characteristic.uuid != TX_UUID) return
      @Suppress("DEPRECATION")
      val copy = characteristic.value?.copyOf() ?: return
      main.post { if (open && g == gatt) onData(copy) }
    }
  }
}
