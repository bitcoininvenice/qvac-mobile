import { Worklet } from 'react-native-bare-kit'
import stow from 'bare-stow-host'
import bundle from "./index.bundle.mjs"

export default {
  async start({ timeout, grace, ...opts } = {}) {
    const worklet = new Worklet(opts)

    worklet.start("bare-stow.bundle", bundle)

    const ipc = stow.wrap(worklet.IPC, { kill: () => worklet.terminate(), timeout, grace })

    worklet.IPC.on('end', () => worklet.IPC.destroy())

    worklet.on('exit', (code) => ipc.exited(code))

    await ipc.ready

    return { ipc }
  }
}
