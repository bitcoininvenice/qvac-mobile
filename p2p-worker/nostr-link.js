'use strict'
// Third path between the iPhone and the Mac: public Nostr relays.
// Used only when the home network and Holepunch both fail (e.g. Mac behind a
// VPN + iPhone on mobile data). Both sides only open outgoing WebSockets, so
// no NAT or VPN is in the way.
//
// Privacy: relays see two random-looking Nostr keys exchanging ephemeral events
// (kind 21210, not stored). The content is encrypted end to end with a key that
// only the Mac and the paired iPhone can derive (X25519 of their Holepunch keys),
// so it also proves who sent it. The Nostr keys are derived from that secret and
// cannot be linked to the Holepunch identities.
//
// The same file is used by both projects — keep these two copies identical:
//   qvac-mobile/p2p-worker/nostr-link.js   (iPhone, Bare)
//   qvac-web-server/p2p/nostr-link.cjs     (desktop, Node)
const { schnorr, secp256k1 } = require('@noble/curves/secp256k1')
const { sha256 } = require('@noble/hashes/sha256')
const sodium = require('sodium-universal')
const b4a = require('b4a')

const KIND = 21210 // ephemeral range (20000–29999): relays forward, never store
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
const MAX_RELAYS = 8

// Clean list of relay URLs: wss:// (ws:// only for local tests), no duplicates
function normalizeRelays (list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const url = String(raw || '').trim().replace(/\/+$/, '')
    if (!/^wss?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/i.test(url)) continue
    if (url.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) continue
    if (!out.includes(url)) out.push(url)
    if (out.length >= MAX_RELAYS) break
  }
  return out
}
const MAX_EVENT_PLAINTEXT = 40 * 1024 // relays commonly refuse events above ~64 KB
const SEND_INTERVAL_MS = 120 // ~8 events/s: polite with public relays
const HIGH_WATER = 256 * 1024 // write() returns false above this (backpressure)
const MAX_AGE_S = 120 // events older than this are ignored (replays)
const REORDER_WAIT_MS = 3000 // a missing event is skipped after this long

// ---------- tiny event emitter (works in Node and Bare without imports) ----------

class Emitter {
  constructor () { this._handlers = new Map() }
  on (name, fn) { (this._handlers.get(name) || this._handlers.set(name, []).get(name)).push(fn); return this }
  once (name, fn) {
    const wrap = (...args) => { this.off(name, wrap); fn(...args) }
    wrap._orig = fn
    return this.on(name, wrap)
  }
  off (name, fn) {
    const list = this._handlers.get(name)
    if (list) this._handlers.set(name, list.filter((h) => h !== fn && h._orig !== fn))
    return this
  }
  emit (name, ...args) {
    for (const fn of [...(this._handlers.get(name) || [])]) fn(...args)
  }
}

// ---------- keys and encryption ----------

function hash (data, key) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, data, key)
  return out
}

// A valid secp256k1 secret key from 32 bytes (re-hash in the ~2^-128 case it is not)
function nostrSecret (seed) {
  let sk = seed
  while (!secp256k1.utils.isValidPrivateKey(sk)) sk = hash(sk)
  return sk
}

// Same result on both sides: { encKey, mySk, myPub, theirPub }
function deriveKeys ({ keyPair, remotePublicKey, role }) {
  const curveSk = b4a.alloc(32)
  const curvePk = b4a.alloc(32)
  const shared = b4a.alloc(32)
  sodium.crypto_sign_ed25519_sk_to_curve25519(curveSk, keyPair.secretKey)
  sodium.crypto_sign_ed25519_pk_to_curve25519(curvePk, remotePublicKey)
  sodium.crypto_scalarmult(shared, curveSk, curvePk)
  const macPk = role === 'mac' ? keyPair.publicKey : remotePublicKey
  const devPk = role === 'mac' ? remotePublicKey : keyPair.publicKey
  const root = hash(b4a.concat([shared, macPk, devPk]), b4a.from('qvac-board/nostr/v1'))
  const macSk = nostrSecret(hash(b4a.from('mac'), root))
  const devSk = nostrSecret(hash(b4a.from('device'), root))
  const hex = (sk) => b4a.toString(b4a.from(schnorr.getPublicKey(sk)), 'hex')
  return {
    encKey: hash(b4a.from('enc'), root),
    mySk: role === 'mac' ? macSk : devSk,
    myPub: hex(role === 'mac' ? macSk : devSk),
    theirPub: hex(role === 'mac' ? devSk : macSk)
  }
}

function seal (key, obj) {
  const msg = b4a.from(JSON.stringify(obj))
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(msg.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(box, msg, nonce, key)
  return b4a.toString(b4a.concat([nonce, box]), 'base64')
}

function open (key, text) {
  try {
    const raw = b4a.from(text, 'base64')
    const nonce = raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
    const box = raw.subarray(sodium.crypto_secretbox_NONCEBYTES)
    if (box.length < sodium.crypto_secretbox_MACBYTES) return null
    const msg = b4a.alloc(box.length - sodium.crypto_secretbox_MACBYTES)
    if (!sodium.crypto_secretbox_open_easy(msg, box, nonce, key)) return null
    return JSON.parse(b4a.toString(msg))
  } catch {
    return null
  }
}

function signEvent (sk, pubkey, content) {
  const created_at = Math.floor(Date.now() / 1000) // eslint-disable-line camelcase
  const tags = []
  const id = b4a.toString(b4a.from(sha256(b4a.from(JSON.stringify([0, pubkey, created_at, KIND, tags, content])))), 'hex')
  const aux = b4a.alloc(32)
  sodium.randombytes_buf(aux)
  const sig = b4a.toString(b4a.from(schnorr.sign(id, sk, aux)), 'hex')
  return { id, pubkey, created_at, kind: KIND, tags, content, sig } // eslint-disable-line camelcase
}

// ---------- relay pool ----------
// createSocket(url) → { send(text), close() } and calls
// handlers.onopen(), handlers.onmessage(text), handlers.onclose()

class RelayPool extends Emitter {
  constructor ({ relays = DEFAULT_RELAYS, createSocket, log = () => {} }) {
    super()
    this.urls = normalizeRelays(relays)
    if (!this.urls.length) this.urls = [...DEFAULT_RELAYS]
    this.createSocket = createSocket
    this.log = log
    this.conns = new Map() // url → { sock, open, backoff, timer }
    this.subs = new Map() // sub id → { filter, onEvent }
    this.seen = new Map() // event id → time (dedupe across relays)
    this.closed = false
    this._seq = 0
    for (const url of this.urls) this._connect(url)
  }

  get openCount () {
    let n = 0
    for (const c of this.conns.values()) if (c.open) n++
    return n
  }

  // Relays can change while running: drop removed ones, connect new ones
  setRelays (relays) {
    const next = normalizeRelays(relays)
    if (!next.length) return this.urls
    for (const [url, conn] of this.conns) {
      if (next.includes(url)) continue
      clearTimeout(conn.timer)
      conn.dropped = true
      try { conn.sock && conn.sock.close() } catch {}
      this.conns.delete(url)
    }
    const added = next.filter((url) => !this.urls.includes(url))
    this.urls = next
    for (const url of added) this._connect(url)
    this.emit('status')
    return this.urls
  }

  status () {
    return this.urls.map((url) => ({ url, open: Boolean(this.conns.get(url) && this.conns.get(url).open) }))
  }

  _connect (url) {
    if (this.closed || !this.urls.includes(url)) return
    const prev = this.conns.get(url)
    const conn = { sock: null, open: false, backoff: prev ? prev.backoff : 2000, timer: null }
    this.conns.set(url, conn)
    const retry = () => {
      if (this.closed || conn.timer || conn.dropped) return
      conn.open = false
      this.emit('status')
      conn.timer = setTimeout(() => this._connect(url), conn.backoff)
      conn.backoff = Math.min(conn.backoff * 2, 30000)
    }
    try {
      conn.sock = this.createSocket(url, {
        onopen: () => {
          conn.open = true
          conn.backoff = 2000
          for (const [id, s] of this.subs) this._send(conn, ['REQ', id, s.filter])
          this.emit('status')
        },
        onmessage: (text) => this._onMessage(url, text),
        onclose: retry
      })
    } catch (err) {
      this.log(`nostr: ${url} ${err.message}`)
      retry()
    }
  }

  _send (conn, msg) {
    if (!conn.open) return false
    try { conn.sock.send(JSON.stringify(msg)); return true } catch { return false }
  }

  _onMessage (url, text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }
    if (msg[0] === 'EVENT') {
      const sub = this.subs.get(msg[1])
      const ev = msg[2]
      if (!sub || !ev || typeof ev.id !== 'string' || this.seen.has(ev.id)) return
      this.seen.set(ev.id, Date.now())
      if (this.seen.size > 5000) {
        for (const id of [...this.seen.keys()].slice(0, 1000)) this.seen.delete(id)
      }
      sub.onEvent(ev)
    } else if (msg[0] === 'OK' && msg[2] === false) {
      this.log(`nostr: ${url} ha rifiutato un evento: ${msg[3]}`)
    } else if (msg[0] === 'NOTICE') {
      this.log(`nostr: ${url}: ${msg[1]}`)
    } else if (msg[0] === 'CLOSED' && this.subs.has(msg[1])) {
      // The relay dropped one of our subscriptions (e.g. rate limit): ask again later
      this.log(`nostr: ${url} ha chiuso una sottoscrizione: ${msg[2] || ''}`)
      const conn = this.conns.get(url)
      const id = msg[1]
      setTimeout(() => { const s = this.subs.get(id); if (s && conn && conn.open) this._send(conn, ['REQ', id, s.filter]) }, 15000)
    }
  }

  publish (event) {
    let sent = 0
    for (const conn of this.conns.values()) if (this._send(conn, ['EVENT', event])) sent++
    return sent > 0
  }

  subscribe (filter, onEvent) {
    const id = 'q' + (++this._seq).toString(36) + Math.random().toString(36).slice(2, 6)
    this.subs.set(id, { filter, onEvent })
    for (const conn of this.conns.values()) this._send(conn, ['REQ', id, filter])
    return () => {
      this.subs.delete(id)
      for (const conn of this.conns.values()) this._send(conn, ['CLOSE', id])
    }
  }

  close () {
    this.closed = true
    for (const conn of this.conns.values()) {
      clearTimeout(conn.timer)
      try { conn.sock && conn.sock.close() } catch {}
    }
  }
}

// ---------- one-time keys (forward secrecy) ----------
// Every session (and every pairing) starts with a fresh X25519 key pair on each
// side. The traffic key mixes their exchange with the long-term secret, so:
//  - only the two real devices can compute it (authentication), and
//  - once the session ends and the one-time keys are wiped, even someone who later
//    steals a device's long-term key cannot decrypt traffic recorded on the relays.

function oneTimeKeyPair () {
  const secretKey = randomBytes(32)
  const publicKey = b4a.alloc(32)
  sodium.crypto_scalarmult_base(publicKey, secretKey)
  return { publicKey, secretKey }
}

// X25519 with the other side's one-time public key (hex); null if it is not a valid key
function exchange (secretKey, publicKeyHex) {
  try {
    const pk = b4a.from(String(publicKeyHex), 'hex')
    if (pk.length !== 32) return null
    const out = b4a.alloc(32)
    sodium.crypto_scalarmult(out, secretKey, pk)
    if (out.every((x) => x === 0)) return null // low-order key: refuse
    return out
  } catch {
    return null
  }
}

function wipe (buf) {
  if (buf) sodium.sodium_memzero(buf)
}

// Traffic key = H(one-time exchange ‖ long-term key ‖ both one-time keys ‖ label)
function trafficKey (shared, longTermKey, firstPub, secondPub, label) {
  const key = hash(b4a.concat([shared, longTermKey, b4a.from(firstPub, 'hex'), b4a.from(secondPub, 'hex')]), b4a.from(label))
  wipe(shared)
  return key
}

const hexOf = (buf) => b4a.toString(buf, 'hex')

// ---------- one session over Nostr, shaped like a socket ----------

class NostrLink extends Emitter {
  constructor ({ pool, keys, sid, remotePublicKey }) {
    super()
    this.pool = pool
    this.keys = keys
    this.sid = sid
    this.remotePublicKey = remotePublicKey
    this.rawStream = null
    this.destroyed = false
    this.ready = false // true once the one-time keys have been exchanged
    this.sessionKey = null
    this._out = [] // lines waiting to be sent
    this._outBytes = 0
    this._seqOut = 0
    this._expected = 0
    this._early = new Map() // seq → lines, for events that arrive out of order
    this._gapTimer = null
    this._flushTimer = null
    this._needDrain = false
  }

  write (data) {
    if (this.destroyed) return false
    const text = typeof data === 'string' ? data : b4a.toString(data)
    for (const line of text.split('\n')) {
      if (!line) continue
      this._out.push(line)
      this._outBytes += line.length
    }
    this._schedule()
    const ok = this._outBytes < HIGH_WATER
    if (!ok) this._needDrain = true
    return ok
  }

  _setSessionKey (key) {
    this.sessionKey = key
    this.ready = true
    this._schedule()
  }

  _schedule () {
    // Nothing leaves before the session key exists: lines wait in the queue
    if (this.ready && !this._flushTimer && this._out.length) this._flushTimer = setTimeout(() => this._flush(), 30)
  }

  _flush () {
    this._flushTimer = null
    if (this.destroyed || !this._out.length) return
    const lines = []
    let size = 0
    while (this._out.length && (lines.length === 0 || size + this._out[0].length < MAX_EVENT_PLAINTEXT)) {
      const line = this._out.shift()
      size += line.length
      lines.push(line)
    }
    this._outBytes -= size
    this._publish({ sid: this.sid, seq: this._seqOut++, l: lines })
    if (this._needDrain && this._outBytes < HIGH_WATER / 2) {
      this._needDrain = false
      this.emit('drain')
    }
    if (this._out.length) this._flushTimer = setTimeout(() => this._flush(), SEND_INTERVAL_MS)
  }

  // Session traffic: always under the one-time session key
  _publish (payload) {
    if (!this.sessionKey) return
    const event = signEvent(this.keys.mySk, this.keys.myPub, seal(this.sessionKey, payload))
    if (!this.pool.publish(event)) this.destroy(new Error('Nessun relay Nostr raggiungibile'))
  }

  // Handshake only: under the long-term key (it carries nothing but one-time public keys)
  _publishHandshake (payload) {
    this.pool.publish(signEvent(this.keys.mySk, this.keys.myPub, seal(this.keys.encKey, payload)))
  }

  // Called by the peer with each decrypted event of this session, in any order
  _receive (payload) {
    if (this.destroyed) return
    if (payload.bye) return this.destroy()
    if (typeof payload.seq !== 'number' || payload.seq < this._expected || this._early.has(payload.seq)) return
    this._early.set(payload.seq, Array.isArray(payload.l) ? payload.l : [])
    this._drainEarly()
  }

  _drainEarly () {
    while (this._early.has(this._expected)) {
      const lines = this._early.get(this._expected)
      this._early.delete(this._expected++)
      for (const line of lines) if (!this.destroyed) this.emit('data', b4a.from(line + '\n'))
    }
    clearTimeout(this._gapTimer)
    this._gapTimer = null
    if (this._early.size && !this.destroyed) {
      // An event got lost: don't wait forever, skip to the next one we have
      this._gapTimer = setTimeout(() => {
        this._expected = Math.min(...this._early.keys())
        this._drainEarly()
      }, REORDER_WAIT_MS)
    }
  }

  destroy (err) {
    if (this.destroyed) return
    this.destroyed = true
    // Tell the other side (best effort, never re-entering destroy)
    if (this.sessionKey) {
      try { this.pool.publish(signEvent(this.keys.mySk, this.keys.myPub, seal(this.sessionKey, { sid: this.sid, bye: true }))) } catch {}
    }
    clearTimeout(this._flushTimer)
    clearTimeout(this._gapTimer)
    clearInterval(this._hsTimer)
    if (this._oneTime) wipe(this._oneTime.secretKey)
    wipe(this.sessionKey) // forward secrecy: the session key is gone with the session
    this.sessionKey = null
    if (err) this.emit('error', err)
    this.emit('close')
  }

  end () { this.destroy() }
}

// ---------- the Nostr channel between one Mac and one device ----------
// role 'mac': incoming sessions are announced with onSession(link)
// role 'device': connect() opens a new session
//
// Session start (both messages under the long-term key, so only the two devices
// can produce them):  device → { sid, hs: 1, e }   Mac → { sid, hs: 2, e }
// then everything travels under the session key derived from the two one-time keys.

class NostrPeer {
  constructor ({ pool, keyPair, remotePublicKey, role, onSession = null }) {
    this.pool = pool
    this.role = role
    this.remotePublicKey = remotePublicKey
    this.keys = deriveKeys({ keyPair, remotePublicKey, role })
    this.onSession = onSession
    this.link = null
    this._seenSids = new Set() // a replayed session start is ignored
    this._unsub = pool.subscribe(
      { kinds: [KIND], authors: [this.keys.theirPub], since: Math.floor(Date.now() / 1000) - 30 },
      (ev) => this._onEvent(ev)
    )
  }

  _onEvent (ev) {
    if (ev.pubkey !== this.keys.theirPub || ev.created_at < Date.now() / 1000 - MAX_AGE_S) return
    // 1. Traffic of the current session
    const link = this.link
    if (link && link.sessionKey) {
      const payload = open(link.sessionKey, ev.content)
      if (payload && payload.sid === link.sid) return link._receive(payload)
    }
    // 2. A session start
    const hs = open(this.keys.encKey, ev.content)
    if (!hs || typeof hs.sid !== 'string' || typeof hs.e !== 'string') return
    if (this.role === 'mac' && hs.hs === 1) return this._accept(hs)
    if (this.role === 'device' && hs.hs === 2 && link && link.sid === hs.sid && !link.ready && link._oneTime) {
      const shared = exchange(link._oneTime.secretKey, hs.e)
      if (!shared) return
      const key = trafficKey(shared, this.keys.encKey, hexOf(link._oneTime.publicKey), hs.e, 'qvac-board/nostr-session/v2')
      wipe(link._oneTime.secretKey)
      link._oneTime = null
      clearInterval(link._hsTimer)
      link._setSessionKey(key)
    }
  }

  _accept (hs) {
    // The device repeats its start until it hears back: answer again with the same key
    if (this.link && this.link.sid === hs.sid) {
      if (this.link._hsReply) this.link._publishHandshake(this.link._hsReply)
      return
    }
    if (this._seenSids.has(hs.sid)) return
    const oneTime = oneTimeKeyPair()
    const shared = exchange(oneTime.secretKey, hs.e)
    if (!shared) return wipe(oneTime.secretKey)
    this._seenSids.add(hs.sid)
    if (this._seenSids.size > 500) this._seenSids.delete(this._seenSids.values().next().value)
    if (this.link) this.link.destroy()
    const link = this._newLink(hs.sid)
    const key = trafficKey(shared, this.keys.encKey, hs.e, hexOf(oneTime.publicKey), 'qvac-board/nostr-session/v2')
    link._hsReply = { sid: hs.sid, hs: 2, e: hexOf(oneTime.publicKey) }
    wipe(oneTime.secretKey)
    link._setSessionKey(key)
    this.link = link
    link._publishHandshake(link._hsReply)
    if (this.onSession) this.onSession(link)
  }

  _newLink (sid) {
    const link = new NostrLink({ pool: this.pool, keys: this.keys, sid, remotePublicKey: this.remotePublicKey })
    link.on('close', () => { if (this.link === link) this.link = null })
    return link
  }

  connect () {
    if (this.link) this.link.destroy()
    const sid = hexOf(randomBytes(8))
    const link = this._newLink(sid)
    this.link = link
    link._oneTime = oneTimeKeyPair()
    const start = { sid, hs: 1, e: hexOf(link._oneTime.publicKey) }
    const send = () => { if (!link.ready && !link.destroyed) link._publishHandshake(start) }
    send()
    link._hsTimer = setInterval(send, 3000) // in case the first one got lost
    return link
  }

  close () {
    this._unsub()
    if (this.link) this.link.destroy()
  }
}

// ---------- first pairing over Nostr ----------
// Everything comes from the QR code's one-time secret (shown only on the Mac's
// screen, valid 5 minutes): whoever has not seen the QR cannot even find the
// channel. Then, like a session, one-time keys are exchanged first, so the details
// that follow (names, keys, addresses) stay secret even if the QR leaks later.
// The device also signs, with its own key, the secret and both one-time keys.
//
//   device → { type: 'pair-hello', e }                Mac → { type: 'pair-hello', re: e, e: e2 }
//   device → { type: 'pair', e, box: seal(k, request) }  Mac → { type: 'pair-reply', re: e, box: seal(k, reply) }

// ---------- invite code (pairing by typing, instead of scanning the QR) ----------
// 12 characters of Crockford base32 (≈60 bits), shown as XXXX-XXXX-XXXX, valid 5 minutes
// and once. Both sides derive from it the same Holepunch pairing key and the same
// one-time secret used by the other paths: the code IS the invite.
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function newInviteCode () {
  const bytes = randomBytes(12)
  let out = ''
  for (const b of bytes) out += INVITE_ALPHABET[b & 31]
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`
}

// What you typed → the canonical code, or null. Tolerant: spaces, dashes, lower case, O/0, I/L/1
function normalizeInvite (text) {
  const plain = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, '')
  if (plain.length !== 12 || [...plain].some((c) => !INVITE_ALPHABET.includes(c))) return null
  return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`
}

function inviteSecrets (code) {
  const canonical = normalizeInvite(code)
  if (!canonical) throw new Error('Codice non valido')
  const seed = hash(b4a.from(`qvac-invite:${canonical}`), b4a.from('qvac-board/invite/v1'))
  const token = b4a.toString(hash(b4a.from('token'), seed), 'hex').slice(0, 32)
  return { seed, token, code: canonical }
}

// ---------- mesh network (a permanent code shared by your devices) ----------
// 16 characters (≈80 bits), XXXX-XXXX-XXXX-XXXX. Everyone with the code meets on the same
// Hyperswarm topic; on every connection each side proves it knows the code, bound to
// that connection's own encryption (so a captured proof is useless anywhere else).

function newNetworkCode () {
  const bytes = randomBytes(16)
  let out = ''
  for (const b of bytes) out += INVITE_ALPHABET[b & 31]
  return out.match(/.{4}/g).join('-')
}

function normalizeNetworkCode (text) {
  const plain = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, '')
  if (plain.length !== 16 || [...plain].some((c) => !INVITE_ALPHABET.includes(c))) return null
  return plain.match(/.{4}/g).join('-')
}

function meshSecrets (code) {
  const canonical = normalizeNetworkCode(code)
  if (!canonical) throw new Error('Codice di rete non valido (16 caratteri, es. ABCD-EFGH-JKMN-PQRS)')
  const root = hash(b4a.from(`qvac-mesh:${canonical}`), b4a.from('qvac-board/mesh/v1'))
  return {
    code: canonical,
    topic: hash(b4a.from('topic'), root), // the Hyperswarm topic (what DHT nodes see: just a hash)
    authKey: hash(b4a.from('auth'), root), // proves knowledge of the code
    token: b4a.toString(hash(b4a.from('nostr'), root), 'hex').slice(0, 32), // Nostr fallback channel
    id: b4a.toString(hash(b4a.from('id'), root), 'hex').slice(0, 12) // short name for this network
  }
}

// Proof for one connection: MAC(authKey, handshake hash ‖ my public key)
function meshProof (authKey, handshakeHash, publicKey) {
  return b4a.toString(hash(b4a.concat([handshakeHash, publicKey]), authKey), 'hex')
}

function verifyMeshProof (authKey, handshakeHash, publicKey, proofHex) {
  const expected = b4a.from(meshProof(authKey, handshakeHash, publicKey), 'hex')
  const got = b4a.from(String(proofHex || ''), 'hex')
  return got.length === expected.length && sodium.sodium_memcmp(got, expected)
}

function pairingKeys (tokenHex) {
  const root = hash(b4a.from(tokenHex, 'hex'), b4a.from('qvac-board/nostr-pair/v1'))
  const macSk = nostrSecret(hash(b4a.from('mac'), root))
  const devSk = nostrSecret(hash(b4a.from('device'), root))
  const hex = (sk) => b4a.toString(b4a.from(schnorr.getPublicKey(sk)), 'hex')
  return { encKey: hash(b4a.from('enc'), root), macSk, macPub: hex(macSk), devSk, devPub: hex(devSk) }
}

function proofMessage (tokenHex, deviceOneTime, macOneTime) {
  return b4a.from(`qvac-pair:${tokenHex}:${deviceOneTime}:${macOneTime}`)
}

function pairingProof (keyPair, tokenHex, deviceOneTime, macOneTime) {
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, proofMessage(tokenHex, deviceOneTime, macOneTime), keyPair.secretKey)
  return b4a.toString(sig, 'hex')
}

function verifyPairingProof (publicKeyHex, tokenHex, sigHex, deviceOneTime, macOneTime) {
  try {
    const pk = b4a.from(String(publicKeyHex), 'hex')
    const sig = b4a.from(String(sigHex), 'hex')
    if (pk.length !== 32 || sig.length !== sodium.crypto_sign_BYTES) return false
    return sodium.crypto_sign_verify_detached(sig, proofMessage(tokenHex, deviceOneTime, macOneTime), pk)
  } catch {
    return false
  }
}

function pairingTrafficKey (shared, keys, deviceOneTime, macOneTime) {
  return trafficKey(shared, keys.encKey, deviceOneTime, macOneTime, 'qvac-board/nostr-pair/v2')
}

// One encrypted message, and a listener for the other side's messages
function sendSealed (pool, sk, pub, encKey, payload) {
  return pool.publish(signEvent(sk, pub, seal(encKey, payload)))
}

function listenSealed (pool, authorPub, encKey, onPayload) {
  return pool.subscribe(
    { kinds: [KIND], authors: [authorPub], since: Math.floor(Date.now() / 1000) - 30 },
    (ev) => {
      if (ev.pubkey !== authorPub || ev.created_at < Date.now() / 1000 - MAX_AGE_S) return
      const payload = open(encKey, ev.content)
      if (payload) onPayload(payload)
    }
  )
}

function randomBytes (n) {
  const buf = b4a.alloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

module.exports = {
  RelayPool, NostrPeer, NostrLink, deriveKeys, seal, open, signEvent, normalizeRelays,
  pairingKeys, pairingProof, verifyPairingProof, pairingTrafficKey, sendSealed, listenSealed,
  newInviteCode, normalizeInvite, inviteSecrets,
  newNetworkCode, normalizeNetworkCode, meshSecrets, meshProof, verifyMeshProof,
  oneTimeKeyPair, exchange, wipe,
  KIND, DEFAULT_RELAYS, MAX_RELAYS
}
