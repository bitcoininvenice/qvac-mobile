// Impostazioni dell'app, salvate nel portachiavi (piccolo JSON).
import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';

export type Settings = {
  defaultModel: string; // 'local' oppure '<chiave del server>|<id del modello>'
  think: boolean; // ragionamento attivo di default
  liveStats: boolean; // CPU/GPU/RAM del server dal vivo nella Home
  haptics: boolean; // vibrazione leggera ai tocchi
  nostrRelays: string[]; // relay aggiunti da te, oltre a quelli che indica il server
  deviceName: string; // nome con cui il dispositivo mobile si presenta ai server ('' = modello)
  paths: { lan: boolean; ble: boolean; p2p: boolean; nostr: boolean }; // metodi di connessione consentiti
  fallbackLocal: boolean; // server non raggiungibile → risponde il modello del dispositivo mobile
  agentName: string; // nome dell'assistente vocale (default: 'Aura')
  language: string; // lingua vocale (es. 'it-IT', 'en-US')
  voice: string; // nome o etichetta della voce
  voiceIdentifier: string; // identificatore univoco della voce nativa di sistema
  voiceSpeed: number; // velocità voce (0.8..1.3)
  msgNostrMailbox: boolean; // Messaggi: casella Nostr quando nessuna via diretta o server è disponibile
  voiceBargeIn: boolean; // Parla: puoi interrompere l'assistente parlando (microfono acceso mentre parla, con cancellazione dell'eco)
  voiceOnDevice: boolean; // Parla: riconoscimento vocale solo sul dispositivo (l'audio non va ad Apple)
  voicePause: 'short' | 'normal' | 'long'; // Parla: quanto silenzio prima che l'assistente risponda
};

const KEY = 'qvac-settings';
const DEFAULTS: Settings = {
  defaultModel: 'local',
  think: false,
  liveStats: true,
  haptics: true,
  nostrRelays: [],
  deviceName: '',
  paths: { lan: true, ble: true, p2p: true, nostr: true },
  fallbackLocal: true,
  agentName: 'Aura',
  language: 'it-IT',
  voice: 'Federica',
  voiceIdentifier: '',
  voiceSpeed: 1.0,
  msgNostrMailbox: true,
  voiceBargeIn: true,
  voiceOnDevice: true,
  voicePause: 'normal',
};

let current: Settings = { ...DEFAULTS };
let loaded = false;
const listeners = new Set<() => void>();

export async function loadSettings() {
  if (loaded) return current;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // nested: settings saved before Bluetooth existed get it switched on
      current = { ...DEFAULTS, ...saved, paths: { ...DEFAULTS.paths, ...(saved.paths ?? {}) } };
    }
  } catch { /* restano i predefiniti */ }
  loaded = true;
  listeners.forEach((fn) => fn());
  return current;
}

export function getSettings() {
  return current;
}

export async function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  listeners.forEach((fn) => fn());
  await SecureStore.setItemAsync(KEY, JSON.stringify(current)).catch(() => {});
}

export function useSettings() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    loadSettings();
    return () => { listeners.delete(fn); };
  }, []);
  return current;
}

// Vibrazione leggera, solo se attiva nelle impostazioni
export function tap(kind: 'select' | 'success' | 'warning' = 'select') {
  if (!current.haptics) return;
  if (kind === 'select') Haptics.selectionAsync().catch(() => {});
  else Haptics.notificationAsync(kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => {});
}
