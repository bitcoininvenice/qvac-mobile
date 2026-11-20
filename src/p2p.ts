// React Native side of P2P: starts the Bare worker (p2p-worker/worker.js) and
// talks to it with JSON lines. The phone's identity (a 32-byte seed) and the
// list of paired Macs live in the iOS Keychain (expo-secure-store).
import { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import b4a from 'b4a';
import { getSettings, loadSettings } from './settings';
import { ble, bleAvailable } from '../modules/qvac-ble/src';
import worker from 'p2p-worker-pkg';

export type Lan = { addresses: string[]; port: number };
export type Mac = { mac: string; name: string; customName?: string; pairedAt: string; lan?: Lan | null; models?: { id: string; label: string; sizeMB?: number }[]; relays?: string[]; paths?: PathSet | null; bleSecret?: string | null };
export type RelayState = { url: string; open: boolean };
export type MeshNetwork = { code: string; id: string; joinedAt: string; desktops: string[] };
const NETWORKS_KEY = 'qvac-mesh-networks';
export type PathKind = 'lan' | 'ble' | 'p2p' | 'nostr';
export type PathSet = Record<PathKind, boolean>;

// The three ways to reach a desktop, best first. Same names everywhere (app and board).
export const PATHS: Record<PathKind, { icon: string; label: string; short: string; privacy: string }> = {
  lan: {
    icon: '🏠', label: 'Rete locale', short: 'Rete locale',
    privacy: 'Il traffico non esce dalla tua rete. Cifrato, con chiavi nuove a ogni collegamento.',
  },
  ble: {
    icon: '🔵', label: 'Bluetooth', short: 'Bluetooth',
    privacy: 'Senza internet, solo radio a pochi metri. Il desktop trasmette un codice che cambia ogni ora e che solo i tuoi dispositivi riconoscono. Cifrato, con chiavi nuove a ogni collegamento.',
  },
  p2p: {
    icon: '⚡', label: 'Holepunch (P2P diretto)', short: 'Holepunch',
    privacy: 'Dati diretti tra i due dispositivi, cifrati con chiavi nuove a ogni collegamento. All’apertura i nodi della DHT vedono gli indirizzi IP.',
  },
  nostr: {
    icon: '📡', label: 'Nostr (relay)', short: 'Nostr',
    privacy: 'I dati cifrati passano dai relay pubblici, con chiavi nuove a ogni collegamento. I relay vedono gli indirizzi IP, quanto e quando, mai il contenuto.',
  },
};
export const pathLabel = (via?: string | null) => (via && via in PATHS ? `${PATHS[via as PathKind].icon} ${PATHS[via as PathKind].label}` : '');
export const pathShort = (via?: string | null) => (via && via in PATHS ? `${PATHS[via as PathKind].icon} ${PATHS[via as PathKind].short}` : '');

// The name shown for a Mac: the one you gave it on the iPhone, else the one it gives itself
export const macLabel = (m: Pick<Mac, 'name' | 'customName'>) => m.customName || m.name;

export async function renameMac(mac: string, name: string) {
  const m = store.macs.find((x) => x.mac === mac);
  if (!m) return;
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (clean && clean !== m.name) m.customName = clean;
  else delete m.customName;
  await saveMacs();
  notify();
}

// The name this phone shows to the desktops (empty = the model, e.g. "iPhone 15")
export function deviceName() {
  return getSettings().deviceName || Device.modelName || (Platform.OS === 'android' ? 'Android' : 'iPhone');
}

export function applyDeviceName() {
  if (store.state.kind === 'ready') call('setDeviceName', { name: deviceName() }).catch(() => { });
}
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

// Relay in uso sul dispositivo: quelli indicati dai desktop + quelli aggiunti nelle Impostazioni
export function relaysInUse() {
  const fromMacs = store.macs.flatMap((m) => m.relays ?? []);
  const all = [...new Set([...fromMacs, ...getSettings().nostrRelays])];
  return (all.length ? all : DEFAULT_RELAYS).slice(0, 8);
}

export function applyPaths() {
  if (store.state.kind === 'ready') call('setPaths', { paths: getSettings().paths }).catch(() => { });
}

export function applyRelays() {
  if (store.state.kind === 'ready') call('setRelays', { relays: relaysInUse() }).catch(() => { });
}

export async function nostrStatus(): Promise<{ active: boolean; relays: RelayState[] }> {
  try { return await call('nostrStatus'); } catch { return { active: false, relays: relaysInUse().map((url) => ({ url, open: false })) }; }
}
export type RemoteModel = { id: string; label: string; sizeMB?: number };
export type MacStatus = {
  online: boolean; via: 'lan' | 'p2p' | 'nostr' | null; sameNetwork: boolean | null; rtt: number | null;
  models: RemoteModel[]; revoked?: boolean; error?: string; nextTry?: number | null; step?: string | null; since?: number | null;
};
export type NatInfo = { firewalled: boolean; randomized: boolean; online: boolean };
export type Transfer = { id: string; mac: string; direction: 'in' | 'out'; name: string; sent: number; total: number };
export type ReceivedFile = { name: string; uri: string; size: number; at: number };
export type MacSystem = {
  cpu: number | null; gpu: number | null; memUsed: number | null; memTotal: number | null;
  model: { label: string; busy: boolean } | null; tokensPerSecond: number | null; chats: number;
  history: { cpu: number[]; gpu: number[]; mem: number[] }; at: number;
};
const HISTORY = 40; // ~80 secondi di grafico
export type ChatEvent =
  | { kind: 'token' | 'thinking' | 'status'; text: string }
  | { kind: 'done'; tokensPerSecond?: number }
  | { kind: 'error'; error: string }
  | { kind: 'tool'; callId: string; server: string; tool: string; status: 'running' | 'done' | 'error' | 'denied'; summary?: string }
  | { kind: 'confirm'; callId: string; server: string; tool: string; args: unknown; remote: boolean }
  | { kind: 'phonecall'; callId: string; tool: string; args: unknown };
export type P2PState =
  | { kind: 'starting' }
  | { kind: 'ready'; publicKey: string }
  | { kind: 'error'; message: string };

// ---------- messaggi tra dispositivi (cifrati end-to-end, vedi p2p-worker/msg-core.js) ----------
export type MsgContact = {
  key: string; name: string; ownName: string; customName: string | null; kind: 'phone' | 'desktop'; group: 'mine' | 'person';
  online: boolean; via: string | null; secure: boolean; safety: string; unread: number;
  last: { dir: 'in' | 'out'; text: string; ts: number } | null; updatedAt: number;
};
export type MsgStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'received' | 'downloading';
export type ChatMsg = {
  id: string; dir: 'in' | 'out'; t: 'text' | 'file'; text?: string; ts: number; status: MsgStatus; error?: string;
  file?: { name: string; size: number; mime: string; path: string | null };
};
export type MsgInfo = { me: string; options: { nostrMailbox: boolean }; invite: { code: string; role: string; expiresAt: number } | null; outbox: number; mailbox: boolean };
const MSG_KEY = 'qvac-msg-key'; // chiave che sigilla i messaggi salvati sul telefono (nel portachiavi)

const SEED_KEY = 'qvac-device-seed';
const MACS_KEY = 'qvac-paired-macs';

type Listener = () => void;
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((fn) => fn());

let ipc: any = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// Who is waiting for a given desktop to admit us through a mesh network (QR scan)
const meshWaiters = new Map<string, Set<(result: PairResult) => void>>();

export const store = {
  state: { kind: 'starting' } as P2PState,
  macs: [] as Mac[],
  status: {} as Record<string, MacStatus>,
  transfers: {} as Record<string, Transfer>, // in corso
  received: [] as ReceivedFile[], // file arrivati dal desktop (cartella Documenti dell'app)
  system: {} as Record<string, MacSystem>, // stato dal vivo dei Mac, per la Home
  nat: null as NatInfo | null, // com'è la rete dell'iPhone vista da Holepunch
  pairingNote: '' as string, // tentativi in corso durante l'abbinamento
  workerError: '' as string, // ultimo errore imprevisto del worker P2P (per la diagnosi)
  networks: [] as MeshNetwork[], // reti mesh a cui appartiene questo dispositivo
  meshNote: '' as string, // ultimo esito dalla rete mesh
  msg: {
    contacts: [] as MsgContact[],
    info: null as MsgInfo | null,
    unread: 0,
    histories: {} as Record<string, ChatMsg[]>,
    progress: {} as Record<string, { done: number; total: number }>, // foto e file in viaggio (id del messaggio)
    invite: null as null | { state: string; reason?: string; contact?: { key: string; name: string } },
  },
};

const chatHandlers = new Map<string, (e: ChatEvent) => void>();
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!ipc) return Promise.reject(new Error('P2P non avviato'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ipc.write(b4a.from(JSON.stringify({ ...args, id, cmd }) + '\n')); // id last: never overwritten by args
  });
}

function onMessage(msg: any) {
  if (msg.event === 'msg') { onMsgEvent(msg); return; }
  if (msg.event === 'chat') {
    const handler = chatHandlers.get(msg.id);
    if (!handler) return;
    if (msg.kind === 'done' || msg.kind === 'error') chatHandlers.delete(msg.id);
    handler(
      msg.kind === 'error' ? { kind: 'error', error: msg.error }
        : msg.kind === 'done' ? { kind: 'done', tokensPerSecond: msg.tokensPerSecond }
          : msg.kind === 'tool' ? { kind: 'tool', callId: msg.callId, server: msg.server, tool: msg.tool, status: msg.status, summary: msg.summary }
            : msg.kind === 'confirm' ? { kind: 'confirm', callId: msg.callId, server: msg.server, tool: msg.tool, args: msg.args, remote: Boolean(msg.remote) }
              : msg.kind === 'phonecall' ? { kind: 'phonecall', callId: msg.callId, tool: msg.tool, args: msg.args }
                : { kind: msg.kind, text: msg.text ?? '' },
    );
    return;
  }
  if (msg.event === 'system') {
    const prev = store.system[msg.mac];
    const push = (arr: number[] | undefined, v: number | null) => [...(arr ?? []), v ?? 0].slice(-HISTORY);
    const mem = msg.memUsed && msg.memTotal ? msg.memUsed / msg.memTotal : null;
    store.system = {
      ...store.system,
      [msg.mac]: {
        cpu: msg.cpu, gpu: msg.gpu, memUsed: msg.memUsed, memTotal: msg.memTotal,
        model: msg.model, tokensPerSecond: msg.tokensPerSecond, chats: msg.chats ?? 0, at: Date.now(),
        history: { cpu: push(prev?.history.cpu, msg.cpu), gpu: push(prev?.history.gpu, msg.gpu), mem: push(prev?.history.mem, mem) },
      },
    };
    notify();
    return;
  }
  // A desktop of one of our mesh networks admitted us: it becomes a paired desktop
  if (msg.event === 'mesh.desktop') {
    const net = store.networks.find((n) => n.code === msg.code);
    if (net && !net.desktops.includes(msg.result.mac)) {
      net.desktops = [...net.desktops, msg.result.mac];
      saveNetworks();
    }
    const known = store.macs.some((m) => m.mac === msg.result.mac);
    const saved = savePaired(msg.result, null);
    saved.catch(() => {});
    const waiting = meshWaiters.get(msg.result.mac);
    if (waiting) saved.then(() => waiting.forEach((fn) => fn({ ...msg.result, path: 'mesh' })), () => {});
    if (!known) store.meshNote = `“${msg.result.name}” trovato nella rete mesh ${msg.id}`;
    notify();
    return;
  }
  if (msg.event === 'mesh.status') {
    store.meshNote = msg.error ? `Rete mesh: ${msg.error}` : '';
    notify();
    return;
  }
  if (msg.event === 'worker.error') {
    // The P2P worker hit an error it did not expect: it kept running (or reports why it could not start)
    store.workerError = String(msg.error ?? '');
    notify();
    Alert.alert('Errore del collegamento P2P', store.workerError.slice(0, 900));
    return;
  }
  if (msg.event === 'pairing') {
    store.pairingNote = msg.text ?? '';
    notify();
    return;
  }
  // The worker asks us to open / use / close the radio link (the radio lives here, in native code)
  if (msg.event === 'ble.connect') {
    ble.connect(msg.uuids, msg.timeoutMs)
      .then(() => call('bleResult', { reqId: msg.reqId, ok: true }))
      .catch((err) => call('bleResult', { reqId: msg.reqId, ok: false, error: (err as Error).message }))
      .catch(() => { });
    return;
  }
  if (msg.event === 'ble.write') { ble.write(msg.data); return; }
  if (msg.event === 'ble.close') { ble.disconnect(); return; }
  if (msg.event === 'transfer') {
    const prev = store.transfers[msg.id];
    store.transfers = { ...store.transfers, [msg.id]: { id: msg.id, mac: msg.mac, direction: msg.direction, name: msg.name ?? prev?.name ?? 'file', sent: msg.sent, total: msg.total } };
    notify();
    return;
  }
  if (msg.event === 'file') {
    const { [msg.id]: _done, ...rest } = store.transfers;
    store.transfers = rest;
    loadReceived();
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error), { code: msg.code }));
  } else if (msg.event === 'status') {
    store.status = { ...store.status, [msg.mac]: { online: msg.online, via: msg.via ?? null, sameNetwork: msg.sameNetwork, rtt: msg.rtt, models: msg.models ?? [], revoked: Boolean(msg.revoked), error: msg.error, nextTry: msg.nextTry ?? null, step: msg.step ?? null, since: msg.since ?? null } };
    // Keep name and home addresses of the Mac up to date (used for the local path next time)
    const m = store.macs.find((x) => x.mac === msg.mac);
    if (m) {
      let changed = false;
      if (msg.name && m.name !== msg.name) { m.name = msg.name; changed = true; }
      if (msg.lan && JSON.stringify(m.lan) !== JSON.stringify(msg.lan)) { m.lan = msg.lan; changed = true; }
      if (msg.models?.length && JSON.stringify(m.models) !== JSON.stringify(msg.models)) { m.models = msg.models; changed = true; }
      if (msg.macPaths && JSON.stringify(m.paths) !== JSON.stringify(msg.macPaths)) { m.paths = msg.macPaths; changed = true; }
      if (msg.bleSecret && m.bleSecret !== msg.bleSecret) { m.bleSecret = msg.bleSecret; changed = true; }
      const relaysChanged = Array.isArray(msg.relays) && msg.relays.length && JSON.stringify(m.relays) !== JSON.stringify(msg.relays);
      if (relaysChanged) { m.relays = msg.relays; changed = true; }
      if (changed) saveMacs();
      if (relaysChanged) applyRelays();
    }
    notify();
  }
}

async function saveMacs() {
  await SecureStore.setItemAsync(MACS_KEY, JSON.stringify(store.macs));
}

let started: Promise<void> | null = null;

export function startP2P() {
  started ??= (async () => {
    try {
      const raw = await SecureStore.getItemAsync(MACS_KEY);
      store.macs = raw ? JSON.parse(raw) : [];
      notify();

      await loadSettings();
      ({ ipc } = await worker.start());
      // Radio bytes from the desktop go straight to the worker, which decrypts them
      ble.on('onData', (e) => { call('bleData', { data: e.data }).catch(() => { }); });
      ble.on('onClose', () => { call('bleClosed').catch(() => { }); });
      let buf = '';
      ipc.on('data', (data: Uint8Array) => {
        buf += b4a.toString(data);
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) onMessage(JSON.parse(line));
        }
      });

      const seed = await SecureStore.getItemAsync(SEED_KEY);
      const msgKey = await SecureStore.getItemAsync(MSG_KEY);
      const me = await call<{ seed: string; publicKey: string; nat: NatInfo; msgKey: string | null }>('init', {
        msgKey,
        seed,
        name: deviceName(),
        platform: Platform.OS, // 'ios' | 'android' (the desktop shows a phone either way)
        filesDir: Paths.document.uri, // i file dal desktop finiscono qui (visibili nell'app File)
        bluetooth: bleAvailable,
      });
      loadReceived();
      if (!seed) await SecureStore.setItemAsync(SEED_KEY, me.seed);
      if (me.msgKey && me.msgKey !== msgKey) await SecureStore.setItemAsync(MSG_KEY, me.msgKey);
      await call('msgOptions', { options: { nostrMailbox: getSettings().msgNostrMailbox } }).catch(() => { });
      store.state = { kind: 'ready', publicKey: me.publicKey };
      refreshMessages();
      await call('setRelays', { relays: relaysInUse() }).catch(() => { });
      await call('setPaths', { paths: getSettings().paths }).catch(() => { });
      store.nat = me.nat;
      notify();
      // Mesh networks: rejoin them, to find desktops added since
      try { store.networks = JSON.parse((await SecureStore.getItemAsync(NETWORKS_KEY)) ?? '[]'); } catch { store.networks = []; }
      for (const n of store.networks) call('joinMesh', { code: n.code }).catch(() => {});
      for (const m of store.macs) call('watch', { mac: m.mac, name: m.name, lan: m.lan ?? null, paths: m.paths ?? null, bleSecret: m.bleSecret ?? null }).catch(() => { });
    } catch (err) {
      store.state = { kind: 'error', message: (err as Error).message };
      started = null;
      notify();
    }
  })();
  return started;
}

// Reads a QR code: qvacboard://pair?p=<pairing key>&m=<mac key>&n=<name>
export function parsePairingUri(text: string) {
  const match = /^qvacboard:\/\/pair\?(.+)$/.exec(text.trim());
  if (!match) return null;
  const params = Object.fromEntries(match[1].split('&').map((kv) => kv.split('=').map(decodeURIComponent)));
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(params.p ?? '') || !hex.test(params.m ?? '')) return null;
  // Indirizzi di casa del desktop e segreto monouso: abbinamento anche senza Holepunch
  const addresses = String(params.l ?? '').split(',').filter((a: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  const port = Number(params.lp);
  const lan = addresses.length && port > 0 && port < 65536 ? { addresses, port } : null;
  const token = /^[0-9a-f]{32}$/.test(params.t ?? '') ? (params.t as string) : null;
  // v = vie che il desktop accetta (l = rete locale, p = Holepunch, n = Nostr); assente = tutte
  const v = typeof params.v === 'string' ? params.v : null;
  const macPaths: PathSet | null = v === null ? null : { lan: v.includes('l'), ble: v.includes('b'), p2p: v.includes('p'), nostr: v.includes('n') };
  // c = codice della rete mesh del desktop (se attiva): con una scansione si entra anche nella rete
  const network = typeof params.c === 'string' && codeKind(params.c) === 'network' ? (params.c as string) : null;
  return { pairingKey: params.p as string, mac: params.m as string, name: (params.n as string) || 'Desktop', token, lan, macPaths, network };
}

type PairResult = { mac: string; name: string; lan: Lan | null; relays?: string[] | null; paths?: PathSet | null; ble?: { secret: string } | null; path: PathKind | 'mesh' };

// Resolves when this desktop admits us through a mesh network (or rejects after ms)
function waitForMeshDesktop(mac: string, ms: number) {
  return new Promise<PairResult>((resolve, reject) => {
    const set = meshWaiters.get(mac) ?? new Set();
    meshWaiters.set(mac, set);
    const done = (result: PairResult) => { cleanup(); resolve(result); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Il desktop non è stato trovato nella rete mesh')); }, ms);
    function cleanup() {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) meshWaiters.delete(mac);
    }
    set.add(done);
  });
}

// A scanned QR. If it carries the mesh code, two attempts start together and the first
// that succeeds wins: entering the mesh network (the desktop admits us by itself) and the
// QR's one-time invite (home network, Holepunch, Nostr). Either way the iPhone stays in the
// network, so it finds by itself the desktops added to it later.
export async function pairFromQr(text: string): Promise<PairResult> {
  const info = parsePairingUri(text);
  if (!info) throw new Error('Questo non è un QR code di QVAC-BOARD');
  if (!info.network) return pairWithUri(text);
  await startP2P();
  const viaMesh = (async () => {
    const waiting = waitForMeshDesktop(info.mac, 45_000);
    waiting.catch(() => {});
    await joinNetwork(info.network!);
    return waiting;
  })();
  const viaInvite = pairWithUri(text);
  return new Promise<PairResult>((resolve, reject) => {
    let failed = 0;
    const errors: Error[] = [];
    const fail = (i: number) => (err: Error) => {
      errors[i] = err;
      if (++failed === 2) reject(errors[1] ?? errors[0]); // the invite's message explains more
    };
    viaMesh.then(resolve, fail(0));
    viaInvite.then(resolve, fail(1));
  });
}

export async function pairWithUri(text: string) {
  const info = parsePairingUri(text);
  if (!info) throw new Error('Questo non è un QR code di QVAC-BOARD');
  await startP2P();
  store.pairingNote = '';
  const result = await call<PairResult>('pair', {
    pairingKey: info.pairingKey, mac: info.mac, token: info.token, lan: info.lan, macPaths: info.macPaths,
  });
  return savePaired(result, info.macPaths);
}

async function saveNetworks() {
  await SecureStore.setItemAsync(NETWORKS_KEY, JSON.stringify(store.networks));
}

// Join a mesh network with its permanent code (XXXX-XXXX-XXXX-XXXX): its desktops admit us
// by themselves (event 'mesh.desktop'); we stay in it to find desktops added later
export async function joinNetwork(code: string) {
  await startP2P();
  const { id, code: canonical } = await call<{ id: string; code: string }>('joinMesh', { code });
  if (!store.networks.some((n) => n.code === canonical)) {
    store.networks = [...store.networks, { code: canonical, id, joinedAt: new Date().toISOString(), desktops: [] }];
    await saveNetworks();
  }
  store.meshNote = 'Cerco i desktop della rete…';
  notify();
  return id;
}

export async function leaveNetwork(code: string) {
  await call('leaveMesh', { code }).catch(() => {});
  store.networks = store.networks.filter((n) => n.code !== code);
  await saveNetworks();
  notify();
}

// What kind of code was typed: 12 characters = one-time invite, 16 = mesh network
export function codeKind(text: string): 'invite' | 'network' | null {
  const plain = text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return plain.length === 12 ? 'invite' : plain.length === 16 ? 'network' : null;
}

// The invite code shown by the desktop under its QR (XXXX-XXXX-XXXX): works from any network
export async function pairWithCode(code: string) {
  await startP2P();
  store.pairingNote = '';
  const result = await call<PairResult>('pairWithCode', { code });
  return savePaired(result, null);
}

async function savePaired(result: PairResult, qrPaths: PathSet | null) {
  const paths = result.paths ?? qrPaths ?? null;
  const old = store.macs.find((m) => m.mac === result.mac);
  store.macs = [
    ...store.macs.filter((m) => m.mac !== result.mac),
    {
      ...old, mac: result.mac, name: result.name, pairedAt: new Date().toISOString(),
      lan: result.lan ?? old?.lan ?? null, relays: result.relays?.length ? result.relays : old?.relays, paths,
      bleSecret: result.ble?.secret ?? old?.bleSecret ?? null,
    },
  ];
  await saveMacs();
  store.pairingNote = '';
  notify();
  applyRelays();
  await call('watch', { mac: result.mac, name: result.name, lan: result.lan, paths, bleSecret: result.ble?.secret ?? null });
  return result;
}

export async function forgetMac(mac: string) {
  await call('unwatch', { mac }).catch(() => { });
  store.macs = store.macs.filter((m) => m.mac !== mac);
  const { [mac]: _gone, ...rest } = store.status;
  store.status = rest;
  await saveMacs();
  notify();
}

// ---------- chat sui modelli del desktop ----------

export function chatOnMac(
  mac: string,
  model: string,
  messages: { role: string; content: string }[],
  ctx: number,
  onEvent: (e: ChatEvent) => void,
  phoneTools: unknown[] = [],
) {
  const chatId = newId('chat');
  const finished = new Promise<void>((resolve) => {
    chatHandlers.set(chatId, (e) => {
      onEvent(e);
      if (e.kind === 'done' || e.kind === 'error') resolve();
    });
  });
  call('chat', { mac, chatId, model, messages, ctx, phoneTools }).catch((err) => {
    chatHandlers.get(chatId)?.({ kind: 'error', error: (err as Error).message });
    chatHandlers.delete(chatId);
  });
  return {
    finished,
    cancel: () => call('chatCancel', { mac, chatId }).catch(() => { }),
    // your answer when the desktop asks to use a connector tool
    confirm: (callId: string, approve: boolean) => call('chatConfirm', { mac, chatId, callId, approve }).catch(() => { }),
    // result of one of the phone's own connector tools, run here at the desktop's request
    phoneResult: (callId: string, r: { isError?: boolean; denied?: boolean; text: string }) =>
      call('chatPhoneResult', { mac, chatId, callId, ...r }).catch(() => { }),
  };
}

// ---------- file ----------

// uri: un file dentro l'app (i selettori di documenti e foto lo copiano nella cache)
export async function sendFileToMac(mac: string, uri: string, name: string, size: number) {
  const transferId = newId('file');
  store.transfers = { ...store.transfers, [transferId]: { id: transferId, mac, direction: 'out', name, sent: 0, total: size } };
  notify();
  try {
    const path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
    return await call<{ name: string; size: number }>('sendFile', { mac, path, name, transferId });
  } finally {
    const { [transferId]: _done, ...rest } = store.transfers;
    store.transfers = rest;
    notify();
  }
}

export async function refreshNat() {
  if (store.state.kind !== 'ready') return;
  try { store.nat = await call<NatInfo>('netInfo'); notify(); } catch { /* resta il valore precedente */ }
}

export function watchSystem(mac: string, on: boolean) {
  if (store.state.kind === 'ready') call('systemWatch', { mac, on }).catch(() => { });
}

export function loadReceived() {
  try {
    store.received = new Directory(Paths.document)
      .list()
      .filter((f): f is File => f instanceof File && !f.name.startsWith('.'))
      .map((f) => {
        const info = f.info();
        return { name: f.name, uri: f.uri, size: info.size ?? 0, at: info.modificationTime ?? 0 };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 20); // gli ultimi 20: gli altri restano nell'app File
  } catch {
    store.received = [];
  }
  notify();
}

export function deleteReceived(uri: string) {
  try { new File(uri).delete(); } catch { /* già sparito */ }
  loadReceived();
}

// ---------- messaggi ----------

let msgTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyPeers = new Set<string>();

function onMsgEvent(ev: any) {
  if (ev.type === 'progress') {
    store.msg.progress = { ...store.msg.progress, [ev.mid]: { done: ev.done, total: ev.total } };
    notify();
    return;
  }
  if (ev.type === 'invite') {
    store.msg.invite = { state: ev.state, reason: ev.reason, contact: ev.contact };
    refreshMessages();
    return;
  }
  if (ev.type === 'changed' || ev.type === 'contacts') {
    if (ev.peer) dirtyPeers.add(ev.peer);
    // many events in a row (e.g. a burst from the mailbox): one refresh
    if (!msgTimer) msgTimer = setTimeout(() => { msgTimer = null; refreshMessages(); }, 150);
  }
}

export async function refreshMessages() {
  if (store.state.kind !== 'ready') return;
  try {
    const r = await call<{ contacts: MsgContact[]; info: MsgInfo }>('msgList');
    store.msg.contacts = r.contacts;
    store.msg.info = r.info;
    store.msg.unread = r.contacts.reduce((n, c) => n + c.unread, 0);
    const peers = [...dirtyPeers].filter((p) => store.msg.histories[p]);
    dirtyPeers.clear();
    for (const peer of peers) await loadHistory(peer);
    notify();
  } catch { /* worker non pronto */ }
}

export async function loadHistory(peer: string) {
  const list = await call<ChatMsg[]>('msgHistory', { peer });
  store.msg.histories = { ...store.msg.histories, [peer]: list };
  // a finished transfer leaves no progress bar behind
  for (const m of list) if (store.msg.progress[m.id] && (m.status === 'delivered' || m.status === 'received')) delete store.msg.progress[m.id];
  notify();
  return list;
}

export const sendMessage = (peer: string, text: string) => call('msgSend', { peer, text });
export const sendMessageFile = (peer: string, uri: string, name: string, mime: string) => call('msgSendFile', { peer, path: uri, name, mime });
export const markRead = (peer: string) => call('msgRead', { peer }).then(refreshMessages, () => { });
export const deleteMessage = (peer: string, messageId: string) => call('msgDelete', { peer, messageId }).then(() => loadHistory(peer));
export const renameContact = (peer: string, name: string) => call('msgRename', { peer, name }).then(refreshMessages);
export const removeContact = (peer: string) => call('msgRemove', { peer }).then(refreshMessages);
export async function createContactInvite() {
  await startP2P();
  store.msg.invite = null;
  return call<{ code: string; uri: string; expiresAt: number }>('msgInvite');
}
export const cancelContactInvite = () => call('msgCancelInvite').catch(() => { });
export async function acceptContactCode(code: string) {
  await startP2P();
  return call<{ key: string; name: string; via: string; added: boolean }>('msgAcceptInvite', { code });
}
export function applyMessageOptions() {
  if (store.state.kind === 'ready') call('msgOptions', { options: { nostrMailbox: getSettings().msgNostrMailbox } }).catch(() => { });
}
// QR di un contatto: qvacboard://contact?c=XXXX-XXXX-XXXX&n=Nome
export function parseContactUri(text: string) {
  const m = /^qvacboard:\/\/contact\?(.+)$/.exec(text.trim());
  if (!m) return null;
  const params = Object.fromEntries(m[1].split('&').map((kv) => kv.split('=').map(decodeURIComponent)));
  const plain = String(params.c ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return plain.length === 12 ? { code: String(params.c), name: String(params.n ?? '') } : null;
}
// file:// per mostrare una foto ricevuta o inviata
export const fileUri = (path: string) => (path.startsWith('file://') ? path : 'file://' + encodeURI(path));

export function refreshP2P() {
  if (store.state.kind === 'ready') call('refresh').then(refreshMessages, () => { });
}

// Re-renders the component whenever the P2P state changes
export function useP2P() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return store;
}
