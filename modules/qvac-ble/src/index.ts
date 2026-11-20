// JavaScript side of the native Bluetooth link (ios/QvacBleModule.swift, android/…/QvacBleModule.kt).
import { PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

type Events = {
  onData: (e: { data: string }) => void;
  onClose: (e: { error?: string }) => void;
  onState: (e: { state: string }) => void;
};

type Native = {
  state(): string;
  connect(uuids: string[], timeoutMs: number): Promise<string>;
  write(base64: string): void;
  disconnect(): void;
  addListener<K extends keyof Events>(name: K, listener: Events[K]): EventSubscription;
};

// Optional: an app build without the module simply has no Bluetooth method
const native = requireOptionalNativeModule<Native>('QvacBle');

// Android asks at run time (iOS asks by itself the first time the radio is used).
// 12+: "dispositivi nelle vicinanze"; 10-11: the location permission was required for scanning.
let asked: Promise<boolean> | null = null;
function androidPermissions() {
  if (Platform.OS !== 'android') return Promise.resolve(true);
  asked ??= (async () => {
    const wanted = Number(Platform.Version) >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const res = await PermissionsAndroid.requestMultiple(wanted);
    return wanted.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
  })().finally(() => { setTimeout(() => { asked = null; }, 60_000); });
  return asked;
}

export const bleAvailable = Boolean(native);

export const ble = {
  state: () => native?.state() ?? 'unsupported',
  connect: async (uuids: string[], timeoutMs: number) => {
    if (!native) throw new Error('Bluetooth non disponibile in questa versione dell’app');
    if (!(await androidPermissions())) throw new Error('Bluetooth non autorizzato per QVAC-BOARD');
    return native.connect(uuids, timeoutMs);
  },
  write: (base64: string) => native?.write(base64),
  disconnect: () => native?.disconnect(),
  on<K extends keyof Events>(name: K, listener: Events[K]) {
    return native?.addListener(name, listener) ?? { remove() {} };
  },
};
