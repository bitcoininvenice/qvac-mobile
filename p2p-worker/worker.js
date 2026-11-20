// P2P worker of the QVAC-BOARD app. Runs in a Bare worklet (not in React Native's
// JavaScript engine), because hyperdht needs native UDP and crypto.
//
// React Native talks to it with newline-delimited JSON over the IPC stream:
//   → { id, cmd, ...args }         ← { id, ok, result | error }
//   ← { event: 'status', ... }     (pushed when a Mac goes online/offline)
//
// The same line protocol is used between the app and the Mac node:
//   pairing:  app → { type: 'pair', name, platform }   Mac → { type: 'paired', mac, name }
//   session:  app → { type: 'hello', name, platform }  Mac → { type: 'welcome', name }
//             both → { type: 'ping', t } / { type: 'pong', t }
//
// Two paths to a paired Mac, tried in this order:
//   1. local: TCP to the Mac's home address (learned from its welcome), encrypted
//      with the same Noise handshake as Holepunch; we check it is really our Mac
//   2. P2P: Holepunch DHT, works anywhere (also through VPNs and mobile data)
// While on P2P, the local path is probed now and then and taken when it works.
// Errors before start() has an IPC channel are kept here and sent as soon as it exists
const pendingFatal = []
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('uncaughtException', (err) => onFatal('uncaughtException', err))
  Bare.on('unhandledRejection', (err) => onFatal('unhandledRejection', err))
}
// Libraries: if one fails to load, the worker still starts and tells the app which one
var DHT, SecretStream, tcp, fs, WebSocket, b4a, crypto, sodium, Duplex
var RelayPool, NostrPeer, DEFAULT_RELAYS, pairingKeys, pairingProof, pairingTrafficKey
var sendSealed, listenSealed, oneTimeKeyPair, exchange, wipe, seal, open, inviteSecrets
var Hyperswarm, meshSecrets, meshProof, verifyMeshProof
var nostrLinkModule, Messenger, streamLink
var loadError = null
try {
  require('./polyfills') // first: TextEncoder & co. for the libraries below
  DHT = require('hyperdht')
  SecretStream = require('@hyperswarm/secret-stream')
  tcp = require('bare-tcp')
  fs = require('bare-fs')
  WebSocket = require('bare-ws').Socket // the module exports { Socket, Server }, not the class
  ;({
    RelayPool, NostrPeer, DEFAULT_RELAYS, pairingKeys, pairingProof, pairingTrafficKey,
    sendSealed, listenSealed, oneTimeKeyPair, exchange, wipe, seal, open, inviteSecrets,
    meshSecrets, meshProof, verifyMeshProof
  } = require('./nostr-link'))
  Hyperswarm = require('hyperswarm')
  nostrLinkModule = require('./nostr-link')
  ;({ Messenger, streamLink } = require('./msg-core'))
  b4a = require('b4a')
  crypto = require('hypercore-crypto')
  sodium = require('sodium-universal')
  Duplex = require('streamx').Duplex
} catch (err) {
  loadError = err
}

const RECONNECT_MS = 5000
const PING_MS = 10000
const PAIR_TIMEOUT_MS = 30000
const STALE_MS = 30000 // nothing from the desktop for this long (it pings every 10 s): connection is gone
const PUNCH_TIMEOUT_MS = 10000 // Holepunch gets this long, then we move on to Nostr
const LAN_TIMEOUT_MS = 1500
const LAN_PROBE_MS = 20000
const CHUNK_BYTES = 24 * 1024 // base64 → ~32 KB per line

// With a "random" NAT on either side, hyperdht allows one holepunch every 20 s:
// attempts closer than that are aborted (HOLEPUNCH_ABORTED). So after a failed
// P2P attempt we wait at least this long, growing up to a minute.
const PUNCH_RETRY_MS = [25000, 40000, 60000]
const PUNCH_ERRORS = new Set([
  'HOLEPUNCH_ABORTED', 'HOLEPUNCH_PROBE_TIMEOUT', 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS',
  'REMOTE_NOT_HOLEPUNCHABLE', 'REMOTE_NOT_HOLEPUNCHING', 'PEER_NOT_FOUND', 'PEER_CONNECTION_FAILED'
])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// An error nobody caught would abort the whole app (Bare's default). Instead we keep
// running, write it to <Documents>/.qvac-worker-errors.log and tell the app.
var reportFatal = null
var errorLogDir = null
function onFatal(kind, err) {
  const text = `${new Date().toISOString()} ${kind}: ${(err && err.stack) || err}`
  try { if (errorLogDir) fs.appendFileSync(errorLogDir + '/.qvac-worker-errors.log', text + '\n') } catch {}
  try { if (reportFatal) reportFatal(text); else pendingFatal.push(text) } catch {}
}

module.exports = function start(ipc) {
  if (loadError) {
    // No libraries: report the reason (the app shows it) and do nothing else
    const msg = `P2P non avviato, libreria mancante: ${(loadError && loadError.stack) || loadError}`
    ipc.write(Buffer.from ? Buffer.from(JSON.stringify({ event: 'worker.error', error: msg }) + '\n') : JSON.stringify({ event: 'worker.error', error: msg }) + '\n')
    ipc.on('data', (data) => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) continue
        try {
          const m = JSON.parse(line)
          if (m.id) ipc.write(JSON.stringify({ id: m.id, ok: false, error: msg }) + '\n')
        } catch {}
      }
    })
    return
  }
  let dht = null
  let keyPair = null
  let deviceInfo = { name: 'iPhone', platform: 'ios' }
  let filesDir = null // where files from the Mac are saved (the app's Documents folder)
  const macs = new Map() // mac key hex → session state
  let nostrPool = null // opened the first time LAN and Holepunch both fail
  let relayList = [...DEFAULT_RELAYS] // chosen by the app (Mac's list + the user's own)
  let myPaths = { lan: true, ble: true, p2p: true, nostr: true } // Impostazioni → Metodi di connessione
  let bleAvailable = false // the app has the native Bluetooth module
  let ble = null // the one Bluetooth link (byte stream) handled by the app, if open
  const bleRequests = new Map() // reqId → resolve, waiting for the app to open the radio link

  const meshes = new Map() // network code → { secrets, swarm, found, timer }
  let messenger = null // messages between devices (p2p-worker/msg-core.js)

  // A desktop of the network answered: check it knows the code AND is who it says (signature)
  async function onMeshConnection(m, conn) {
    conn.on('error', () => {})
    const lines = lineReader(conn)
    const { authKey } = m.secrets
    writeLine(conn, { type: 'mesh.hello', role: 'mobile', ...deviceInfo, proof: meshProof(authKey, conn.handshakeHash, keyPair.publicKey) })
    const hello = await lines.next(15000)
    if (hello.type !== 'mesh.hello' || !verifyMeshProof(authKey, conn.handshakeHash, conn.remotePublicKey, hello.proof)) return conn.destroy()
    const welcome = await lines.next(15000)
    if (welcome.type === 'mesh.error') { send({ event: 'mesh.status', code: m.secrets.code, error: welcome.error }); return conn.destroy() }
    if (welcome.type !== 'mesh.welcome' || !/^[0-9a-f]{64}$/.test(welcome.mac || '')) return conn.destroy()
    const ok = sodium.crypto_sign_verify_detached(
      b4a.from(String(welcome.sig || ''), 'hex'),
      b4a.concat([conn.handshakeHash, b4a.from('qvac-mesh-welcome')]),
      b4a.from(welcome.mac, 'hex')
    )
    conn.destroy()
    if (ok) reportMeshDesktop(m, { mac: welcome.mac, name: welcome.name, lan: welcome.lan || null, relays: welcome.relays || null, paths: welcome.paths || null, ble: welcome.ble || null, path: 'mesh' })
  }

  function reportMeshDesktop(m, result) {
    m.found = true
    send({ event: 'mesh.desktop', code: m.secrets.code, id: m.secrets.id, result })
  }

  // A path is used only if both this phone and that desktop allow it
  const allowed = (theirs, kind) => Boolean(myPaths[kind]) && (!theirs || theirs[kind] !== false)

  const send = (msg) => ipc.write(b4a.from(JSON.stringify(msg) + '\n'))
  reportFatal = (text) => send({ event: 'worker.error', error: text })
  for (const text of pendingFatal.splice(0)) reportFatal(text)
  lineReader(ipc).onEach(async (msg) => {
    try {
      const result = await commands[msg.cmd](msg)
      send({ id: msg.id, ok: true, result })
    } catch (err) {
      send({ id: msg.id, ok: false, error: err.message, code: err.code })
    }
  })

  const commands = {
    // Identity: the seed is generated here and kept by the app in the Keychain
    async init({ seed, name, platform, filesDir: dir, bluetooth, msgKey: msgKeyHex }) {
      bleAvailable = Boolean(bluetooth)
      if (dir) filesDir = decodeURIComponent(String(dir).replace(/^file:\/\//, '')).replace(/\/$/, '')
      errorLogDir = filesDir
      const seedBuf = seed ? b4a.from(seed, 'hex') : crypto.randomBytes(32)
      keyPair = DHT.keyPair(seedBuf)
      deviceInfo = { name: name || 'iPhone', platform: platform || 'ios' }
      if (!dht) dht = new DHT()
      const msgKey = startMessenger(msgKeyHex)
      await dht.fullyBootstrapped()
      return { seed: b4a.toString(seedBuf, 'hex'), publicKey: b4a.toString(keyPair.publicKey, 'hex'), nat: natInfo(), msgKey }
    },

    // New name for this phone: kept for the next hello, and told to the Macs online now
    async setDeviceName({ name }) {
      deviceInfo = { ...deviceInfo, name: String(name || 'iPhone').slice(0, 40) }
      if (messenger) messenger.setOptions({ name: deviceInfo.name })
      for (const state of macs.values()) {
        if (state.online && state.socket) writeLine(state.socket, { type: 'device.name', name: deviceInfo.name })
      }
      return true
    },

    // Nostr relays to use (applied at once if the pool is already open)
    async setRelays({ relays }) {
      if (Array.isArray(relays) && relays.length) relayList = relays
      if (nostrPool) nostrPool.setRelays(relayList)
      return true
    },

    async nostrStatus() {
      return {
        active: Boolean(nostrPool),
        relays: nostrPool ? nostrPool.status() : relayList.map((url) => ({ url, open: false }))
      }
    },

    // How this phone's network looks to Holepunch (for the Settings page)
    async netInfo() {
      ensureReady()
      return natInfo()
    },

    // One-time pairing with the QR code: on the home network first (with the QR's
    // secret, checking it is really that Mac), then through Holepunch
    // Mesh network: join with its permanent code; every desktop in it admits us and is reported
    // to the app as 'mesh.desktop' (then it is a paired desktop like any other)
    async joinMesh({ code }) {
      ensureReady()
      const secrets = meshSecrets(code) // throws on a bad code
      if (meshes.has(secrets.code)) return { id: secrets.id, code: secrets.code }
      const m = { secrets, swarm: null, found: false, timer: null }
      meshes.set(secrets.code, m)
      if (myPaths.p2p) {
        m.swarm = new Hyperswarm({ keyPair }) // its own DHT (destroying a swarm destroys its DHT)
        m.swarm.on('connection', (conn) => onMeshConnection(m, conn).catch(() => conn.destroy()))
        m.swarm.join(secrets.topic, { server: false, client: true })
      }
      // Nobody reached via Holepunch (VPN + mobile data…): the network's Nostr channel
      m.timer = setTimeout(async () => {
        if (m.found || !meshes.has(secrets.code) || !myPaths.nostr) return
        try { reportMeshDesktop(m, await pairViaNostr({ mac: null, token: secrets.token })) }
        catch (err) { send({ event: 'mesh.status', code: secrets.code, error: err.message }) }
      }, myPaths.p2p ? 20000 : 500)
      return { id: secrets.id, code: secrets.code }
    },

    async leaveMesh({ code }) {
      const m = meshes.get(code)
      if (!m) return true
      meshes.delete(code)
      clearTimeout(m.timer)
      if (m.swarm) await m.swarm.destroy().catch(() => {})
      return true
    },

    // Pairing with the code typed from the desktop's screen: same keys as its QR, derived from the code
    async pairWithCode({ code }) {
      const { seed, token } = inviteSecrets(code) // throws "Codice non valido"
      const pairingKey = b4a.toString(DHT.keyPair(seed).publicKey, 'hex')
      return commands.pair({ pairingKey, mac: null, token, lan: null, macPaths: null })
    },

    async pair({ pairingKey, mac, token, lan, macPaths }) {
      ensureReady()
      const can = (kind) => allowed(macPaths, kind)
      if (!can('lan') && !can('p2p') && !can('nostr')) {
        throw new Error('Nessun metodo di connessione in comune tra questo dispositivo e il desktop: controlla le Impostazioni')
      }
      let lastError = null
      if (can('lan') || can('p2p')) {
        try {
          // Without Nostr as a fallback, give Holepunch more time (a fresh invite needs a few seconds to be found)
          const punchMs = can('nostr') ? PUNCH_TIMEOUT_MS : PAIR_TIMEOUT_MS
          return await pairOnce({ pairingKey, mac, token, lan: can('lan') ? lan : null, tryP2P: can('p2p'), punchMs })
        } catch (err) {
          // A refusal from the desktop (QR used or expired) is final; a path that did not get through is not
          const unreachable = err.code === 'NO_DIRECT_PATH' || PUNCH_ERRORS.has(err.code) || /non risponde|non raggiungibile|chiusa/i.test(err.message)
          if (!token || !unreachable) throw err
          if (!can('nostr')) {
            // Say what was tried and what would help, instead of a bare "not reachable"
            const tried = [lan && can('lan') ? 'rete locale' : null, can('p2p') ? 'Holepunch' : null].filter(Boolean).join(' né ')
            const why = myPaths.nostr
              ? 'il desktop ha spento Nostr nei suoi Metodi di connessione'
              : 'Nostr è spento in Impostazioni → Metodi di connessione: accendilo per abbinare da qualsiasi rete'
            throw new Error(`Desktop non raggiunto via ${tried || 'nessun metodo'} (${err.code || err.message}). ${why}, oppure usa il QR da vicino.`)
          }
          lastError = err
        }
      }
      if (!token) throw new Error('QR non valido per questa via')
      send({ event: 'pairing', text: lastError ? `Collegamento diretto non riuscito (${lastError.code || lastError.message}): provo tramite i relay Nostr…` : 'Provo tramite i relay Nostr…' })
      return pairViaNostr({ mac, token })
    },

    // The app reports how opening the radio link went, and passes radio bytes in both directions
    async bleResult({ reqId, ok, error }) {
      const done = bleRequests.get(reqId)
      if (done) { bleRequests.delete(reqId); done(ok ? null : error || 'Bluetooth non riuscito') }
      return true
    },
    async bleData({ data }) {
      if (ble && !ble.destroyed) ble.push(b4a.from(String(data), 'base64'))
      return true
    },
    async bleClosed() {
      if (ble) ble.destroy()
      return true
    },

    // Impostazioni → Metodi di connessione: a connection on a path now off is dropped
    async setPaths({ paths }) {
      if (paths && Object.values(paths).some(Boolean)) myPaths = { lan: !!paths.lan, ble: paths.ble !== false, p2p: !!paths.p2p, nostr: !!paths.nostr }
      for (const state of macs.values()) {
        if (state.online && state.socket && !allowed(state.macPaths, state.via)) state.socket.destroy()
      }
      if (messenger) { messenger._syncDirect(); messenger._syncMailbox() }
      return myPaths
    },

    // Keep a live session with a paired Mac (reconnects by itself)
    async watch({ mac, name, lan, paths, bleSecret }) {
      ensureReady()
      if (messenger) messenger.upsertContact({ key: mac, name, kind: 'desktop', group: 'mine', source: 'paired' })
      const existing = macs.get(mac)
      if (existing) {
        // Re-paired (maybe from another network): fresh addresses, retry at once
        if (lan) existing.lan = lan
        if (paths) existing.macPaths = paths
        if (bleSecret) existing.bleSecret = bleSecret
        existing.revoked = false
        if (!existing.online && !existing.connecting) { clearTimeout(existing.timer); connectLoop(existing) }
      } else {
        const state = { mac, name, lan: lan || null, macPaths: paths || null, bleSecret: bleSecret || null, online: false, socket: null, stopped: false, timer: null }
        macs.set(mac, state)
        connectLoop(state)
      }
      return true
    },

    async unwatch({ mac }) {
      if (messenger) messenger.forgetSource(mac, 'paired')
      const state = macs.get(mac)
      if (state) {
        if (state.nostr) state.nostr.close()
        state.stopped = true
        clearTimeout(state.timer)
        if (state.socket) state.socket.destroy()
        macs.delete(mac)
      }
      return true
    },

    // Chat on one of the Mac's models: the answer streams back as 'chat' events
    // (chatId / transferId, not id: `id` is the request id of this very command)
    async chat({ mac, chatId, model, messages, ctx, phoneTools }) {
      const state = onlineMac(mac)
      state.chats.add(chatId)
      writeLine(state.socket, { type: 'chat', id: chatId, model, messages, ctx, phoneTools })
      return true
    },

    // Live CPU/GPU/RAM of the Mac for the dashboard (kept across reconnections)
    async systemWatch({ mac, on }) {
      const state = macs.get(mac)
      if (!state) return false
      state.systemWatch = Boolean(on)
      if (state.online && state.socket) writeLine(state.socket, { type: 'system.watch', on: state.systemWatch })
      return true
    },

    // Result of one of the phone's own connector tools, asked for by the desktop's model
    async chatPhoneResult({ mac, chatId, callId, isError, denied, text }) {
      const state = macs.get(mac)
      if (state && state.socket) writeLine(state.socket, { type: 'chat.phoneresult', id: chatId, callId, isError: isError === true, denied: denied === true, text: String(text ?? '') })
      return true
    },

    // Your answer to "may the desktop use this tool?"
    async chatConfirm({ mac, chatId, callId, approve }) {
      const state = macs.get(mac)
      if (state && state.socket) writeLine(state.socket, { type: 'chat.confirm', id: chatId, callId, approve: approve === true })
      return true
    },

    async chatCancel({ mac, chatId }) {
      const state = macs.get(mac)
      if (state && state.socket) writeLine(state.socket, { type: 'chat.cancel', id: chatId })
      return true
    },

    // Streams a file (a path inside the app) to the Mac; resolves when the Mac saved it
    async sendFile({ mac, path, name, transferId: id }) {
      const state = onlineMac(mac)
      const socket = state.socket
      const size = fs.statSync(path).size
      const ack = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'file.error', error: 'Il desktop non ha confermato la ricezione' }), 120000)
        state.acks.set(id, (m) => { clearTimeout(timer); resolve(m) })
      })
      try {
        await writeLineAsync(socket, { type: 'file.start', id, name, size })
        let sent = 0
        let carry = null
        const progress = throttle(() => send({ event: 'transfer', id, direction: 'out', mac, sent, total: size }))
        const push = async (piece) => {
          await writeLineAsync(socket, { type: 'file.chunk', id, data: b4a.toString(piece, 'base64') })
          sent += piece.length
          progress()
        }
        for await (const data of fs.createReadStream(path)) {
          let buf = carry ? b4a.concat([carry, data]) : data
          while (buf.length >= CHUNK_BYTES) {
            await push(buf.subarray(0, CHUNK_BYTES))
            buf = buf.subarray(CHUNK_BYTES)
          }
          carry = buf
        }
        if (carry && carry.length) await push(carry)
        await writeLineAsync(socket, { type: 'file.end', id })
        const reply = await ack
        if (reply.type !== 'file.ok') throw new Error(reply.error || 'Invio non riuscito')
        return { name: reply.name, size }
      } finally {
        state.acks.delete(id)
      }
    },

    // ---------- messages ----------
    async msgList() { return { contacts: msgr().contactList(), info: msgr().info() } },
    async msgHistory({ peer }) { return msgr().history(String(peer)) },
    async msgSend({ peer, text }) { return msgr().sendText(String(peer), text) },
    async msgSendFile({ peer, path, name, mime }) {
      return msgr().sendFile(String(peer), { path: decodeURIComponent(String(path).replace(/^file:\/\//, '')), name, mime })
    },
    async msgRead({ peer }) { msgr().markRead(String(peer)); return true },
    async msgDelete({ peer, messageId }) { return msgr().deleteMessage(String(peer), String(messageId)) },
    async msgInvite() { return msgr().createInvite() },
    async msgAcceptInvite({ code }) { return msgr().acceptInvite(code) },
    async msgCancelInvite() { msgr().cancelInvite(); return true },
    async msgRename({ peer, name }) { return msgr().renameContact(String(peer), name) },
    async msgRemove({ peer }) { return msgr().removeContact(String(peer)) },
    async msgOptions({ options }) { return msgr().setOptions(options || {}) },

    // App back in the foreground: retry offline Macs right away
    // (but not sooner than hyperdht allows after a failed holepunch)
    async refresh() {
      if (messenger) { messenger._syncMailbox(); messenger._flush() }
      for (const state of macs.values()) {
        if (state.punchFails && state.nextTry > Date.now()) continue
        if (!state.online && !state.connecting) {
          clearTimeout(state.timer)
          connectLoop(state)
        }
      }
      return true
    }
  }

  function msgr() {
    if (!messenger) throw new Error('Messaggi non pronti')
    return messenger
  }

  // Messages: state sealed with a key kept in the Keychain (given by the app; created the first time)
  function startMessenger(keyHex) {
    if (messenger || !filesDir) return keyHex || null
    const storeKey = keyHex && /^[0-9a-f]{64}$/.test(keyHex) ? b4a.from(keyHex, 'hex') : crypto.randomBytes(32)
    const swarmSeed = b4a.alloc(32)
    sodium.crypto_generichash(swarmSeed, b4a.concat([keyPair.secretKey, b4a.from('qvac-msg-swarm')]))
    let lastProgress = 0
    messenger = new Messenger({
      identity: keyPair,
      fs,
      dataDir: filesDir + '/.qvac-msg',
      filesDir: filesDir + '/Messaggi',
      storeKey,
      name: deviceInfo.name,
      kind: 'phone',
      Hyperswarm,
      swarmKeyPair: DHT.keyPair(swarmSeed),
      nostr: { ensurePool: () => (myPaths.nostr ? ensureNostrPool() : null), link: nostrLinkModule },
      allowDirect: () => myPaths.p2p,
      allowNostr: () => myPaths.nostr,
      onEvent: (ev) => {
        if (ev.type === 'progress') {
          if (Date.now() - lastProgress < 250 && ev.done < ev.total) return
          lastProgress = Date.now()
        }
        send({ event: 'msg', ...ev })
      }
    })
    messenger.start()
    return b4a.toString(storeKey, 'hex')
  }

  function ensureReady() {
    if (!dht || !keyPair) throw new Error('P2P non inizializzato')
  }

  function natInfo() {
    return {
      firewalled: Boolean(dht && dht.firewalled),
      randomized: Boolean(dht && dht.randomized),
      online: Boolean(dht && dht.online !== false)
    }
  }

  // First pairing through the Nostr relays, on a channel derived from the QR's secret.
  // One-time keys first (forward secrecy), then the request, signed with our key.
  async function pairViaNostr({ mac, token }) {
    if (!(await waitRelays(8000))) throw new Error('Nessun relay Nostr raggiungibile: controlla la connessione')
    const keys = pairingKeys(token)
    const oneTime = oneTimeKeyPair()
    const e = b4a.toString(oneTime.publicKey, 'hex')
    let key = null
    let request = null
    return new Promise((resolve, reject) => {
      let resend = null
      let timer = null
      const unsub = listenSealed(nostrPool, keys.macPub, keys.encKey, (msg) => {
        if (msg.re !== e) return
        if (msg.type === 'pair-hello' && !key) {
          const shared = exchange(oneTime.secretKey, msg.e)
          if (!shared) return
          key = pairingTrafficKey(shared, keys, e, msg.e)
          wipe(oneTime.secretKey)
          request = {
            type: 'pair',
            e,
            box: seal(key, {
              ...deviceInfo,
              publicKey: b4a.toString(keyPair.publicKey, 'hex'),
              proof: pairingProof(keyPair, token, e, msg.e) // the Mac knows it is really us
            })
          }
          ask()
          return
        }
        if (msg.type !== 'pair-reply' || !key) return
        const reply = open(key, msg.box)
        if (!reply) return
        if (reply.type === 'error') return done(new Error(reply.error || 'Abbinamento rifiutato'))
        if (reply.type !== 'paired') return
        if (mac && reply.mac !== mac) return done(new Error('Il desktop ha risposto con una chiave diversa da quella del QR'))
        done(null, { mac: reply.mac, name: reply.name, lan: reply.lan || null, relays: reply.relays || null, paths: reply.paths || null, ble: reply.ble || null, path: 'nostr' })
      })
      function done(err, value) {
        clearInterval(resend)
        clearTimeout(timer)
        unsub()
        wipe(oneTime.secretKey)
        wipe(key)
        if (err) reject(err)
        else resolve(value)
      }
      // Until the Mac answers we repeat the current step (it answers repeats the same way)
      const ask = () => sendSealed(nostrPool, keys.devSk, keys.devPub, keys.encKey, request || { type: 'pair-hello', e })
      setTimeout(ask, 800) // let our subscription reach the relays first
      resend = setInterval(ask, 4000)
      timer = setTimeout(() => done(new Error('Il desktop non risponde nemmeno via Nostr: la board è accesa e il codice (o il QR) ancora valido?')), 40000)
    })
  }

  async function pairOnce({ pairingKey, mac, token, lan, tryP2P = true, punchMs = PUNCH_TIMEOUT_MS }) {
    let socket = null
    let path = 'lan'
    if (token && lan) {
      send({ event: 'pairing', text: 'Cerco il desktop nella stessa rete…' })
      socket = await connectLanTo(lan, mac).catch(() => null)
    }
    if (!socket) {
      if (!tryP2P) throw Object.assign(new Error('Non è nella stessa rete'), { code: 'NO_DIRECT_PATH' })
      path = 'p2p'
      send({ event: 'pairing', text: `${lan ? 'Non è nella stessa rete: p' : 'P'}rovo Holepunch (fino a ${Math.round(punchMs / 1000)} s)…` })
      socket = dht.connect(b4a.from(pairingKey, 'hex'), { keyPair })
    }
    const lines = lineReader(socket)
    try {
      if (path === 'p2p') await opened(socket, punchMs)
      writeLine(socket, { type: 'pair', token, ...deviceInfo })
      const reply = await lines.next(PAIR_TIMEOUT_MS)
      if (reply.type !== 'paired') throw new Error(reply.error || 'Abbinamento rifiutato')
      if (mac && reply.mac !== mac) throw new Error('Il desktop ha risposto con una chiave diversa da quella del QR')
      return { mac: reply.mac, name: reply.name, lan: reply.lan || lan || null, relays: reply.relays || null, paths: reply.paths || null, ble: reply.ble || null, path }
    } finally {
      socket.destroy()
    }
  }

  function onlineMac(mac) {
    const state = macs.get(mac)
    if (!state || !state.online || !state.socket) throw new Error('Il desktop non è collegato')
    return state
  }

  // A file sent by the Mac: written in pieces, renamed when complete
  function onIncomingFile(state, socket, msg) {
    const id = String(msg.id || '').slice(0, 40)
    const fail = (error) => {
      const t = state.incoming.get(id)
      if (t) { t.stream.destroy(); try { fs.rmSync(t.tmp, { force: true }) } catch { } state.incoming.delete(id) }
      writeLine(socket, { type: 'file.error', id, error })
    }
    if (msg.type === 'file.start') {
      if (!filesDir) return fail('L’app non può salvare file')
      const size = Number(msg.size)
      const tmp = filesDir + '/.' + id + '.part'
      const stream = fs.createWriteStream(tmp)
      const progress = throttle(() => send({ event: 'transfer', id, direction: 'in', mac: state.mac, name: msg.name, sent: t.received, total: size }))
      const t = { stream, tmp, name: safeFileName(msg.name), size, received: 0, progress }
      state.incoming.set(id, t)
      progress()
    } else if (msg.type === 'file.chunk') {
      const t = state.incoming.get(id)
      if (!t) return
      const buf = b4a.from(String(msg.data || ''), 'base64')
      t.received += buf.length
      if (t.received > t.size) return fail('File più lungo del previsto')
      t.stream.write(buf)
      t.progress()
    } else if (msg.type === 'file.end') {
      const t = state.incoming.get(id)
      if (!t) return
      state.incoming.delete(id)
      if (t.received !== t.size) return fail('File incompleto')
      t.stream.end(() => {
        const final = uniquePath(filesDir, t.name)
        fs.renameSync(t.tmp, final)
        const name = final.slice(filesDir.length + 1)
        writeLine(socket, { type: 'file.ok', id, name })
        send({ event: 'file', mac: state.mac, id, name, size: t.size })
      })
    }
  }

  function emit(state, extra = {}) {
    send({
      event: 'status',
      mac: state.mac,
      name: state.name,
      online: state.online,
      sameNetwork: state.sameNetwork ?? null,
      rtt: state.rtt ?? null,
      via: state.online ? state.via : null,
      lan: state.lan || null,
      models: state.models || [],
      revoked: Boolean(state.revoked),
      relays: state.relays || null,
      step: state.online ? null : state.step || null,
      since: state.online ? state.since : null,
      macPaths: state.macPaths || null,
      bleSecret: state.bleSecret || null,
      error: state.online ? null : state.lastError || null, // why it is offline (kept until it reconnects)
      nextTry: state.online ? null : state.nextTry || null,
      ...extra
    })
  }

  // Encrypted TCP to the Mac's home address; resolves null if it is not reachable
  function connectLan(state) {
    return connectLanTo(state.lan, state.mac)
  }

  async function connectLanTo(lan, expectedMac) {
    if (!lan || !lan.port || !Array.isArray(lan.addresses)) return null
    for (const host of lan.addresses) {
      const sock = tcp.createConnection(lan.port, host)
      sock.on('error', () => { })
      const stream = new SecretStream(true, sock, { keyPair })
      stream.on('error', () => { })
      const ok = await Promise.race([
        stream.opened,
        new Promise((resolve) => setTimeout(() => resolve(false), LAN_TIMEOUT_MS))
      ])
      // Only our Mac has its private key: anything else on that address is dropped
      if (ok && stream.remotePublicKey && b4a.toString(stream.remotePublicKey, 'hex') === expectedMac) return stream
      stream.destroy()
    }
    return null
  }

  function ensureNostrPool() {
    if (!nostrPool) nostrPool = new RelayPool({ createSocket: bareWebSocket, relays: relayList, log: (text) => send({ event: 'nostr.log', text }) })
    return nostrPool
  }

  async function waitRelays(ms) {
    const pool = ensureNostrPool()
    const until = Date.now() + ms
    while (!pool.openCount && Date.now() < until) await sleep(100)
    return pool.openCount > 0
  }

  // Which path we are trying now, shown in the app while offline
  function step(state, name) {
    state.step = name
    if (!state.online) emit(state)
  }

  // ---------- Bluetooth ----------
  // The radio itself lives in the app (CoreBluetooth); here it is a byte stream with the
  // same encryption as the local network on top, and we check it is really our desktop.

  async function connectBle(state) {
    if (!bleAvailable || !state.bleSecret || (ble && !ble.destroyed)) return null
    const reqId = b4a.toString(crypto.randomBytes(6), 'hex')
    const error = await new Promise((resolve) => {
      bleRequests.set(reqId, resolve)
      send({ event: 'ble.connect', reqId, uuids: bleServiceUuids(state.bleSecret), timeoutMs: 5000 })
      setTimeout(() => { if (bleRequests.delete(reqId)) resolve('timeout') }, 9000)
    })
    if (error) return null
    const link = new BleStream()
    ble = link
    const stream = new SecretStream(true, link, { keyPair })
    stream.on('error', () => { })
    const ok = await Promise.race([stream.opened, sleep(8000).then(() => false)])
    if (ok && stream.remotePublicKey && b4a.toString(stream.remotePublicKey, 'hex') === state.mac) return stream
    stream.destroy()
    return null
  }

  class BleStream extends Duplex {
    _write(data, cb) {
      send({ event: 'ble.write', data: b4a.toString(data, 'base64') })
      cb(null)
    }

    _destroy(cb) {
      if (ble === this) ble = null
      send({ event: 'ble.close' })
      cb(null)
    }
  }

  // Holepunch, if hyperdht's pacing allows it now; null if it does not get through
  async function tryP2P(state) {
    if (state.nextPunch && Date.now() < state.nextPunch) return null
    const socket = dht.connect(b4a.from(state.mac, 'hex'), { keyPair })
    try {
      await opened(socket, PUNCH_TIMEOUT_MS)
      state.punchFails = 0
      state.nextPunch = 0
      return socket
    } catch (err) {
      socket.destroy()
      state.lastError = err.code || err.message
      if (PUNCH_ERRORS.has(err.code)) {
        state.punchFails = (state.punchFails || 0) + 1
        state.nextPunch = Date.now() + PUNCH_RETRY_MS[Math.min(state.punchFails, PUNCH_RETRY_MS.length) - 1]
      }
      return null
    }
  }

  // Best available path: home network → Holepunch → Nostr relays
  async function acquire(state) {
    if (state.pending) {
      const p = state.pending
      state.pending = null
      if (!p.socket.destroyed) return p
    }
    const can = (kind) => allowed(state.macPaths, kind)
    if (!can('lan') && !can('ble') && !can('p2p') && !can('nostr')) {
      throw new Error('Nessun metodo di connessione in comune con il desktop: controlla le Impostazioni')
    }
    if (can('lan')) {
      step(state, 'lan')
      const lan = await connectLan(state).catch(() => null)
      if (lan) return { socket: lan, via: 'lan' }
    }
    if (can('ble') && bleAvailable && state.bleSecret) {
      step(state, 'ble')
      const radio = await connectBle(state).catch(() => null)
      if (radio) return { socket: radio, via: 'ble' }
    }
    if (can('p2p')) {
      if (!state.nextPunch || Date.now() >= state.nextPunch) step(state, 'p2p')
      const p2p = await tryP2P(state)
      if (p2p) return { socket: p2p, via: 'p2p' }
    }
    if (!can('nostr')) throw new Error(state.lastError || 'Desktop non raggiungibile con i metodi di connessione attivi')
    step(state, 'nostr')
    if (!(await waitRelays(8000))) throw new Error('Desktop non raggiungibile (nemmeno via Nostr)')
    if (!state.nostr) state.nostr = new NostrPeer({ pool: nostrPool, keyPair, remotePublicKey: b4a.from(state.mac, 'hex'), role: 'device' })
    await sleep(state.nostrReady ? 0 : 1500) // first time: let the subscription reach the relays
    state.nostrReady = true
    return { socket: state.nostr.connect(), via: 'nostr' }
  }

  async function connectLoop(state) {
    if (state.stopped) return
    state.connecting = true
    state.upgrade = false
    let socket
    try {
      ({ socket, via: state.via } = await acquire(state))
    } catch (err) {
      state.connecting = false
      state.step = null
      state.lastError = err.code || err.message
      emit(state, { error: state.lastError })
      state.nextTry = Date.now() + RECONNECT_MS
      if (!state.stopped) state.timer = setTimeout(() => connectLoop(state), RECONNECT_MS)
      return
    }
    const lines = lineReader(socket)
    state.socket = socket
    state.chats = new Set() // chats waiting for an answer on this connection
    state.acks = new Map() // files we sent, waiting for the Mac's confirmation
    state.incoming = new Map() // files the Mac is sending us
    let pinger = null
    let prober = null
    let watchdog = null
    let msgLink = null
    try {
      writeLine(socket, { type: 'hello', ...deviceInfo })
      const welcome = await lines.next(15000)
      if (welcome.type === 'error' && welcome.code === 'NOT_AUTHORIZED') {
        state.revoked = true
        throw Object.assign(new Error(welcome.error), { code: 'NOT_AUTHORIZED' })
      }
      if (welcome.type !== 'welcome') throw new Error('Risposta inattesa dal desktop')
      state.revoked = false
      state.lastError = null
      if (state.via !== 'nostr') state.punchFails = 0 // a direct path works: Holepunch pacing starts over
      state.online = true
      state.since = Date.now()
      state.name = welcome.name || state.name
      if (welcome.lan) state.lan = welcome.lan
      state.models = Array.isArray(welcome.models) ? welcome.models : []
      if (Array.isArray(welcome.relays)) state.relays = welcome.relays
      if (welcome.paths) state.macPaths = welcome.paths
      if (welcome.ble && welcome.ble.secret) state.bleSecret = welcome.ble.secret
      if (state.systemWatch) writeLine(socket, { type: 'system.watch', on: true })
      // Messages travel on this session too (the desktop also keeps them for our other devices)
      if (messenger) {
        msgLink = streamLink(socket, { fast: state.via !== 'nostr', kind: 'session' })
        msgLink.via = state.via
        messenger.addLink(state.mac, msgLink)
      }
      state.sameNetwork = state.via === 'lan' ? true : state.via === 'nostr' ? false : isPrivate(socket.rawStream && socket.rawStream.remoteHost)
      emit(state)

      // Not on the best path: keep looking for a better one (home network, then
      // Holepunch when we are on Nostr) and switch to it when found
      if (state.via !== 'lan') {
        prober = setInterval(async () => {
          if (state.probing || socket.destroyed) return
          // Never switch path in the middle of a chat or a file transfer
          if (state.chats.size || state.acks.size || state.incoming.size) return
          if (messenger && msgLink && messenger.isBusy(msgLink)) return // a photo or file is on its way
          state.probing = true
          // Only methods ranked above the current one: lan > ble > p2p > nostr
          const rank = ['lan', 'ble', 'p2p', 'nostr']
          const above = (kind) => rank.indexOf(kind) < rank.indexOf(state.via) && allowed(state.macPaths, kind)
          let better = null
          const lan = above('lan') && state.lan ? await connectLan(state).catch(() => null) : null
          if (lan) better = { socket: lan, via: 'lan' }
          if (!better && above('ble') && bleAvailable && state.bleSecret) {
            const radio = await connectBle(state).catch(() => null)
            if (radio) better = { socket: radio, via: 'ble' }
          }
          if (!better && above('p2p')) {
            const p2p = await tryP2P(state)
            if (p2p) better = { socket: p2p, via: 'p2p' }
          }
          state.probing = false
          if (!better) return
          if (socket.destroyed) return better.socket.destroy()
          state.pending = better // the loop reconnects at once, on this one
          state.upgrade = true
          socket.destroy()
        }, LAN_PROBE_MS)
      }

      state.lastSeen = Date.now()
      lines.onEach((msg) => {
        state.lastSeen = Date.now()
        const type = String(msg.type || '')
        if (type === 'ping') writeLine(socket, { type: 'pong', t: msg.t })
        else if (type === 'pong') {
          state.rtt = Date.now() - msg.t
          emit(state)
        } else if (type.startsWith('chat.')) {
          const kind = type.slice(5)
          if (kind === 'done' || kind === 'error') state.chats.delete(msg.id)
          send({
            event: 'chat', mac: state.mac, id: msg.id, kind, text: msg.text, error: msg.error, tokensPerSecond: msg.tokensPerSecond,
            // connector tools used by the desktop's agent (kind 'tool' / 'confirm')
            callId: msg.callId, server: msg.server, tool: msg.tool, args: msg.args, status: msg.status, summary: msg.summary, remote: msg.remote
          })
        } else if (type === 'mac.name') {
          if (msg.name) state.name = String(msg.name).slice(0, 40)
          emit(state)
        } else if (type === 'ble') {
          if (msg.ble && msg.ble.secret) state.bleSecret = msg.ble.secret // new secret after a revoke
          emit(state)
        } else if (type === 'paths') {
          state.macPaths = msg.paths || null
          if (!allowed(state.macPaths, state.via)) socket.destroy() // the desktop closed this path
        } else if (type === 'relays') {
          state.relays = Array.isArray(msg.relays) ? msg.relays : state.relays
          emit(state)
        } else if (type === 'system') {
          const { type: _t, ...snapshot } = msg
          send({ event: 'system', mac: state.mac, ...snapshot })
        } else if (type.startsWith('msg') || type.startsWith('blob.')) {
          if (messenger && msgLink) messenger.onLine(state.mac, msgLink, msg)
        } else if (type === 'file.ok' || type === 'file.error') {
          const ack = state.acks.get(msg.id)
          if (ack) ack(msg)
        } else if (type.startsWith('file.')) {
          onIncomingFile(state, socket, msg)
        }
      })
      const ping = () => writeLine(socket, { type: 'ping', t: Date.now() })
      // E.g. we left home: the Wi-Fi link is dead but iOS has not closed it yet
      watchdog = setInterval(() => {
        if (Date.now() - state.lastSeen <= STALE_MS) return
        state.lastError = 'Nessuna risposta da 30 s'
        socket.destroy()
      }, 5000)
      ping()
      pinger = setInterval(ping, PING_MS)
      await closed(socket)
    } catch (err) {
      state.lastError = err.code || err.message
      emit(state, { error: state.lastError })
    } finally {
      clearInterval(pinger)
      clearInterval(prober)
      clearInterval(watchdog)
      if (messenger && msgLink) messenger.removeLink(state.mac, msgLink)
      socket.destroy()
      // Whatever was in flight on this connection is lost: say so instead of waiting forever
      for (const id of state.chats || []) send({ event: 'chat', mac: state.mac, id, kind: 'error', error: 'Collegamento col desktop interrotto' })
      for (const ack of (state.acks || new Map()).values()) ack({ type: 'file.error', error: 'Collegamento col desktop interrotto' })
      for (const t of (state.incoming || new Map()).values()) { t.stream.destroy(); try { fs.rmSync(t.tmp, { force: true }) } catch { } }
      state.chats = new Set()
      state.acks = new Map()
      state.incoming = new Map()
      state.connecting = false
      state.step = null
      const wasOnline = state.online
      state.online = false
      state.socket = null
      if (wasOnline && !state.upgrade) emit(state)
      // Revoked: no point hammering the Mac, try again now and then (it may be re-paired).
      // (Holepunch's own pace is handled in tryP2P: meanwhile Nostr is used.)
      const wait = state.upgrade ? 0 : state.revoked ? 30000 : RECONNECT_MS
      state.nextTry = Date.now() + wait
      if (!state.stopped) state.timer = setTimeout(() => connectLoop(state), wait)
    }
  }
}

// ---------- helpers ----------

// The desktop's Bluetooth code for this hour (and the next/previous one, for clock skew).
// Same formula as qvac-web-server/p2p/ble.js: sha256("qvac-ble:<secret>:<hour>") → UUID v4 layout
function bleServiceUuids(secret) {
  const hour = Math.floor(Date.now() / 3600000)
  return [hour, hour - 1, hour + 1].map((h) => {
    const out = b4a.alloc(32)
    sodium.crypto_hash_sha256(out, b4a.from(`qvac-ble:${secret}:${h}`))
    const b = out.subarray(0, 16)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const x = b4a.toString(b, 'hex')
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
  })
}

// bare-ws in the shape nostr-link expects
function bareWebSocket(url, h) {
  const ws = new WebSocket(url)
  ws.on('open', () => h.onopen())
  // Read the stream itself ('data'), not just the 'message' event: bare-ws also pushes every
  // message into its readable side, and when nobody consumes it, it pauses the socket —
  // the relay then looks open but stays silent (lost Nostr traffic after a burst of events)
  ws.on('data', (data) => h.onmessage(b4a.toString(data)))
  ws.on('close', () => h.onclose())
  ws.on('error', () => { })
  return { send: (text) => ws.write(text, 'utf8'), close: () => ws.destroy() }
}

function writeLine(stream, msg) {
  if (stream.destroyed) return true
  return stream.write(b4a.from(JSON.stringify(msg) + '\n'))
}

// Like writeLine, but waits when the stream asks us to slow down (big files)
function writeLineAsync(stream, msg) {
  if (writeLine(stream, msg)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { stream.off('drain', done); stream.off('close', gone); resolve() }
    const gone = () => { stream.off('drain', done); reject(new Error('Collegamento interrotto')) }
    stream.once('drain', done)
    stream.once('close', gone)
  })
}

// At most one call every 250 ms (progress bars)
function throttle(fn) {
  let last = 0
  return () => {
    const now = Date.now()
    if (now - last > 250) { last = now; fn() }
  }
}

function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[:\x00-\x1f]/g, '_').replace(/^\.+/, '').trim()
  return base.slice(0, 150) || 'file'
}

function uniquePath(dir, name) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = dir + '/' + name
  for (let i = 2; fs.existsSync(candidate); i++) candidate = dir + '/' + stem + ' (' + i + ')' + ext
  return candidate
}

// One reader per connection, attached as soon as the socket exists: a stream
// drops data that arrives while nobody listens, so we never detach. Messages
// go to a pending next(), else to the permanent handler, else into a queue.
function lineReader(stream) {
  let buf = ''
  const queue = []
  let waiter = null
  let handler = null
  let closedErr = null

  stream.on('data', (data) => {
    buf += b4a.toString(data)
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      deliver(msg)
    }
    if (buf.length > 64 * 1024) stream.destroy() // an unfinished line this long is not ours
  })
  const fail = () => {
    closedErr = closedErr || new Error('Connessione chiusa dal desktop')
    if (waiter) settle(waiter, closedErr)
  }
  stream.on('close', fail)
  stream.on('error', fail)

  function settle(w, err, msg) {
    waiter = null
    clearTimeout(w.timer)
    if (err) w.reject(err)
    else w.resolve(msg)
  }
  function deliver(msg) {
    if (waiter) settle(waiter, null, msg)
    else if (handler) handler(msg)
    else queue.push(msg)
  }

  return {
    next(timeout) {
      if (queue.length) return Promise.resolve(queue.shift())
      if (closedErr) return Promise.reject(closedErr)
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject, timer: setTimeout(() => settle(waiter, new Error('Il desktop non risponde')), timeout) }
      })
    },
    onEach(fn) {
      handler = fn
      while (queue.length) fn(queue.shift())
    }
  }
}

function opened(socket, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Desktop non raggiungibile')) }, timeout)
    socket.once('open', () => { clearTimeout(timer); resolve() })
    socket.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function closed(socket) {
  return new Promise((resolve) => {
    socket.once('close', resolve)
    socket.once('error', resolve)
  })
}

function isPrivate(ip) {
  if (!ip) return null
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|fc|fd|fe80)/i.test(ip)
}
