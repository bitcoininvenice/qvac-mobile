'use strict'
// Messages between QVAC-BOARD devices: text, emoji, photos and files, phone ↔ desktop and
// phone ↔ phone (also between different people), also when the desktop is off.
//
// The same file is used by both projects — keep these two copies identical:
//   qvac-mobile/p2p-worker/msg-core.js   (iPhone, Bare)  ← edit this one
//   qvac-web-server/p2p/msg-core.cjs     (desktop, Node)
//
// Security
//  - Identity = the device's ed25519 key (the same one Holepunch uses).
//  - A conversation starts with a handshake of one-time X25519 keys on both sides, signed
//    by both identities (hs1 / hs2); then the Double Ratchet (Signal's algorithm): every
//    message has its own key, deleted once used. Forward secrecy and break-in recovery on
//    every path. XChaCha20-Poly1305, BLAKE2b, X25519 (libsodium).
//  - Whoever carries a message (a desktop "postman", a Nostr relay) sees only an envelope:
//    from, to and ciphertext. Plaintext is padded to 256-byte blocks (length hidden).
//  - Files: each one has a random key that travels inside a ratchet message; the file
//    itself travels as an encrypted blob (secretstream, tamper and truncation proof).
//  - Anything not signed / not decryptable by a known contact is refused.
//
// Paths (best available, chosen automatically)
//  1. live link to the recipient: desktop session (🏠 🔵 ⚡ 📡) or a direct Hyperswarm link
//     between two phones (topic only the two contacts can compute)
//  2. a desktop as postman: keeps the encrypted envelopes for its devices and delivers them
//     when they reconnect
//  3. Nostr mailbox: the envelope, encrypted once more, stored on public relays (kind 1059,
//     7-day expiration), under a tag that only the two contacts can compute and that
//     changes every week. Text only (files wait for a fast path).
const sodium = require('sodium-universal')
const b4a = require('b4a')
const { schnorr, secp256k1 } = require('@noble/curves/secp256k1')
const { sha256 } = require('@noble/hashes/sha256')

const VERSION = 1
const MAX_TEXT = 8000
const MAX_FILE_BYTES = 25 * 1024 * 1024
const BLOB_PIECE = 24 * 1024 // base64 → ~32 KB per line
const SS_CHUNK = 64 * 1024 // secretstream plaintext chunk
const MAX_SKIP = 1000
const MAX_SKIPPED_TOTAL = 2000
const MAILBOX_KIND = 1059
const MAILBOX_TTL_S = 7 * 86400
const MAILBOX_EPOCH_S = 7 * 86400
const MAILBOX_EPOCHS = 5 // current + 4 previous weeks
const MAILBOX_DELAY_MS = 8000 // give live delivery a chance before using Nostr
const MAILBOX_REPUBLISH_MS = 3 * 86400 * 1000
const INVITE_MS = 10 * 60 * 1000
const RELAY_MAX_PER_PEER = 1000
const RELAY_MAX_AGE_MS = 30 * 86400 * 1000
const RELAY_MAX_BLOB_BYTES = 500 * 1024 * 1024
const SEEN_MAX = 5000
const HISTORY_MAX = 3000
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// ---------- primitives ----------

const hex = (b) => b4a.toString(b, 'hex')
const unhex = (s) => b4a.from(String(s || ''), 'hex')
const b64 = (b) => b4a.toString(b, 'base64')
const unb64 = (s) => b4a.from(String(s || ''), 'base64')
const isKey = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
const isId = (s) => typeof s === 'string' && /^[0-9a-f]{16,48}$/.test(s)
const now = () => Date.now()

function rand (n) {
  const b = b4a.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

function H (data, key, len = 32) {
  const out = b4a.alloc(len)
  if (key) sodium.crypto_generichash(out, data, key)
  else sodium.crypto_generichash(out, data)
  return out
}
const LABEL = (s) => H(b4a.from(s))

function wipe (b) { if (b && b.length) sodium.sodium_memzero(b) }

function x25519 () {
  const sk = rand(32)
  const pk = b4a.alloc(32)
  sodium.crypto_scalarmult_base(pk, sk)
  return { pk, sk }
}

function dh (sk, pk) {
  if (!pk || pk.length !== 32) throw new Error('bad key')
  const out = b4a.alloc(32)
  sodium.crypto_scalarmult(out, sk, pk)
  if (out.every((x) => x === 0)) throw new Error('low-order key')
  return out
}

function edPkToX (pk) {
  const out = b4a.alloc(32)
  sodium.crypto_sign_ed25519_pk_to_curve25519(out, pk)
  return out
}

function edSkToX (sk) {
  const out = b4a.alloc(32)
  sodium.crypto_sign_ed25519_sk_to_curve25519(out, sk)
  return out
}

function sign (sk, msg) {
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, msg, sk)
  return hex(sig)
}

function verify (pkHex, msg, sigHex) {
  try {
    const pk = unhex(pkHex)
    const sig = unhex(sigHex)
    if (pk.length !== 32 || sig.length !== 64) return false
    return sodium.crypto_sign_verify_detached(sig, msg, pk)
  } catch {
    return false
  }
}

function aeadEncrypt (key, plain, ad) {
  const nonce = rand(24)
  const c = b4a.alloc(plain.length + 16)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(c, plain, ad, null, nonce, key)
  return { n: b64(nonce), c: b64(c) }
}

function aeadDecrypt (key, nB64, cB64, ad) {
  try {
    const nonce = unb64(nB64)
    const c = unb64(cB64)
    if (nonce.length !== 24 || c.length < 16) return null
    const m = b4a.alloc(c.length - 16)
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, c, ad, nonce, key)
    return m
  } catch {
    return null
  }
}

// secretbox for the outer Nostr layer and the local store
function seal (key, obj) {
  const msg = b4a.from(JSON.stringify(obj))
  const nonce = rand(sodium.crypto_secretbox_NONCEBYTES)
  const box = b4a.alloc(msg.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(box, msg, nonce, key)
  return b64(b4a.concat([nonce, box]))
}

function open (key, text) {
  try {
    const raw = unb64(text)
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

// Plaintext padded to 256-byte blocks: the length of a message does not show
function pad (obj) {
  const text = JSON.stringify(obj)
  const len = b4a.byteLength(text) + 1
  const total = Math.ceil(len / 256) * 256
  return b4a.from(text + '\n' + ' '.repeat(total - len))
}

function unpad (buf) {
  try { return JSON.parse(b4a.toString(buf)) } catch { return null }
}

// ---------- Double Ratchet (Signal spec, with X25519 / BLAKE2b / XChaCha20-Poly1305) ----------
// State is kept as hex strings (stored in the sealed state file); every operation works on
// a fresh copy, committed only when it succeeds (a forged message never touches the state).

const RK_KEY = LABEL('qvac-msg/rk/v1')

function kdfRK (rk, dhOut) {
  const out = H(b4a.concat([rk, dhOut]), RK_KEY, 64)
  wipe(dhOut)
  return [b4a.from(out.subarray(0, 32)), b4a.from(out.subarray(32))]
}

function kdfCK (ck) {
  return [H(b4a.from([2]), ck), H(b4a.from([1]), ck)] // [next chain key, message key]
}

function drLoad (s) {
  return {
    DHs: { pk: unhex(s.DHs.pk), sk: unhex(s.DHs.sk) },
    DHr: s.DHr ? unhex(s.DHr) : null,
    RK: unhex(s.RK),
    CKs: s.CKs ? unhex(s.CKs) : null,
    CKr: s.CKr ? unhex(s.CKr) : null,
    Ns: s.Ns, Nr: s.Nr, PN: s.PN,
    skipped: { ...(s.skipped || {}) }
  }
}

function drSave (st) {
  return {
    DHs: { pk: hex(st.DHs.pk), sk: hex(st.DHs.sk) },
    DHr: st.DHr ? hex(st.DHr) : null,
    RK: hex(st.RK),
    CKs: st.CKs ? hex(st.CKs) : null,
    CKr: st.CKr ? hex(st.CKr) : null,
    Ns: st.Ns, Nr: st.Nr, PN: st.PN,
    skipped: st.skipped
  }
}

// The side that answers the handshake ("Alice" in the spec): can send at once
function drInitSender (root, remoteDh) {
  const DHs = x25519()
  const [RK, CKs] = kdfRK(root, dh(DHs.sk, remoteDh))
  wipe(root)
  return drSave({ DHs, DHr: remoteDh, RK, CKs, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {} })
}

// The side that started it ("Bob"): sends after the first message of the other side
function drInitReceiver (root, myDh) {
  return drSave({ DHs: myDh, DHr: null, RK: root, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {} })
}

const headerBytes = (h) => b4a.from(`${h.dh}|${h.pn}|${h.n}`)

function drCanSend (s) { return Boolean(s && s.CKs) }

function drEncrypt (s, plain, ad) {
  const st = drLoad(s)
  if (!st.CKs) throw new Error('no sending chain yet')
  const [ck, mk] = kdfCK(st.CKs)
  st.CKs = ck
  const header = { dh: hex(st.DHs.pk), pn: st.PN, n: st.Ns }
  st.Ns++
  const out = aeadEncrypt(mk, plain, b4a.concat([ad, headerBytes(header)]))
  wipe(mk)
  return { state: drSave(st), header, n: out.n, c: out.c }
}

function skipKeys (st, until) {
  if (!st.CKr) return
  if (until - st.Nr > MAX_SKIP) throw new Error('too many skipped messages')
  while (st.Nr < until) {
    const [ck, mk] = kdfCK(st.CKr)
    st.CKr = ck
    st.skipped[hex(st.DHr) + ':' + st.Nr] = { mk: hex(mk), ts: now() }
    st.Nr++
  }
  const keys = Object.keys(st.skipped)
  if (keys.length > MAX_SKIPPED_TOTAL) {
    keys.sort((a, b) => st.skipped[a].ts - st.skipped[b].ts)
    for (const k of keys.slice(0, keys.length - MAX_SKIPPED_TOTAL)) delete st.skipped[k]
  }
}

function validHeader (h) {
  return h && isKey(h.dh) && Number.isInteger(h.pn) && Number.isInteger(h.n) && h.pn >= 0 && h.n >= 0 && h.pn < 1e7 && h.n < 1e7
}

// → { state, plain } or null (never changes `s`)
function drDecrypt (s, header, n, c, ad) {
  if (!validHeader(header)) return null
  try {
    const st = drLoad(s)
    const fullAd = b4a.concat([ad, headerBytes(header)])
    const skKey = header.dh + ':' + header.n
    if (st.skipped[skKey]) {
      const mk = unhex(st.skipped[skKey].mk)
      const plain = aeadDecrypt(mk, n, c, fullAd)
      if (!plain) return null
      delete st.skipped[skKey]
      return { state: drSave(st), plain }
    }
    if (!st.DHr || header.dh !== hex(st.DHr)) {
      skipKeys(st, header.pn)
      st.PN = st.Ns
      st.Ns = 0
      st.Nr = 0
      st.DHr = unhex(header.dh)
      ;[st.RK, st.CKr] = kdfRK(st.RK, dh(st.DHs.sk, st.DHr))
      wipe(st.DHs.sk)
      st.DHs = x25519()
      ;[st.RK, st.CKs] = kdfRK(st.RK, dh(st.DHs.sk, st.DHr))
    }
    skipKeys(st, header.n)
    const [ck, mk] = kdfCK(st.CKr)
    st.CKr = ck
    st.Nr++
    const plain = aeadDecrypt(mk, n, c, fullAd)
    wipe(mk)
    if (!plain) return null
    // Skipped keys older than 30 days are dropped (a message that late will not come)
    for (const [k, v] of Object.entries(st.skipped)) if (now() - v.ts > RELAY_MAX_AGE_MS) delete st.skipped[k]
    return { state: drSave(st), plain }
  } catch {
    return null
  }
}

// ---------- handshake ----------
//   hs1 (initiator A → B): { e: A's one-time key, ts, sig_A }
//   hs2 (B → A):           { e: B's one-time key, re: A's key, sig_B }
// root = BLAKE2b(DH(eA,eB) ‖ DH(IK_A,eB) ‖ DH(eA,IK_B) ‖ identities ‖ one-time keys).
// B becomes the sending side at once (with eA as A's first ratchet key); A uses eA as its
// ratchet key until B's first message. One-time secrets are wiped right after use.

const hsText = (kind, from, to, e, extra) => b4a.from(`qvac-msg/${kind}/v1|${from}|${to}|${e}|${extra}`)

function rootKey (initiator, responder, ea, eb, d1, d2, d3) {
  const root = H(b4a.concat([d1, d2, d3, unhex(initiator), unhex(responder), unhex(ea), unhex(eb)]), LABEL('qvac-msg/root/v1'))
  wipe(d1); wipe(d2); wipe(d3)
  return root
}

// ---------- files: encrypted blob ----------

function encryptBlob (plain) {
  const key = rand(32)
  const state = b4a.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES)
  const header = b4a.alloc(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES)
  sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, key)
  const parts = [header]
  const A = sodium.crypto_secretstream_xchacha20poly1305_ABYTES
  let off = 0
  do {
    const chunk = plain.subarray(off, off + SS_CHUNK)
    off += chunk.length
    const last = off >= plain.length
    const c = b4a.alloc(chunk.length + A)
    sodium.crypto_secretstream_xchacha20poly1305_push(state, c, chunk, null, last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
    parts.push(c)
  } while (off < plain.length)
  const blob = b4a.concat(parts)
  return { key, blob, bh: hex(H(blob)) }
}

function decryptBlob (key, blob) {
  try {
    const HB = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES
    const A = sodium.crypto_secretstream_xchacha20poly1305_ABYTES
    const state = b4a.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES)
    sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, blob.subarray(0, HB), key)
    const parts = []
    let off = HB
    const tag = b4a.alloc(1)
    let final = false
    while (off < blob.length) {
      const c = blob.subarray(off, off + SS_CHUNK + A)
      off += c.length
      const m = b4a.alloc(c.length - A)
      sodium.crypto_secretstream_xchacha20poly1305_pull(state, m, tag, c, null)
      parts.push(m)
      if (tag[0] === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) { final = true; break }
    }
    if (!final || off !== blob.length) return null // truncated or extended
    return b4a.concat(parts)
  } catch {
    return null
  }
}

// ---------- secrets shared by two contacts ----------

function pairSecret (identity, peerHex) {
  const shared = dh(edSkToX(identity.secretKey), edPkToX(unhex(peerHex)))
  const me = hex(identity.publicKey)
  const [a, b] = [me, peerHex].sort()
  const root = H(b4a.concat([shared, unhex(a), unhex(b)]), LABEL('qvac-msg/pair/v1'))
  wipe(shared)
  return {
    topic: H(b4a.from('topic'), root), // Hyperswarm topic for direct links
    mailbox: H(b4a.from('mailbox'), root) // Nostr mailbox
  }
}

// Safety number: the same 30 digits on both devices if nobody is in the middle (compare them
// in person or on a call). Changes only if one of the two identities changes.
function safetyNumber (a, b) {
  const [x, y] = [a, b].sort()
  const h = H(b4a.concat([unhex(x), unhex(y)]), LABEL('qvac-msg/safety/v1'))
  const groups = []
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 5] * 2 ** 32) + (h[i * 5 + 1] << 24 >>> 0) + (h[i * 5 + 2] << 16) + (h[i * 5 + 3] << 8) + h[i * 5 + 4]) % 100000
    groups.push(String(n).padStart(5, '0'))
  }
  return groups.join(' ')
}

// ---------- contact invites (people) ----------
// 12 characters (≈60 bits), XXXX-XXXX-XXXX, valid 10 minutes and once.

function newContactCode () {
  let out = ''
  for (const b of rand(12)) out += INVITE_ALPHABET[b & 31]
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`
}

function normalizeContactCode (text) {
  const plain = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, '')
  if (plain.length !== 12 || [...plain].some((c) => !INVITE_ALPHABET.includes(c))) return null
  return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`
}

function contactSecrets (code) {
  const canonical = normalizeContactCode(code)
  if (!canonical) throw new Error('Codice contatto non valido (12 caratteri, es. ABCD-EFGH-JKMN)')
  const root = H(b4a.from(`qvac-contact:${canonical}`), LABEL('qvac-board/contact/v1'))
  return {
    code: canonical,
    topic: H(b4a.from('topic'), root),
    authKey: H(b4a.from('auth'), root),
    token: hex(H(b4a.from('nostr'), root)).slice(0, 32)
  }
}

const inviteProof = (authKey, handshakeHash, idHex) => hex(H(b4a.concat([handshakeHash, unhex(idHex)]), authKey))
function checkInviteProof (authKey, handshakeHash, idHex, proof) {
  const want = unhex(inviteProof(authKey, handshakeHash, idHex))
  const got = unhex(proof)
  return got.length === want.length && sodium.sodium_memcmp(got, want)
}

// ---------- Nostr events with tags ----------

function nostrSecret (seed) {
  let sk = seed
  while (!secp256k1.utils.isValidPrivateKey(sk)) sk = H(sk)
  return sk
}

function signNostr (sk, kind, tags, content) {
  const pubkey = hex(b4a.from(schnorr.getPublicKey(sk)))
  const created_at = Math.floor(now() / 1000) // eslint-disable-line camelcase
  const id = hex(b4a.from(sha256(b4a.from(JSON.stringify([0, pubkey, created_at, kind, tags, content])))))
  const sig = hex(b4a.from(schnorr.sign(id, sk, rand(32))))
  return { id, pubkey, created_at, kind, tags, content, sig } // eslint-disable-line camelcase
}

// ---------- sealed local store ----------
// fs: sync subset of node:fs / bare-fs. Every file is sealed with `key` (iPhone: from the
// Keychain; desktop: derived from its secret key). Writes go through a temporary file.

function createStore ({ fs, dir, key }) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const file = (name) => dir + '/' + name
  return {
    dir,
    load (name) {
      try {
        if (!fs.existsSync(file(name))) return null
        return open(key, b4a.toString(fs.readFileSync(file(name))))
      } catch { return null }
    },
    save (name, obj) {
      const tmp = file(name) + '.tmp'
      fs.writeFileSync(tmp, seal(key, obj))
      fs.renameSync(tmp, file(name))
    },
    remove (name) { try { fs.rmSync(file(name), { force: true }) } catch {} }
  }
}

// ---------- lines over a stream ----------

function writeLine (stream, msg) {
  if (!stream || stream.destroyed) return false
  return stream.write(b4a.from(JSON.stringify(msg) + '\n'))
}

function writeLineAsync (stream, msg) {
  if (!stream || stream.destroyed) return Promise.reject(new Error('Collegamento chiuso'))
  if (writeLine(stream, msg)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { stream.off('drain', done); stream.off('close', gone); resolve() }
    const gone = () => { stream.off('drain', done); reject(new Error('Collegamento interrotto')) }
    stream.once('drain', done)
    stream.once('close', gone)
  })
}

function onLines (stream, fn) {
  let buf = ''
  stream.on('data', (data) => {
    buf += b4a.toString(data)
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      try { fn(msg) } catch {}
    }
    if (buf.length > 64 * 1024) stream.destroy()
  })
}

// A link to another device, over any stream that carries JSON lines
function streamLink (stream, { fast = true, kind = 'direct' } = {}) {
  return {
    kind,
    fast,
    get open () { return !stream.destroyed },
    send: (msg) => writeLine(stream, msg),
    sendAsync: (msg) => writeLineAsync(stream, msg),
    close: () => stream.destroy()
  }
}

const safeFileName = (name) => {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[:\x00-\x1f]/g, '_').replace(/^\.+/, '').trim()
  return base.slice(0, 150) || 'file'
}
const cleanName = (s) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)

// ---------- the messenger ----------
// Host provides:
//   identity     { publicKey, secretKey } (ed25519)
//   fs, dataDir, filesDir, storeKey      where state and received files go
//   name, platform, kind ('phone'|'desktop')
//   onEvent(ev)  { type: 'changed', peer? } · { type: 'contacts' } · { type: 'invite', ... } · { type: 'log', text }
//   postmanFor(key) → true if this device keeps envelopes for `key` (desktop: its devices)
//   Hyperswarm, swarmKeyPair             for direct links (optional)
//   nostr        { ensurePool(), link } — nostr-link module (sendSealed, pairingKeys…)
//   allowDirect() / allowNostr()         Impostazioni → Metodi di connessione

class Messenger {
  constructor (opts) {
    this.o = opts
    this.identity = opts.identity
    this.me = hex(opts.identity.publicKey)
    this.fs = opts.fs
    this.store = createStore({ fs: opts.fs, dir: opts.dataDir, key: opts.storeKey })
    this.filesDir = opts.filesDir
    this.blobDir = opts.dataDir + '/blobs'
    try { this.fs.mkdirSync(this.blobDir, { recursive: true }) } catch {}
    this.db = this._loadDb()
    this.links = new Map() // peer key → Set(link)
    this.histories = new Map() // peer → array (cache)
    this.pairs = new Map() // peer → pairSecret (cache)
    this.swarm = null
    this.topics = new Map() // topic hex → peer
    this.mailboxUnsub = null
    this.mailboxTags = new Map() // tag → { peer, epoch }
    this.invite = null // { code, secrets, role, expiresAt, ... }
    this.blobSending = new WeakMap() // link → busy
    this.incomingBlobs = new Map() // bid → { tmp, size, bh, got, to, from, link }
    this.timer = null
    this.closed = false
  }

  log (text) { this.o.onEvent && this.o.onEvent({ type: 'log', text }) }
  emit (ev) { try { this.o.onEvent && this.o.onEvent(ev) } catch {} }

  _loadDb () {
    const db = this.store.load('state') || {}
    return {
      v: VERSION,
      contacts: db.contacts || {},
      sessions: db.sessions || {},
      pending: db.pending || {},
      queue: db.queue || {},
      outbox: db.outbox || [],
      blobsOut: db.blobsOut || {},
      early: db.early || {},
      seen: db.seen || {},
      hsSeen: db.hsSeen || {}, // one-time keys of handshakes already answered (replays)
      convs: db.convs || {},
      files: db.files || {}, // bid → { peer, mid, key, name, mime, size } (file messages received)
      relay: db.relay || {}, // postman: recipient → [env]
      relayBlobs: db.relayBlobs || {}, // postman: bid → { to, from, size, bh, at }
      mailboxSince: db.mailboxSince || 0,
      options: { nostrMailbox: true, ...(db.options || {}) }
    }
  }

  _save () { this.store.save('state', this.db) }

  start () {
    this.timer = setInterval(() => { try { this._tick() } catch (err) { this.log('messaggi: ' + err.message) } }, 5000)
    this._syncDirect()
    this._syncMailbox()
    this._proactiveHandshakes()
  }

  async close () {
    this.closed = true
    clearInterval(this.timer)
    if (this.mailboxUnsub) this.mailboxUnsub()
    this.cancelInvite()
    if (this.swarm) await this.swarm.destroy().catch(() => {})
  }

  setOptions (opts) {
    if (typeof opts.nostrMailbox === 'boolean') this.db.options.nostrMailbox = opts.nostrMailbox
    if (opts.name) this.o.name = cleanName(opts.name)
    this._save()
    this._syncMailbox()
    return this.db.options
  }

  // ---------- contacts ----------

  // source: 'invite' (a person), or the key of the desktop that introduced it ('mine')
  upsertContact ({ key, name, kind, group, source }) {
    if (!isKey(key) || key === this.me) return false
    const old = this.db.contacts[key]
    const sources = new Set(old ? old.sources : [])
    if (source) sources.add(source)
    const next = {
      key,
      name: cleanName(name) || (old && old.name) || 'Dispositivo',
      customName: old ? old.customName || null : null,
      kind: kind || (old && old.kind) || 'phone',
      group: old && old.group === 'mine' ? 'mine' : group || 'person',
      sources: [...sources],
      addedAt: old ? old.addedAt : now()
    }
    if (old && JSON.stringify(old) === JSON.stringify(next)) return false
    this.db.contacts[key] = next
    this._save()
    if (!old) {
      this._syncDirect()
      this._syncMailbox()
      this._proactiveHandshakes()
    }
    this.emit({ type: 'contacts' })
    return true
  }

  // Desktop side: its paired devices are "mine"; phone side: the devices a desktop lists
  syncSource (source, list, { group = 'mine' } = {}) {
    const keys = new Set()
    for (const d of list) {
      if (!isKey(d.key) || d.key === this.me) continue
      keys.add(d.key)
      this.upsertContact({ key: d.key, name: d.name, kind: d.kind, group, source })
    }
    for (const c of Object.values(this.db.contacts)) {
      if (!c.sources.includes(source) || keys.has(c.key)) continue
      c.sources = c.sources.filter((s) => s !== source)
      if (!c.sources.length) this.removeContact(c.key, { keepHistory: true })
      else this._save()
    }
  }

  renameContact (key, name) {
    const c = this.db.contacts[key]
    if (!c) return false
    c.customName = cleanName(name) || null
    this._save()
    this.emit({ type: 'contacts' })
    return true
  }

  removeContact (key, { keepHistory = false } = {}) {
    if (!this.db.contacts[key]) return false
    delete this.db.contacts[key]
    delete this.db.sessions[key] // the ratchet keys go with it
    delete this.db.pending[key]
    delete this.db.queue[key]
    delete this.db.early[key]
    this.db.outbox = this.db.outbox.filter((i) => i.to !== key)
    for (const [bid, b] of Object.entries(this.db.blobsOut)) if (b.to === key) this._dropBlobOut(bid)
    if (!keepHistory) {
      delete this.db.convs[key]
      this.histories.delete(key)
      this.store.remove('conv-' + key.slice(0, 32))
    }
    this._save()
    for (const link of this.links.get(key) || []) if (link.kind === 'direct') link.close()
    this._syncDirect()
    this._syncMailbox()
    this.emit({ type: 'contacts' })
    return true
  }

  contactList () {
    return Object.values(this.db.contacts).map((c) => {
      const conv = this.db.convs[c.key] || {}
      const links = [...(this.links.get(c.key) || [])].filter((l) => l.open)
      return {
        key: c.key,
        name: c.customName || c.name,
        ownName: c.name,
        customName: c.customName,
        kind: c.kind,
        group: c.group,
        online: links.length > 0,
        via: links.length ? links[0].via || links[0].kind : null,
        secure: Boolean(this.db.sessions[c.key]),
        safety: safetyNumber(this.me, c.key),
        unread: conv.unread || 0,
        last: conv.last || null,
        updatedAt: conv.updatedAt || c.addedAt
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // ---------- history ----------

  history (peer) {
    if (this.histories.has(peer)) return this.histories.get(peer)
    const list = this.store.load('conv-' + peer.slice(0, 32)) || []
    this.histories.set(peer, list)
    return list
  }

  _saveHistory (peer) {
    const list = this.history(peer)
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
    this.store.save('conv-' + peer.slice(0, 32), list)
  }

  _addToHistory (peer, m, { unread = false } = {}) {
    const list = this.history(peer)
    if (list.some((x) => x.id === m.id)) return
    list.push(m)
    list.sort((a, b) => a.ts - b.ts)
    this._saveHistory(peer)
    const conv = this.db.convs[peer] || { unread: 0 }
    conv.last = { dir: m.dir, text: m.t === 'file' ? `${(m.file.mime || '').startsWith('image/') ? '📷' : '📎'} ${m.file.name}` : m.text.slice(0, 120), ts: m.ts }
    conv.updatedAt = m.ts
    if (unread) conv.unread = (conv.unread || 0) + 1
    this.db.convs[peer] = conv
    this._save()
    this.emit({ type: 'changed', peer })
  }

  _updateMessage (peer, id, patch) {
    const list = this.history(peer)
    const m = list.find((x) => x.id === id)
    if (!m) return
    const order = { failed: -1, queued: 0, sent: 1, delivered: 2 }
    if (patch.status && m.dir === 'out' && order[patch.status] < order[m.status] && patch.status !== 'failed') delete patch.status
    if (patch.file) patch.file = { ...m.file, ...patch.file }
    Object.assign(m, patch)
    this._saveHistory(peer)
    this.emit({ type: 'changed', peer })
  }

  markRead (peer) {
    const conv = this.db.convs[peer]
    if (conv && conv.unread) { conv.unread = 0; this._save(); this.emit({ type: 'changed', peer }) }
  }

  deleteMessage (peer, id) {
    const list = this.history(peer)
    const i = list.findIndex((x) => x.id === id)
    if (i < 0) return false
    list.splice(i, 1)
    this._saveHistory(peer)
    this.emit({ type: 'changed', peer })
    return true
  }

  // ---------- sending ----------

  sendText (peer, text) {
    const t = String(text || '').trim()
    if (!t) throw new Error('Messaggio vuoto')
    if (t.length > MAX_TEXT) throw new Error(`Messaggio troppo lungo (massimo ${MAX_TEXT} caratteri)`)
    if (!this.db.contacts[peer]) throw new Error('Contatto sconosciuto')
    const id = hex(rand(12))
    const ts = now()
    this._addToHistory(peer, { id, dir: 'out', t: 'text', text: t, ts, status: 'queued' })
    this._queue(peer, { t: 'text', text: t, ts }, id)
    return { id }
  }

  // path: a file on this device. A copy stays in filesDir/Messaggi (to show it in the chat)
  sendFile (peer, { path, name, mime }) {
    if (!this.db.contacts[peer]) throw new Error('Contatto sconosciuto')
    const data = this.fs.readFileSync(path)
    if (data.length > MAX_FILE_BYTES) throw new Error(`File troppo grande: il massimo è ${MAX_FILE_BYTES / 1024 / 1024} MB`)
    const fileName = safeFileName(name)
    const { key, blob, bh } = encryptBlob(data)
    const bid = hex(rand(12))
    const blobPath = this.blobDir + '/out-' + bid
    this.fs.writeFileSync(blobPath, blob)
    const local = this._saveLocalCopy(fileName, data, 'Inviati')
    const id = hex(rand(12))
    const ts = now()
    const file = { name: fileName, size: data.length, mime: String(mime || ''), path: local }
    this.db.blobsOut[bid] = { to: peer, path: blobPath, size: blob.length, bh, mid: id, hops: {}, createdAt: ts }
    this._save()
    this._addToHistory(peer, { id, dir: 'out', t: 'file', file, ts, status: 'queued' })
    this._queue(peer, { t: 'file', name: fileName, size: data.length, mime: file.mime, bid, bsize: blob.length, bh, key: b64(key), ts }, id)
    wipe(key)
    return { id }
  }

  _saveLocalCopy (name, data, sub) {
    const dir = this.filesDir + '/' + sub
    try { this.fs.mkdirSync(dir, { recursive: true }) } catch {}
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = dir + '/' + name
    for (let i = 2; this.fs.existsSync(candidate); i++) candidate = dir + '/' + stem + ' (' + i + ')' + ext
    this.fs.writeFileSync(candidate, data)
    return candidate
  }

  // A payload for `peer`: encrypted now if the conversation is ready, else queued in clear
  // (in the sealed store) until the handshake ends
  _queue (peer, payload, mid, until = 'receipt') {
    const s = this.db.sessions[peer]
    if (s && drCanSend(s.dr)) {
      this._enqueueEnv(this._encrypt(peer, payload, mid), until, mid)
    } else {
      ;(this.db.queue[peer] = this.db.queue[peer] || []).push({ mid, payload, until })
      this._save()
      if (!this.db.pending[peer] && !s) this._startHandshake(peer)
    }
    this._flush(peer)
  }

  _encrypt (peer, payload, mid) {
    const s = this.db.sessions[peer]
    const id = mid || hex(rand(12))
    const ad = b4a.from(`qvac-msg/v${VERSION}|${this.me}|${peer}|${id}`)
    const r = drEncrypt(s.dr, pad(payload), ad)
    s.dr = r.state
    this._save()
    return { v: VERSION, id, from: this.me, to: peer, k: 'dr', h: r.header, n: r.n, c: r.c }
  }

  // until: 'receipt' (content: kept until the recipient confirms), 'hop' (receipts: until any
  // carrier has it), 'confirm' (hs2/hello: until the other side writes), 'hs2' (our hs1)
  _enqueueEnv (env, until, mid) {
    this.db.outbox.push({ id: env.id, to: env.to, env, until, mid: mid || null, createdAt: now(), hops: {}, nostrAt: 0 })
    this._save()
    // Second look soon after: the Nostr mailbox, if nothing faster took it
    setTimeout(() => { if (!this.closed) this._flush(env.to) }, 1200)
  }

  _startHandshake (peer) {
    if (!this.db.contacts[peer] || this.db.pending[peer]) return
    const e = x25519()
    const ts = now()
    const eh = hex(e.pk)
    const env = { v: VERSION, id: hex(rand(12)), from: this.me, to: peer, k: 'hs1', e: eh, ts, sig: sign(this.identity.secretKey, hsText('hs1', this.me, peer, eh, ts)) }
    this.db.pending[peer] = { e: eh, sk: hex(e.sk), ts, envId: env.id }
    this._enqueueEnv(env, 'hs2')
    this._flush(peer)
  }

  // Contacts with no conversation yet: the smaller key starts it (the other answers), so a
  // first message never waits for a handshake
  _proactiveHandshakes () {
    for (const key of Object.keys(this.db.contacts)) {
      if (!this.db.sessions[key] && !this.db.pending[key] && this.me < key) this._startHandshake(key)
    }
  }

  // ---------- links ----------

  addLink (peer, link) {
    if (!isKey(peer)) return
    link.peer = peer
    link.sent = new Set()
    link.blobsSent = new Set()
    if (!this.links.has(peer)) this.links.set(peer, new Set())
    this.links.get(peer).add(link)
    if (link.kind === 'session' && this.o.kind === 'desktop') this._sendDirectory(link)
    this._deliverRelay(peer)
    this._flush()
    this.emit({ type: 'contacts' })
  }

  // A file is travelling on this link (the host should not switch path now)
  isBusy (link) {
    if (this.blobSending.get(link)) return true
    for (const t of this.incomingBlobs.values()) if (t.link === link) return true
    return false
  }

  // e.g. a desktop forgotten on the phone: the contact stays only if something else knows it
  forgetSource (key, source) {
    const c = this.db.contacts[key]
    if (!c || !c.sources.includes(source)) return
    c.sources = c.sources.filter((s) => s !== source)
    if (!c.sources.length) this.removeContact(key, { keepHistory: true })
    else { this._save(); this.emit({ type: 'contacts' }) }
  }

  removeLink (peer, link) {
    const set = this.links.get(peer)
    if (set) { set.delete(link); if (!set.size) this.links.delete(peer) }
    for (const [bid, t] of this.incomingBlobs) {
      if (t.link === link) { try { this.fs.rmSync(t.tmp, { force: true }) } catch {} this.incomingBlobs.delete(bid) }
    }
    this.emit({ type: 'contacts' })
  }

  _openLinks (peer) { return [...(this.links.get(peer) || [])].filter((l) => l.open) }

  // Desktop: tells a device which other devices are "yours" (they become contacts there)
  _sendDirectory (link) {
    if (!this.o.directory) return
    link.send({ type: 'msg.dir', devices: this.o.directory().filter((d) => d.key !== link.peer) })
  }

  broadcastDirectory () {
    for (const set of this.links.values()) for (const l of set) if (l.kind === 'session' && l.open) this._sendDirectory(l)
  }

  // Lines from any link: msg, msg.ack, msg.dir, blob.*
  onLine (peer, link, msg) {
    const type = String(msg.type || '')
    if (type === 'msg') return this._onEnvelope(peer, link, msg.env)
    if (type === 'msg.ack') return this._onAck(peer, link, msg)
    if (type === 'msg.dir') {
      // Only a desktop we are paired with may introduce devices
      if (link.kind !== 'session' || this.o.kind !== 'phone' || !Array.isArray(msg.devices)) return
      return this.syncSource(peer, msg.devices.slice(0, 200).map((d) => ({ key: d.key, name: d.name, kind: d.kind === 'desktop' ? 'desktop' : 'phone' })))
    }
    if (type.startsWith('blob.')) return this._onBlobLine(peer, link, msg)
  }

  // ---------- receiving ----------

  _onEnvelope (peer, link, env) {
    if (!env || typeof env !== 'object' || !isId(env.id) || !isKey(env.from) || !isKey(env.to)) return
    // Not for us: a desktop keeps it for one of its devices
    if (env.to !== this.me) return this._relay(peer, link, env)
    // A direct link may only carry its own envelopes; a desktop may carry anyone's
    if (link && link.kind === 'direct' && env.from !== peer) return
    this._receive(env, link ? link.kind : 'nostr', (ok) => { if (link) link.send({ type: 'msg.ack', id: env.id, ok }) })
  }

  // ack(ok): tells the carrier it can forget the envelope
  _receive (env, via, ack = () => {}) {
    if (this.db.seen[env.id]) return ack(true) // duplicate (a path we did not need)
    const from = env.from
    if (!this.db.contacts[from]) {
      this.log(`messaggi: busta rifiutata da un mittente sconosciuto (${from.slice(0, 8)})`)
      this.emit({ type: 'rejected', from, reason: 'unknown' })
      return ack(false)
    }
    let ok = false
    if (env.k === 'hs1') ok = this._onHs1(env)
    else if (env.k === 'hs2') ok = this._onHs2(env)
    else if (env.k === 'dr') ok = this._onDr(env)
    if (ok === 'later') return ack(true) // kept until the conversation is ready
    if (!ok) {
      this.log(`messaggi: busta rifiutata (firma o cifratura non valida) da ${from.slice(0, 8)}`)
      this.emit({ type: 'rejected', from, reason: 'invalid' })
      return ack(false)
    }
    this._markSeen(env.id)
    ack(true)
  }

  _markSeen (id) {
    this.db.seen[id] = now()
    const ids = Object.keys(this.db.seen)
    if (ids.length > SEEN_MAX) {
      ids.sort((a, b) => this.db.seen[a] - this.db.seen[b])
      for (const old of ids.slice(0, ids.length - SEEN_MAX)) delete this.db.seen[old]
    }
    this._save()
  }

  _onHs1 (env) {
    const from = env.from
    if (!isKey(env.e) || !Number.isFinite(env.ts)) return false
    if (!verify(from, hsText('hs1', from, this.me, env.e, env.ts), env.sig)) return false
    const s = this.db.sessions[from]
    // A repeated hs1 we already answered: send the same answer again
    if (s && s.hs1 === env.e) {
      for (const r of s.reply || []) if (!this.db.outbox.some((i) => i.id === r.id)) this._enqueueEnv(r, 'confirm')
      this._flush(from)
      return true
    }
    // A replay of an old start (even with another envelope id), or older than our conversation: ignore
    if (this.db.hsSeen[env.e] || (s && env.ts <= (s.peerTs || 0))) return true
    // Both started at the same time: the smaller key's hs1 wins
    const mine = this.db.pending[from]
    if (mine) {
      if (this.me < from) return true // ours wins, theirs is dropped
      this._dropPending(from)
    }
    let eb = null
    try {
      eb = x25519()
      const ea = unhex(env.e)
      const root = rootKey(from, this.me, env.e, hex(eb.pk),
        dh(eb.sk, ea), dh(eb.sk, edPkToX(unhex(from))), dh(edSkToX(this.identity.secretKey), ea))
      const dr = drInitSender(root, ea)
      const ebh = hex(eb.pk)
      const hs2 = { v: VERSION, id: hex(rand(12)), from: this.me, to: from, k: 'hs2', e: ebh, re: env.e, sig: sign(this.identity.secretKey, hsText('hs2', this.me, from, ebh, env.e)) }
      this.db.sessions[from] = { dr, createdAt: now(), peerTs: env.ts, hs1: env.e, confirmed: false, reply: [] }
      this.db.hsSeen[env.e] = now()
      const seenHs = Object.keys(this.db.hsSeen)
      if (seenHs.length > 500) for (const k of seenHs.sort((a, b) => this.db.hsSeen[a] - this.db.hsSeen[b]).slice(0, seenHs.length - 500)) delete this.db.hsSeen[k]
      // Old outgoing envelopes for the previous conversation can no longer be read
      this._requeueAfterReset(from)
      const hello = this._encrypt(from, { t: 'hello', name: this.o.name, kind: this.o.kind, ts: now() })
      this.db.sessions[from].reply = [hs2, hello]
      this._enqueueEnv(hs2, 'confirm')
      this._enqueueEnv(hello, 'confirm')
      this._afterSession(from)
      return true
    } catch {
      return false
    } finally {
      if (eb) wipe(eb.sk)
    }
  }

  _onHs2 (env) {
    const from = env.from
    const p = this.db.pending[from]
    if (!p || env.re !== p.e) return true // not (or no longer) ours: nothing to do
    if (!isKey(env.e) || !verify(from, hsText('hs2', from, this.me, env.e, env.re), env.sig)) return false
    try {
      const ea = { pk: unhex(p.e), sk: unhex(p.sk) }
      const eb = unhex(env.e)
      const root = rootKey(this.me, from, p.e, env.e,
        dh(ea.sk, eb), dh(edSkToX(this.identity.secretKey), eb), dh(ea.sk, edPkToX(unhex(from))))
      const dr = drInitReceiver(root, ea) // eA stays as our ratchet key until their first message
      this.db.sessions[from] = { dr, createdAt: now(), peerTs: 0, hs1: null, confirmed: true, reply: [] }
      this._dropPending(from)
      this._requeueAfterReset(from)
      this._save()
      this._afterSession(from)
      return true
    } catch {
      return false
    }
  }

  _dropPending (peer) {
    const p = this.db.pending[peer]
    if (!p) return
    delete this.db.pending[peer]
    this.db.outbox = this.db.outbox.filter((i) => i.id !== p.envId)
    this._save()
  }

  // A new conversation replaced an old one: content not yet confirmed goes out again, re-encrypted
  _requeueAfterReset (peer) {
    const stale = this.db.outbox.filter((i) => i.to === peer && i.env.k === 'dr')
    if (!stale.length) return
    this.db.outbox = this.db.outbox.filter((i) => !(i.to === peer && i.env.k === 'dr'))
    // Their plaintext is gone (forward secrecy): only history entries can be rebuilt
    const list = this.history(peer)
    const q = this.db.queue[peer] = this.db.queue[peer] || []
    for (const item of stale) {
      if (item.until !== 'receipt' || !item.mid) continue
      const m = list.find((x) => x.id === item.mid)
      if (!m || q.some((x) => x.mid === m.id)) continue
      if (m.t === 'text') q.push({ mid: m.id, payload: { t: 'text', text: m.text, ts: m.ts }, until: 'receipt' })
      else this._updateMessage(peer, m.id, { status: 'failed', error: 'Conversazione ricominciata: invia di nuovo il file' })
    }
    this._save()
  }

  // The conversation is ready: queued messages go out, early envelopes are read
  _afterSession (peer) {
    const s = this.db.sessions[peer]
    if (s && drCanSend(s.dr)) {
      const q = this.db.queue[peer] || []
      delete this.db.queue[peer]
      for (const item of q) this._enqueueEnv(this._encrypt(peer, item.payload, item.mid), item.until, item.mid)
    }
    this._save()
    const early = this.db.early[peer] || []
    delete this.db.early[peer]
    for (const env of early) this._receive(env, 'early')
    this._flush(peer)
    this.emit({ type: 'contacts' })
  }

  _onDr (env) {
    const from = env.from
    const s = this.db.sessions[from]
    const keep = () => {
      const list = this.db.early[from] = this.db.early[from] || []
      if (!list.some((e) => e.id === env.id)) list.push(env)
      if (list.length > 200) list.shift()
      this._save()
      return 'later'
    }
    if (!s) return keep() // the handshake answer has not arrived yet
    const ad = b4a.from(`qvac-msg/v${VERSION}|${from}|${this.me}|${env.id}`)
    const r = drDecrypt(s.dr, env.h, env.n, env.c, ad)
    if (!r) return this.db.pending[from] ? keep() : false
    const payload = unpad(r.plain)
    wipe(r.plain)
    if (!payload || typeof payload !== 'object') return false
    s.dr = r.state
    const firstFromThem = !s.confirmed
    s.confirmed = true
    s.reply = []
    if (firstFromThem) this.db.outbox = this.db.outbox.filter((i) => !(i.to === from && i.until === 'confirm'))
    this._save()
    if (firstFromThem || (this.db.queue[from] || []).length) this._afterSession(from)
    this._onPayload(from, env.id, payload)
    return true
  }

  _onPayload (from, id, p) {
    const ts = Number.isFinite(p.ts) ? Math.min(p.ts, now() + 60000) : now()
    if (p.t === 'text') {
      this._addToHistory(from, { id, dir: 'in', t: 'text', text: String(p.text || '').slice(0, MAX_TEXT), ts, status: 'received' }, { unread: true })
      this._receipt(from, [id])
    } else if (p.t === 'file') {
      const bid = String(p.bid || '')
      if (!isId(bid) || !Number.isFinite(p.size) || p.size > MAX_FILE_BYTES) return
      const key = unb64(p.key)
      if (key.length !== 32) return
      this.db.files[bid] = { peer: from, mid: id, key: p.key, name: safeFileName(p.name), mime: String(p.mime || '').slice(0, 80), size: p.size, bh: String(p.bh || ''), bsize: p.bsize }
      this._save()
      this._addToHistory(from, { id, dir: 'in', t: 'file', file: { name: safeFileName(p.name), size: p.size, mime: String(p.mime || '').slice(0, 80), path: null, bid }, ts, status: 'downloading' }, { unread: true })
      this._tryOpenBlob(bid)
    } else if (p.t === 'rcpt') {
      for (const mid of (Array.isArray(p.ids) ? p.ids : []).slice(0, 100)) this._delivered(from, String(mid))
    } else if (p.t === 'hello' || p.t === 'name') {
      if (p.t === 'hello') this._receipt(from, [id]) // tells the other side the conversation works
      const c = this.db.contacts[from]
      if (c && p.name && cleanName(p.name) !== c.name) {
        c.name = cleanName(p.name)
        this._save()
        this.emit({ type: 'contacts' })
      }
    }
  }

  _receipt (peer, ids) {
    this._queue(peer, { t: 'rcpt', ids, ts: now() }, null, 'hop')
  }

  _delivered (peer, mid) {
    this.db.outbox = this.db.outbox.filter((i) => !(i.to === peer && i.mid === mid))
    for (const [bid, b] of Object.entries(this.db.blobsOut)) if (b.to === peer && b.mid === mid) this._dropBlobOut(bid)
    this._save()
    this._updateMessage(peer, mid, { status: 'delivered' })
  }

  _dropBlobOut (bid) {
    const b = this.db.blobsOut[bid]
    if (!b) return
    try { this.fs.rmSync(b.path, { force: true }) } catch {}
    delete this.db.blobsOut[bid]
  }

  _onAck (peer, link, msg) {
    const id = String(msg.id || '')
    // Postman: the recipient has it, the copy can go (a refusal keeps it for a later try)
    const kept = this.db.relay[peer]
    if (kept && msg.ok !== false) {
      const i = kept.findIndex((e) => e.id === id)
      if (i >= 0) { kept.splice(i, 1); if (!kept.length) delete this.db.relay[peer]; this._save() }
    }
    const item = this.db.outbox.find((x) => x.id === id)
    if (!item) return
    if (msg.ok === false) {
      if (peer !== item.to && msg.err === 'unknown') { item.hops['desk:' + peer] = 'no'; this._save(); return }
      // Refused (e.g. it does not know us yet): try again on this link in a while
      if (link && link.sent) setTimeout(() => link.sent.delete(id), 30000)
      return
    }
    if (peer === item.to) {
      item.hops.final = 'ok' // it has it: no more copies on other paths
      if (item.until === 'hop') this.db.outbox = this.db.outbox.filter((x) => x !== item)
      this._save()
      if (item.mid && item.until === 'receipt') {
        const hasBlob = Object.values(this.db.blobsOut).some((b) => b.mid === item.mid && b.to === peer)
        this._updateMessage(peer, item.mid, { status: hasBlob ? 'sent' : 'delivered' })
      }
      return
    }
    // A desktop keeps it for the recipient
    item.hops['desk:' + peer] = 'ok'
    if (item.until === 'hop') this.db.outbox = this.db.outbox.filter((x) => x !== item)
    this._save()
    if (item.mid) this._updateMessage(item.to, item.mid, { status: 'sent' })
  }

  // ---------- routing ----------

  _tick () {
    this._flush()
    this._syncMailbox()
    // a stuck handshake (lost hs1): start again after a day
    for (const [peer, p] of Object.entries(this.db.pending)) {
      if (now() - p.ts > 86400000) { this._dropPending(peer); this._startHandshake(peer) }
    }
    if (this.invite && now() > this.invite.expiresAt) this.cancelInvite('Codice scaduto')
    this._pruneRelay()
  }

  _flush (only) {
    if (this.closed) return
    for (const item of this.db.outbox) {
      if (only && item.to !== only) continue
      if (item.hops.final === 'ok') continue
      const direct = this._openLinks(item.to)
      for (const link of direct) {
        if (link.sent.has(item.id)) continue
        link.sent.add(item.id)
        link.send({ type: 'msg', env: item.env })
      }
      // A desktop of ours that may know the recipient
      if (!direct.length) {
        for (const [peer, set] of this.links) {
          if (peer === item.to) continue
          const c = this.db.contacts[peer]
          if (!c || c.kind !== 'desktop' || c.group !== 'mine') continue
          const hop = item.hops['desk:' + peer]
          if (hop === 'ok' || hop === 'no') continue
          for (const link of set) {
            if (!link.open || link.kind !== 'session' || link.sent.has(item.id)) continue
            link.sent.add(item.id)
            link.send({ type: 'msg', env: item.env })
            break
          }
        }
      }
      this._maybeMailbox(item, direct)
    }
    this._flushBlobs(only)
  }

  _flushBlobs (only) {
    for (const [bid, b] of Object.entries(this.db.blobsOut)) {
      if (only && b.to !== only) continue
      if (b.hops.final === 'ok') continue
      const targets = this._openLinks(b.to).filter((l) => l.fast)
      if (!targets.length) {
        for (const [peer, set] of this.links) {
          const c = this.db.contacts[peer]
          if (!c || c.kind !== 'desktop' || c.group !== 'mine' || b.hops['desk:' + peer]) continue
          for (const l of set) if (l.open && l.fast && l.kind === 'session') { targets.push(l); break }
        }
      }
      for (const link of targets) {
        if (link.blobsSent.has(bid) || this.blobSending.get(link)) continue
        link.blobsSent.add(bid)
        this._sendBlob(link, bid, b).catch(() => link.blobsSent.delete(bid))
        break
      }
    }
  }

  async _sendBlob (link, bid, b) {
    this.blobSending.set(link, true)
    try {
      const data = this.fs.readFileSync(b.path)
      await link.sendAsync({ type: 'blob.put', bid, from: this.me, to: b.to, size: data.length, bh: b.bh })
      for (let off = 0; off < data.length; off += BLOB_PIECE) {
        if (!link.open) throw new Error('closed')
        await link.sendAsync({ type: 'blob.data', bid, d: b64(data.subarray(off, off + BLOB_PIECE)) })
        this.emit({ type: 'progress', peer: b.to, mid: b.mid, done: Math.min(off + BLOB_PIECE, data.length), total: data.length })
      }
      await link.sendAsync({ type: 'blob.end', bid })
    } finally {
      this.blobSending.delete(link)
    }
  }

  _onBlobLine (peer, link, msg) {
    const bid = String(msg.bid || '')
    if (!isId(bid)) return
    if (msg.type === 'blob.ack') {
      const b = this.db.blobsOut[bid]
      if (b && msg.ok) {
        b.hops[peer === b.to ? 'final' : 'desk:' + peer] = 'ok'
        this._save()
        if (peer !== b.to) this._updateMessage(b.to, b.mid, { status: 'sent' })
      } else if (b && msg.err === 'unknown') {
        b.hops['desk:' + peer] = 'no'
        this._save()
      }
      // Postman: the recipient has the blob
      const rb = this.db.relayBlobs[bid]
      if (rb && rb.to === peer && msg.ok) {
        try { this.fs.rmSync(this.blobDir + '/relay-' + bid, { force: true }) } catch {}
        delete this.db.relayBlobs[bid]
        this._save()
      }
      return
    }
    if (msg.type === 'blob.put') {
      const size = Number(msg.size)
      const to = String(msg.to || '')
      const from = String(msg.from || '')
      if (!isKey(to) || !isKey(from) || !Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES + 65536) return link.send({ type: 'blob.ack', bid, ok: false, err: 'size' })
      if (to !== this.me) {
        if (from !== peer || !this.o.postmanFor || !this.o.postmanFor(to)) return link.send({ type: 'blob.ack', bid, ok: false, err: 'unknown' })
        if (this._relayBlobBytes() + size > RELAY_MAX_BLOB_BYTES) return link.send({ type: 'blob.ack', bid, ok: false, err: 'full' })
      } else if (!this.db.contacts[from]) return link.send({ type: 'blob.ack', bid, ok: false, err: 'unknown' })
      const tmp = this.blobDir + '/in-' + bid + '.part'
      try { this.fs.writeFileSync(tmp, b4a.alloc(0)) } catch { return }
      this.incomingBlobs.set(bid, { tmp, size, bh: String(msg.bh || ''), got: 0, to, from, link })
      return
    }
    const t = this.incomingBlobs.get(bid)
    if (!t || t.link !== link) return
    if (msg.type === 'blob.data') {
      const piece = unb64(msg.d)
      t.got += piece.length
      if (t.got > t.size) { this.incomingBlobs.delete(bid); try { this.fs.rmSync(t.tmp, { force: true }) } catch {} return link.send({ type: 'blob.ack', bid, ok: false, err: 'size' }) }
      this.fs.appendFileSync(t.tmp, piece)
      if (t.to === this.me) {
        const f = this.db.files[bid]
        if (f) this.emit({ type: 'progress', peer: f.peer, mid: f.mid, done: t.got, total: t.size })
      }
    } else if (msg.type === 'blob.end') {
      this.incomingBlobs.delete(bid)
      const data = this.fs.readFileSync(t.tmp)
      if (data.length !== t.size || hex(H(data)) !== t.bh) {
        try { this.fs.rmSync(t.tmp, { force: true }) } catch {}
        return link.send({ type: 'blob.ack', bid, ok: false, err: 'hash' })
      }
      if (t.to !== this.me) {
        this.fs.renameSync(t.tmp, this.blobDir + '/relay-' + bid)
        this.db.relayBlobs[bid] = { to: t.to, from: t.from, size: t.size, bh: t.bh, at: now() }
        this._save()
        link.send({ type: 'blob.ack', bid, ok: true })
        this._deliverRelay(t.to)
        return
      }
      this.fs.renameSync(t.tmp, this.blobDir + '/got-' + bid)
      link.send({ type: 'blob.ack', bid, ok: true })
      this._tryOpenBlob(bid)
    }
  }

  // Blob and its message both here: decrypt into the files folder, then confirm
  _tryOpenBlob (bid) {
    const f = this.db.files[bid]
    const p = this.blobDir + '/got-' + bid
    if (!f || !this.fs.existsSync(p)) return
    const blob = this.fs.readFileSync(p)
    const key = unb64(f.key)
    const plain = hex(H(blob)) === f.bh ? decryptBlob(key, blob) : null
    wipe(key)
    try { this.fs.rmSync(p, { force: true }) } catch {}
    delete this.db.files[bid]
    this._save()
    if (!plain || plain.length !== f.size) {
      this._updateMessage(f.peer, f.mid, { status: 'failed', error: 'File danneggiato o manomesso: scartato' })
      return
    }
    const local = this._saveLocalCopy(f.name, plain, 'Ricevuti')
    this._updateMessage(f.peer, f.mid, { status: 'received', file: { path: local } })
    this._receipt(f.peer, [f.mid])
  }

  // ---------- postman (desktop) ----------

  _relay (peer, link, env) {
    const ack = (ok, err) => link && link.send({ type: 'msg.ack', id: env.id, ok, err })
    if (!link || env.from !== peer) return ack(false, 'from') // only the sender itself hands it in
    if (!this.o.postmanFor || !this.o.postmanFor(env.to)) return ack(false, 'unknown')
    const list = this.db.relay[env.to] = this.db.relay[env.to] || []
    if (!list.some((e) => e.id === env.id)) {
      list.push({ ...env, _at: now() })
      if (list.length > RELAY_MAX_PER_PEER) list.shift()
      this._save()
    }
    ack(true)
    this._deliverRelay(env.to)
  }

  _deliverRelay (peer) {
    const links = this._openLinks(peer)
    if (!links.length) return
    for (const env of this.db.relay[peer] || []) {
      const { _at, ...clean } = env
      for (const l of links) {
        if (l.sent.has('r:' + env.id)) continue
        l.sent.add('r:' + env.id)
        l.send({ type: 'msg', env: clean })
        break
      }
    }
    for (const [bid, rb] of Object.entries(this.db.relayBlobs)) {
      if (rb.to !== peer) continue
      const l = links.find((x) => x.fast && !this.blobSending.get(x) && !x.blobsSent.has(bid))
      if (!l) continue
      l.blobsSent.add(bid)
      this._sendBlob(l, bid, { path: this.blobDir + '/relay-' + bid, to: peer, bh: rb.bh, mid: null })
        .then(() => this._deliverRelay(peer), () => l.blobsSent.delete(bid))
    }
  }

  _relayBlobBytes () {
    return Object.values(this.db.relayBlobs).reduce((n, b) => n + b.size, 0)
  }

  _pruneRelay () {
    let changed = false
    for (const [peer, list] of Object.entries(this.db.relay)) {
      const keep = list.filter((e) => now() - e._at < RELAY_MAX_AGE_MS && (!this.o.postmanFor || this.o.postmanFor(peer)))
      if (keep.length !== list.length) { changed = true; if (keep.length) this.db.relay[peer] = keep; else delete this.db.relay[peer] }
    }
    for (const [bid, rb] of Object.entries(this.db.relayBlobs)) {
      if (now() - rb.at < RELAY_MAX_AGE_MS) continue
      try { this.fs.rmSync(this.blobDir + '/relay-' + bid, { force: true }) } catch {}
      delete this.db.relayBlobs[bid]
      changed = true
    }
    if (changed) this._save()
  }

  relayInfo () {
    return {
      envelopes: Object.values(this.db.relay).reduce((n, l) => n + l.length, 0),
      blobs: Object.keys(this.db.relayBlobs).length,
      blobBytes: this._relayBlobBytes()
    }
  }

  // ---------- direct links (Hyperswarm) ----------

  _pair (peer) {
    if (!this.pairs.has(peer)) this.pairs.set(peer, pairSecret(this.identity, peer))
    return this.pairs.get(peer)
  }

  // Phones: every contact except our own desktops (they have a session already).
  // Desktop: only people (its own devices come to it).
  _directPeers () {
    return Object.values(this.db.contacts).filter((c) => this.o.kind === 'phone' ? !(c.kind === 'desktop' && c.group === 'mine') : c.group === 'person').map((c) => c.key)
  }

  _syncDirect () {
    if (!this.o.Hyperswarm || this.closed) return
    const allow = !this.o.allowDirect || this.o.allowDirect()
    const want = new Map()
    if (allow) for (const peer of this._directPeers()) want.set(hex(this._pair(peer).topic), peer)
    if (allow && this.invite && this.invite.secrets) want.set(hex(this.invite.secrets.topic), 'invite')
    if (!want.size && !this.swarm) return
    if (!this.swarm) {
      this.swarm = new this.o.Hyperswarm({ keyPair: this.o.swarmKeyPair })
      this.swarm.on('connection', (conn) => this._onSwarmConnection(conn))
    }
    for (const [topic] of this.topics) {
      if (!want.has(topic)) { this.swarm.leave(unhex(topic)).catch(() => {}); this.topics.delete(topic) }
    }
    for (const [topic, peer] of want) {
      if (this.topics.has(topic)) continue
      this.topics.set(topic, peer)
      try { this.swarm.join(unhex(topic), { server: true, client: true }) } catch {}
    }
  }

  // Every direct connection: each side proves its identity, bound to this connection
  // (signature over the Noise handshake hash); an invite connection also proves the code
  _onSwarmConnection (conn) {
    conn.on('error', () => {})
    const hh = conn.handshakeHash
    const inv = this.invite && this.invite.secrets
    const hi = {
      type: 'msg.hi', id: this.me, kind: this.o.kind, name: this.o.name,
      sig: sign(this.identity.secretKey, b4a.concat([hh, b4a.from('qvac-msg-link')]))
    }
    if (inv) hi.inv = inviteProof(inv.authKey, hh, this.me)
    writeLine(conn, hi)
    let peer = null
    let link = null
    const timer = setTimeout(() => { if (!peer) conn.destroy() }, 15000)
    onLines(conn, (msg) => {
      if (!peer) {
        if (msg.type !== 'msg.hi' || !isKey(msg.id) || msg.id === this.me) return conn.destroy()
        if (!verify(msg.id, b4a.concat([hh, b4a.from('qvac-msg-link')]), msg.sig)) return conn.destroy()
        const invNow = this.invite && this.invite.secrets
        if (!this.db.contacts[msg.id]) {
          // Not a contact: only with a valid proof of the invite code
          if (!invNow || !msg.inv || !checkInviteProof(invNow.authKey, hh, msg.id, msg.inv)) return conn.destroy()
          this._inviteDone({ key: msg.id, name: msg.name, kind: msg.kind === 'desktop' ? 'desktop' : 'phone', via: 'p2p' })
        }
        clearTimeout(timer)
        peer = msg.id
        link = streamLink(conn, { fast: true, kind: 'direct' })
        link.via = 'p2p'
        this.addLink(peer, link)
        return
      }
      this.onLine(peer, link, msg)
    })
    conn.on('close', () => { clearTimeout(timer); if (peer) this.removeLink(peer, link) })
  }

  // ---------- Nostr mailbox ----------

  _mailboxOn () {
    return this.db.options.nostrMailbox && this.o.nostr && (!this.o.allowNostr || this.o.allowNostr())
  }

  _mbKeys (peer, epoch) {
    const mb = this._pair(peer).mailbox
    return {
      tag: hex(H(b4a.from('tag:' + epoch), mb)),
      enc: H(b4a.from('enc:' + epoch), mb)
    }
  }

  _syncMailbox () {
    if (this.closed) return
    if (!this._mailboxOn()) {
      if (this.mailboxUnsub) { this.mailboxUnsub(); this.mailboxUnsub = null; this.mailboxTags.clear() }
      return
    }
    const epoch = Math.floor(now() / 1000 / MAILBOX_EPOCH_S)
    const tags = new Map()
    for (const peer of Object.keys(this.db.contacts)) {
      for (let e = epoch; e > epoch - MAILBOX_EPOCHS; e--) tags.set(this._mbKeys(peer, e).tag, { peer, epoch: e })
    }
    const same = tags.size === this.mailboxTags.size && [...tags.keys()].every((t) => this.mailboxTags.has(t))
    if (same && this.mailboxUnsub) return
    const pool = this.o.nostr.ensurePool()
    if (!pool) return
    if (this.mailboxUnsub) this.mailboxUnsub()
    this.mailboxTags = tags
    this.mailboxUnsub = null
    if (!tags.size) return
    const since = Math.max(Math.floor(now() / 1000) - MAILBOX_EPOCHS * MAILBOX_EPOCH_S, (this.db.mailboxSince || 0) - 86400)
    this.mailboxUnsub = pool.subscribe({ kinds: [MAILBOX_KIND], '#p': [...tags.keys()], since }, (ev) => this._onMailboxEvent(ev))
  }

  _onMailboxEvent (ev) {
    try {
      const p = (ev.tags || []).find((t) => t[0] === 'p')
      const where = p && this.mailboxTags.get(p[1])
      if (!where) return
      const box = open(this._mbKeys(where.peer, where.epoch).enc, ev.content)
      if (!box || !box.env || box.env.from !== where.peer || box.env.to !== this.me) return
      if (ev.created_at > (this.db.mailboxSince || 0)) this.db.mailboxSince = ev.created_at
      this._receive(box.env, 'nostr')
    } catch {}
  }

  _maybeMailbox (item, direct) {
    if (!this._mailboxOn() || item.hops.final === 'ok') return
    if (direct.length) return // a live link is faster and leaves no trace
    // With a desktop of ours online it may deliver at once: give it a few seconds first
    const postman = [...this.links.keys()].some((k) => { const c = this.db.contacts[k]; return c && c.kind === 'desktop' && c.group === 'mine' })
    if (now() - item.createdAt < (postman ? MAILBOX_DELAY_MS : 1000)) return
    if (item.nostrAt && now() - item.nostrAt < MAILBOX_REPUBLISH_MS) return
    const pool = this.o.nostr.ensurePool()
    if (!pool || !pool.openCount) return
    const epoch = Math.floor(now() / 1000 / MAILBOX_EPOCH_S)
    const { tag, enc } = this._mbKeys(item.to, epoch)
    const content = seal(enc, { env: item.env })
    if (content.length > 60000) return
    // A fresh random Nostr key for every event: nothing links two of them
    const sk = nostrSecret(rand(32))
    const ev = signNostr(sk, MAILBOX_KIND, [['p', tag], ['expiration', String(Math.floor(now() / 1000) + MAILBOX_TTL_S)]], content)
    if (pool.publish(ev)) {
      item.nostrAt = now()
      if (item.until === 'hop') this.db.outbox = this.db.outbox.filter((x) => x !== item)
      this._save()
      if (item.mid) this._updateMessage(item.to, item.mid, { status: 'sent' })
    }
  }

  // ---------- contact invites ----------
  // Inviter: createInvite() shows a code / QR; joiner: acceptInvite(code).
  // Both meet on a Hyperswarm topic and, in parallel, on a Nostr channel derived from the code.

  createInvite () {
    this.cancelInvite()
    const code = newContactCode()
    this._openInvite(code, 'inviter')
    return { code, uri: `qvacboard://contact?c=${code}&n=${encodeURIComponent(this.o.name || '')}`, expiresAt: this.invite.expiresAt }
  }

  acceptInvite (code) {
    const secrets = contactSecrets(code) // throws on a bad code
    this.cancelInvite()
    return new Promise((resolve, reject) => {
      this._openInvite(secrets.code, 'joiner', { resolve, reject })
    })
  }

  _openInvite (code, role, waiter = null) {
    const secrets = contactSecrets(code)
    const expiresAt = now() + (role === 'inviter' ? INVITE_MS : 60000)
    this.invite = { code: secrets.code, secrets, role, expiresAt, waiter, nostrUnsub: null, timers: [] }
    this._syncDirect()
    this.emit({ type: 'invite', state: 'waiting', role, code: secrets.code })
    if (this.o.nostr && (!this.o.allowNostr || this.o.allowNostr())) {
      const start = () => { if (this.invite && this.invite.code === secrets.code) this._inviteNostr(this.invite) }
      if (role === 'inviter') start()
      else this.invite.timers.push(setTimeout(start, this.o.allowDirect && !this.o.allowDirect() ? 300 : 12000))
    }
    if (role === 'joiner') this.invite.timers.push(setTimeout(() => this.cancelInvite('Nessuno ha risposto a questo codice: è ancora valido sull’altro dispositivo?'), 60000))
  }

  cancelInvite (reason) {
    const inv = this.invite
    if (!inv) return
    this.invite = null
    for (const t of inv.timers) clearTimeout(t)
    if (inv.nostrUnsub) inv.nostrUnsub()
    for (const k of inv.keys || []) wipe(k)
    this._syncDirect()
    if (inv.waiter && reason) inv.waiter.reject(new Error(reason))
    if (reason) this.emit({ type: 'invite', state: 'closed', reason })
  }

  _inviteDone ({ key, name, kind, via }) {
    const inv = this.invite
    if (!inv) return
    const added = !this.db.contacts[key]
    this.upsertContact({ key, name, kind, group: 'person', source: 'invite' })
    this.log(`messaggi: nuovo contatto “${cleanName(name)}” (${via})`)
    const result = { key, name: cleanName(name), kind, via, added }
    this.emit({ type: 'invite', state: 'done', contact: result })
    const waiter = inv.waiter
    inv.waiter = null
    // Single use; on Nostr we keep answering a little longer (in case our reply got lost)
    if (via === 'nostr') {
      inv.done = true
      this.invite = { ...inv, secrets: null }
      inv.timers.push(setTimeout(() => { if (this.invite && this.invite.timers === inv.timers) this.cancelInvite() }, 20000))
      this._syncDirect()
    }
    else this.cancelInvite()
    if (waiter) waiter.resolve(result)
  }

  // Over Nostr: one-time keys first (forward secrecy), then each side sends its identity,
  // signed over the code's secret and both one-time keys
  _inviteNostr (inv) {
    const L = this.o.nostr.link
    const pool = this.o.nostr.ensurePool()
    if (!pool || !L) return
    const keys = L.pairingKeys(inv.secrets.token)
    inv.keys = [keys.encKey]
    const meInviter = inv.role === 'inviter'
    const mySk = meInviter ? keys.macSk : keys.devSk
    const myPub = meInviter ? keys.macPub : keys.devPub
    const theirPub = meInviter ? keys.devPub : keys.macPub
    const token = inv.secrets.token
    const send = (payload) => L.sendSealed(pool, mySk, myPub, keys.encKey, payload)
    const idCard = (k, e1, e2) => L.seal(k, {
      id: this.me, name: this.o.name, kind: this.o.kind,
      sig: sign(this.identity.secretKey, b4a.from(`qvac-contact/v1|${token}|${e1}|${e2}|${this.me}`))
    })
    const checkCard = (card, e1, e2) => card && isKey(card.id) && card.id !== this.me &&
      verify(card.id, b4a.from(`qvac-contact/v1|${token}|${e1}|${e2}|${card.id}`), card.sig)
    if (meInviter) {
      const attempts = new Map() // joiner one-time key → { key, e, reply }
      inv.nostrUnsub = L.listenSealed(pool, theirPub, keys.encKey, (msg) => {
        if (typeof msg.e !== 'string' || !/^[0-9a-f]{64}$/.test(msg.e)) return
        let a = attempts.get(msg.e)
        if (msg.t === 'c-hello') {
          if (!a) {
            if (attempts.size >= 10 || inv.done) return
            const ot = L.oneTimeKeyPair()
            const shared = L.exchange(ot.secretKey, msg.e)
            L.wipe(ot.secretKey)
            if (!shared) return
            const e = hex(ot.publicKey)
            a = { key: H(b4a.concat([shared, keys.encKey, unhex(msg.e), unhex(e)]), LABEL('qvac-contact/nostr/v1')), e, reply: null }
            L.wipe(shared)
            inv.keys.push(a.key)
            attempts.set(msg.e, a)
          }
          return send({ t: 'c-hello', re: msg.e, e: a.e })
        }
        if (msg.t !== 'c-id' || !a) return
        if (a.reply) return send(a.reply)
        if (inv.done) return
        const card = L.open(a.key, msg.box)
        if (!checkCard(card, msg.e, a.e)) return
        a.reply = { t: 'c-id', re: msg.e, box: idCard(a.key, msg.e, a.e) }
        send(a.reply)
        this._inviteDone({ key: card.id, name: card.name, kind: card.kind === 'desktop' ? 'desktop' : 'phone', via: 'nostr' })
      })
      return
    }
    const ot = L.oneTimeKeyPair()
    const e = hex(ot.publicKey)
    let key = null
    let request = null
    inv.nostrUnsub = L.listenSealed(pool, theirPub, keys.encKey, (msg) => {
      if (msg.re !== e) return
      if (msg.t === 'c-hello' && !key) {
        const shared = L.exchange(ot.secretKey, msg.e)
        if (!shared) return
        L.wipe(ot.secretKey)
        key = H(b4a.concat([shared, keys.encKey, unhex(e), unhex(msg.e)]), LABEL('qvac-contact/nostr/v1'))
        L.wipe(shared)
        inv.keys.push(key)
        request = { t: 'c-id', e, box: idCard(key, e, msg.e) }
        request.theirE = msg.e
        send({ t: 'c-id', e, box: request.box })
        return
      }
      if (msg.t !== 'c-id' || !key || inv.done) return
      const card = L.open(key, msg.box)
      if (!checkCard(card, e, request.theirE)) return
      this._inviteDone({ key: card.id, name: card.name, kind: card.kind === 'desktop' ? 'desktop' : 'phone', via: 'nostr' })
    })
    const ask = () => {
      if (!this.invite || this.invite !== inv || inv.done) return
      send(request ? { t: 'c-id', e, box: request.box } : { t: 'c-hello', e })
    }
    inv.timers.push(setTimeout(ask, 800))
    inv.timers.push(setInterval(ask, 4000))
  }

  // ---------- for the UI ----------

  info () {
    return {
      me: this.me,
      options: this.db.options,
      invite: this.invite && !this.invite.done ? { code: this.invite.code, role: this.invite.role, expiresAt: this.invite.expiresAt } : null,
      outbox: this.db.outbox.filter((i) => i.until === 'receipt').length,
      relay: this.relayInfo(),
      mailbox: Boolean(this.mailboxUnsub),
      direct: this.swarm ? { topics: this.topics.size, connections: this.swarm.connections.size, peers: this.swarm.peers.size, links: [...this.links.values()].reduce((n, set) => n + [...set].filter((l) => l.kind === 'direct').length, 0) } : null
    }
  }
}

module.exports = {
  Messenger, streamLink, contactSecrets, normalizeContactCode, newContactCode, safetyNumber,
  // exposed for tests
  drInitSender, drInitReceiver, drEncrypt, drDecrypt, encryptBlob, decryptBlob, pad, unpad,
  MAX_FILE_BYTES, MAX_TEXT, MAILBOX_KIND
}
