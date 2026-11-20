declare const harness: {
  start(
    opts?: import('react-native-bare-kit').WorkletOptions &
      Omit<import('bare-stow-host').IPCOptions, 'kill'>
  ): Promise<{ ipc: import('bare-stow-host').IPC }>
}

export default harness
