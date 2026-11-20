// Bluetooth LE link to a QVAC-BOARD desktop (CoreBluetooth, central role).
//
// It only moves bytes: the encryption (Noise, one-time keys) and the check that
// the other side really is the paired desktop happen in the P2P worker on top.
//
// JS API:
//   state(): String                                  "poweredOn", "unauthorized", ...
//   connect(uuids: [String], timeoutMs: Int) async   find a desktop advertising one of the
//                                                    hourly service UUIDs and open the link
//   write(base64: String)                            queue bytes for the desktop
//   disconnect()
// Events: onData { data: base64 } · onClose { error?: String } · onState { state }
import CoreBluetooth
import ExpoModulesCore

private let rxUUID = CBUUID(string: "7a1c0002-9d2e-4b7f-8c51-3f6a2e9b1d40") // phone → desktop
private let txUUID = CBUUID(string: "7a1c0003-9d2e-4b7f-8c51-3f6a2e9b1d40") // desktop → phone

public final class QvacBleModule: Module {
  private lazy var link = BleLink(
    onData: { [weak self] data in self?.sendEvent("onData", ["data": data.base64EncodedString()]) },
    onClose: { [weak self] error in self?.sendEvent("onClose", error.map { ["error": $0] } ?? [:]) },
    onState: { [weak self] state in self?.sendEvent("onState", ["state": state]) }
  )

  public func definition() -> ModuleDefinition {
    Name("QvacBle")

    Events("onData", "onClose", "onState")

    Function("state") { () -> String in
      self.link.stateName
    }

    AsyncFunction("connect") { (uuids: [String], timeoutMs: Int, promise: Promise) in
      self.link.connect(uuids: uuids.map { CBUUID(string: $0) }, timeoutMs: timeoutMs) { error in
        if let error { promise.reject("BLE_CONNECT", error) } else { promise.resolve("ok") }
      }
    }

    Function("write") { (base64: String) in
      if let data = Data(base64Encoded: base64) { self.link.write(data) }
    }

    Function("disconnect") {
      self.link.disconnect(reason: nil)
    }
  }
}

final class BleLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private let queue = DispatchQueue(label: "qvac.ble")
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var rx: CBCharacteristic?
  private var wanted: [CBUUID] = []
  private var pendingConnect: ((String?) -> Void)?
  private var timeout: DispatchWorkItem?
  private var outbox: [Data] = []
  private var open = false

  private let onData: (Data) -> Void
  private let onClose: (String?) -> Void
  private let onState: (String) -> Void

  init(onData: @escaping (Data) -> Void, onClose: @escaping (String?) -> Void, onState: @escaping (String) -> Void) {
    self.onData = onData
    self.onClose = onClose
    self.onState = onState
    super.init()
  }

  // Created on first use: this is when iOS asks for the Bluetooth permission
  private func ensureCentral() -> CBCentralManager {
    if let central { return central }
    let manager = CBCentralManager(delegate: self, queue: queue)
    central = manager
    return manager
  }

  var stateName: String {
    guard let central else { return "notStarted" }
    switch central.state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    default: return "unknown"
    }
  }

  func connect(uuids: [CBUUID], timeoutMs: Int, done: @escaping (String?) -> Void) {
    queue.async {
      self.closeLink(reason: nil, notify: false)
      self.wanted = uuids
      self.pendingConnect = done
      let work = DispatchWorkItem { [weak self] in self?.finishConnect(error: "Nessun desktop trovato via Bluetooth qui vicino") }
      self.timeout = work
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(1000, timeoutMs)), execute: work)
      let manager = self.ensureCentral()
      if manager.state == .poweredOn { self.startScan() }
      else if manager.state == .unauthorized { self.finishConnect(error: "Bluetooth non autorizzato per QVAC-BOARD") }
      else if manager.state == .poweredOff { self.finishConnect(error: "Bluetooth spento sull’iPhone") }
      // otherwise wait for centralManagerDidUpdateState
    }
  }

  private func startScan() {
    guard pendingConnect != nil, let central else { return }
    central.scanForPeripherals(withServices: wanted, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
  }

  private func finishConnect(error: String?) {
    timeout?.cancel()
    timeout = nil
    central?.stopScan()
    guard let done = pendingConnect else { return }
    pendingConnect = nil
    if error != nil { closeLink(reason: nil, notify: false) }
    else { open = true }
    done(error)
  }

  func write(_ data: Data) {
    queue.async {
      guard self.open, let peripheral = self.peripheral else { return }
      let max = max(20, peripheral.maximumWriteValueLength(for: .withoutResponse))
      var offset = 0
      while offset < data.count {
        let end = min(offset + max, data.count)
        self.outbox.append(data.subdata(in: offset..<end))
        offset = end
      }
      self.flush()
    }
  }

  // iOS has a small queue for writes without response: send while it has room,
  // continue in peripheralIsReady(toSendWriteWithoutResponse:)
  private func flush() {
    guard let peripheral, let rx else { return }
    while !outbox.isEmpty && peripheral.canSendWriteWithoutResponse {
      peripheral.writeValue(outbox.removeFirst(), for: rx, type: .withoutResponse)
    }
  }

  func disconnect(reason: String?) {
    queue.async { self.closeLink(reason: reason, notify: true) }
  }

  private func closeLink(reason: String?, notify: Bool) {
    let wasOpen = open
    open = false
    outbox.removeAll()
    rx = nil
    if let peripheral, let central { central.cancelPeripheralConnection(peripheral) }
    peripheral = nil
    if notify && wasOpen { onClose(reason) }
  }

  // MARK: CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    onState(stateName)
    switch central.state {
    case .poweredOn: startScan()
    case .unauthorized: finishConnect(error: "Bluetooth non autorizzato per QVAC-BOARD")
    case .poweredOff:
      finishConnect(error: "Bluetooth spento sull’iPhone")
      closeLink(reason: "Bluetooth spento", notify: true)
    default: break
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard pendingConnect != nil, self.peripheral == nil else { return }
    central.stopScan()
    self.peripheral = peripheral
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices(wanted)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    finishConnect(error: error?.localizedDescription ?? "Collegamento Bluetooth non riuscito")
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    guard peripheral == self.peripheral else { return }
    if pendingConnect != nil { return finishConnect(error: "Collegamento Bluetooth interrotto") }
    self.peripheral = nil
    let wasOpen = open
    open = false
    outbox.removeAll()
    rx = nil
    if wasOpen { onClose(error?.localizedDescription) }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let service = peripheral.services?.first(where: { wanted.contains($0.uuid) }) else {
      return finishConnect(error: "Servizio QVAC non trovato")
    }
    peripheral.discoverCharacteristics([rxUUID, txUUID], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    let chars = service.characteristics ?? []
    guard let rx = chars.first(where: { $0.uuid == rxUUID }), let tx = chars.first(where: { $0.uuid == txUUID }) else {
      return finishConnect(error: "Servizio QVAC incompleto")
    }
    self.rx = rx
    peripheral.setNotifyValue(true, for: tx)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == txUUID else { return }
    if let error { return finishConnect(error: error.localizedDescription) }
    if characteristic.isNotifying { finishConnect(error: nil) }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == txUUID, let value = characteristic.value, open else { return }
    onData(value)
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    flush()
  }
}
