'use strict'
// Web globals that Bare does not have but some libraries expect (@noble/hashes
// uses TextEncoder/TextDecoder already at load time). Must be required first.
const b4a = require('b4a')

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    get encoding () { return 'utf-8' }
    encode (input = '') {
      // A fresh buffer of its own, like the real TextEncoder (not a view on a shared pool,
      // which a caller might transfer and break everything else using that pool)
      const buf = b4a.from(String(input), 'utf8')
      const out = new Uint8Array(buf.byteLength)
      out.set(buf)
      return out
    }
  }
}

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    get encoding () { return 'utf-8' }
    decode (input) {
      if (!input) return ''
      const view = ArrayBuffer.isView(input)
        ? b4a.from(input.buffer, input.byteOffset, input.byteLength)
        : b4a.from(input)
      return b4a.toString(view, 'utf8')
    }
  }
}
