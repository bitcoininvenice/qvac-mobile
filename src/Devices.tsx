// "Dispositivi": this iPhone, the paired Macs (online/offline) and QR pairing.
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import {
  PATHS, codeKind, deleteReceived, forgetMac, joinNetwork, leaveNetwork, macLabel, pairFromQr, pairWithCode, pathLabel, parsePairingUri, renameMac, sendFileToMac, useP2P,
  type Mac, type MacStatus, type ReceivedFile, type Transfer,
} from './p2p';

const formatSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export async function pickAndSend(mac: Mac, kind: 'file' | 'photo') {
  let asset: { uri: string; name: string; size: number } | null = null;
  if (kind === 'file') {
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (r.canceled || !r.assets?.length) return;
    const a = r.assets[0];
    asset = { uri: a.uri, name: a.name, size: a.size ?? 0 };
  } else {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 1, allowsMultipleSelection: false });
    if (r.canceled || !r.assets?.length) return;
    const a = r.assets[0];
    asset = { uri: a.uri, name: a.fileName || a.uri.split('/').pop() || 'foto.jpg', size: a.fileSize ?? 0 };
  }
  try {
    const res = await sendFileToMac(mac.mac, asset.uri, asset.name, asset.size);
    tap('success');
    Alert.alert('Inviato', `“${res.name}” è sul server, in Download → QVAC-BOARD.`);
  } catch (err) {
    Alert.alert('Invio non riuscito', (err as Error).message);
  }
}
import { C } from './theme';
import { askText, shareFile } from './prompt';
import { tap } from './settings';

export default function Devices() {
  const p2p = useP2P();
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState<string | null>(null);

  // Join a mesh network (from its code or its QR)
  const join = async (code: string) => {
    try {
      const id = await joinNetwork(code);
      tap('success');
      Alert.alert('Sei nella rete mesh', `Rete ${id}: i server della rete vengono trovati da soli e compaiono qui sotto. Da qualsiasi rete; se serve, via Nostr (fino a 20 s).`);
    } catch (err) {
      Alert.alert('Non sei entrato nella rete', (err as Error).message);
    }
  };

  const onCode = async (data: string) => {
    setScanning(false);
    const mesh = /^qvacboard:\/\/mesh\?c=([0-9A-Za-z-]+)$/.exec(data.trim());
    if (mesh) return join(mesh[1]);
    const info = parsePairingUri(data);
    if (!info) {
      Alert.alert('QR non valido', 'Questo non è un QR code di QVAC-BOARD. Su QVAC-BOARD server apri Dispositivi → Collega telefono.');
      return;
    }
    setPairing(info.name);
    try {
      const mac = await pairFromQr(data);
      tap('success');
      Alert.alert('Collegato', `“${mac.name}” è abbinato${mac.path === 'mesh' ? ' tramite la rete mesh' : mac.path === 'lan' ? ' sulla rete di casa' : mac.path === 'nostr' ? ' tramite i relay Nostr' : ''}.${info.network ? ' Sei anche nella sua rete mesh: i server che ci aggiungerai compariranno da soli.' : ''} Da ora l’iPhone lo ritrova da solo, da qualsiasi rete.`);
    } catch (err) {
      Alert.alert('Abbinamento non riuscito', (err as Error).message);
    } finally {
      setPairing(null);
    }
  };

  // "Collega un server": scan its QR, or type the invite code shown under it
  const chooseHow = () =>
    Alert.alert('Collega un server', 'Su QVAC-BOARD server apri Dispositivi → Collega telefono: compaiono un QR e un codice.', [
      { text: 'Scansiona QR', onPress: () => setScanning(true) },
      { text: 'Inserisci codice', onPress: askCode },
      { text: 'Annulla', style: 'cancel' },
    ]);

  const askCode = () =>
    askText('Codice', 'Il codice d’invito mostrato sotto il QR (12 caratteri, vale 5 minuti) oppure il codice della tua rete mesh (16 caratteri).').then(async (text) => {
      if (!text?.trim()) return;
      const kind = codeKind(text);
      if (!kind) return Alert.alert('Codice non valido', 'Un invito ha 12 caratteri (XXXX-XXXX-XXXX), una rete mesh 16 (XXXX-XXXX-XXXX-XXXX).');
      if (kind === 'network') return join(text);
      setPairing('server');
      try {
        const mac = await pairWithCode(text);
        Alert.alert('Collegato', `“${mac.name}” è abbinato${mac.path === 'nostr' ? ' tramite i relay Nostr' : mac.path === 'p2p' ? ' via Holepunch' : ''}. Da ora l’iPhone lo ritrova da solo, da qualsiasi rete.`);
      } catch (err) {
        Alert.alert('Abbinamento non riuscito', (err as Error).message);
      } finally {
        setPairing(null);
      }
    });

  const confirmForget = (m: Mac) =>
    Alert.alert('Dimenticare questo server?', `“${macLabel(m)}” sparirà dalla lista. Per ricollegarlo servirà un nuovo QR.`, [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Dimentica', style: 'destructive', onPress: () => forgetMac(m.mac) },
    ]);

  const state = p2p.state;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>questo dispositivo</Text>
        {state.kind === 'starting' && (
          <View style={styles.row}><ActivityIndicator color={C.accent} /><Text style={styles.muted}>Avvio del P2P (Holepunch)…</Text></View>
        )}
        {state.kind === 'error' && <Text style={styles.error}>P2P non disponibile: {state.message}</Text>}
        {state.kind === 'ready' && (
          <Text style={styles.muted}>
            P2P attivo · chiave {state.publicKey.slice(0, 8)}…{state.publicKey.slice(-4)}
          </Text>
        )}
      </View>

      <Text style={styles.section}>I tuoi server</Text>
      {!p2p.macs.length && (
        <Text style={[styles.muted, styles.empty]}>
          Nessun server abbinato. Su QVAC-BOARD server apri Dispositivi → Collega telefono, poi inquadra il QR.
        </Text>
      )}
      {p2p.macs.map((m) => (
        <MacRow
          key={m.mac}
          mac={m}
          status={p2p.status[m.mac]}
          transfers={Object.values(p2p.transfers).filter((t) => t.mac === m.mac)}
          onForget={() => confirmForget(m)}
        />
      ))}

      <Pressable
        style={[styles.button, (state.kind !== 'ready' || !!pairing) && styles.dim]}
        disabled={state.kind !== 'ready' || !!pairing}
        onPress={chooseHow}
      >
        {pairing
          ? <View style={styles.row}><ActivityIndicator color="#06221a" /><Text style={styles.buttonText}>Collego “{pairing}”…</Text></View>
          : <Text style={styles.buttonText}>Collega un server</Text>}
      </Pressable>
      {!!pairing && !!p2p.pairingNote && <Text style={[styles.muted, styles.note]}>{p2p.pairingNote}</Text>}
      <Text style={[styles.muted, styles.note]}>
        Il collegamento è diretto e cifrato, senza server in mezzo: funziona sulla stessa rete e anche fuori casa.
      </Text>

      {p2p.networks.length > 0 && (
        <>
          <Text style={styles.section}>Reti mesh</Text>
          {p2p.networks.map((n) => (
            <View key={n.code} style={styles.macRow}>
              <Text style={styles.macIcon}>🕸</Text>
              <View style={styles.flex}>
                <Text style={styles.macName}>Rete {n.id}</Text>
                <Text style={styles.muted}>
                  {n.desktops.length ? `${n.desktops.length} ${n.desktops.length === 1 ? 'server' : 'server'} trovati` : 'cerco i server della rete…'}
                </Text>
              </View>
              <Pressable
                hitSlop={10}
                onPress={() => Alert.alert('Uscire dalla rete?', 'I server già trovati restano abbinati; i nuovi non verranno più trovati.', [
                  { text: 'Annulla', style: 'cancel' },
                  { text: 'Esci', style: 'destructive', onPress: () => leaveNetwork(n.code) },
                ])}
              >
                <Text style={styles.forget}>×</Text>
              </Pressable>
            </View>
          ))}
          {!!p2p.meshNote && <Text style={[styles.muted, styles.note]}>{p2p.meshNote}</Text>}
        </>
      )}

      <Text style={styles.section}>File ricevuti <Text style={styles.muted}>· ultimi 20</Text></Text>
      {!p2p.received.length && (
        <Text style={[styles.muted, styles.empty]}>
          Nessun file. Da QVAC-BOARD server: Dispositivi → Invia file. Li trovi anche nell’app File → Sul mio iPhone → QVAC-BOARD.
        </Text>
      )}
      {p2p.received.map((f) => <ReceivedRow key={f.uri} file={f} />)}

      <Scanner visible={scanning} onClose={() => setScanning(false)} onCode={onCode} />
    </ScrollView>
  );
}

// Tap on the status line: how this server is reached, and what that means for privacy
function showPathDetails(mac: Mac, status?: MacStatus) {
  if (!status?.online || !status.via) {
    Alert.alert(macLabel(mac), 'Non collegato. L’iPhone prova in ordine: 🏠 Rete locale → 🔵 Bluetooth → ⚡ Holepunch → 📡 Nostr, e usa la prima che funziona.');
    return;
  }
  const p = PATHS[status.via];
  const since = status.since ? new Date(status.since).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '–';
  const better = status.via === 'lan' ? 'È già il metodo migliore.' : 'Ogni 20 s cerca un metodo migliore e ci passa da solo (mai a metà di una risposta o di un file).';
  Alert.alert(
    `${p.icon} ${p.label}`,
    `${macLabel(mac)}\nLatenza: ${status.rtt != null ? `${status.rtt} ms` : '–'} · collegato dalle ${since}\n\n${p.privacy}\n\n${better}`,
  );
}

function MacRow({ mac, status, transfers, onForget }: { mac: Mac; status?: MacStatus; transfers: Transfer[]; onForget: () => void }) {
  const online = status?.online;
  const busy = transfers.some((t) => t.direction === 'out');
  const path = pathLabel(status?.via);
  const detail = online
    ? `${path}${status?.rtt != null ? ` · ${status.rtt} ms` : ''}`
    : status?.revoked
      ? 'revocato dal server: inquadra un nuovo QR'
      : status?.step
        ? `offline · provo ${pathLabel(status.step)}…`
        : `offline · ${status?.nextTry && status.nextTry > Date.now() ? `riprovo tra ${Math.ceil((status.nextTry - Date.now()) / 1000)} s` : 'lo cerco…'}${status?.error ? ` (${status.error})` : ''}`;
  return (
    <View style={styles.macRow}>
      <Text style={styles.macIcon}>💻</Text>
      <View style={styles.flex}>
        <Pressable
          onPress={() => askText('Nome del server', 'Come vuoi chiamarlo su questo dispositivo? Vuoto = il nome che si dà il server.', macLabel(mac)).then((text) => { if (text !== null) renameMac(mac.mac, text); })}
          accessibilityLabel={`Rinomina ${macLabel(mac)}`}
          accessibilityHint="Tocca per cambiare il nome"
        >
          <Text style={styles.macName} numberOfLines={1}>{macLabel(mac)} <Text style={styles.editHint}>✎</Text></Text>
        </Pressable>
        <Pressable style={styles.row} onPress={() => showPathDetails(mac, status)} accessibilityHint="Tocca per i dettagli del collegamento">
          <View style={[styles.dot, online ? styles.dotOn : styles.dotOff]} />
          <Text style={[styles.muted, online && styles.on]}>{online ? 'online' : ''}{online ? ' · ' : ''}{detail}</Text>
        </Pressable>
      </View>
      <Pressable onPress={onForget} hitSlop={12} accessibilityLabel={`Dimentica ${macLabel(mac)}`}>
        <Text style={styles.forget}>×</Text>
      </Pressable>
      {online && (
        <View style={styles.actions}>
          <Pressable style={[styles.small, busy && styles.dim]} disabled={busy} onPress={() => pickAndSend(mac, 'file')}>
            <Text style={styles.smallText}>Invia file</Text>
          </Pressable>
          <Pressable style={[styles.small, busy && styles.dim]} disabled={busy} onPress={() => pickAndSend(mac, 'photo')}>
            <Text style={styles.smallText}>Invia foto</Text>
          </Pressable>
        </View>
      )}
      {transfers.map((t) => (
        <View key={t.id} style={styles.transfer}>
          <Text style={styles.muted} numberOfLines={1}>
            {t.direction === 'out' ? '↑' : '↓'} {t.name} · {formatSize(t.sent)} di {formatSize(t.total)}
          </Text>
          <View style={styles.bar}><View style={[styles.barFill, { width: `${t.total ? Math.min(100, (t.sent / t.total) * 100) : 0}%` }]} /></View>
        </View>
      ))}
    </View>
  );
}

function ReceivedRow({ file }: { file: ReceivedFile }) {
  const remove = () =>
    Alert.alert('Eliminare il file?', `“${file.name}” verrà cancellato da questo dispositivo.`, [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Elimina', style: 'destructive', onPress: () => deleteReceived(file.uri) },
    ]);
  return (
    <View style={styles.macRow}>
      <Text style={styles.macIcon}>{/\.(png|jpe?g|heic|gif|webp)$/i.test(file.name) ? '🖼' : '📄'}</Text>
      <View style={styles.flex}>
        <Text style={styles.macName} numberOfLines={1}>{file.name}</Text>
        <Text style={styles.muted}>{formatSize(file.size)}</Text>
      </View>
      <Pressable style={styles.small} onPress={() => shareFile(file.uri).catch((err) => Alert.alert('Apri', (err as Error).message))}>
        <Text style={styles.smallText}>Apri</Text>
      </Pressable>
      <Pressable onPress={remove} hitSlop={12} accessibilityLabel={`Elimina ${file.name}`}>
        <Text style={styles.forget}>×</Text>
      </Pressable>
    </View>
  );
}

export function Scanner({ visible, onClose, onCode, hint = 'Inquadra il QR code mostrato da QVAC-BOARD server' }: { visible: boolean; onClose: () => void; onCode: (data: string) => void; hint?: string }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => { handled.current = false; }}>
      <View style={styles.scanner}>
        {!permission ? (
          <ActivityIndicator color={C.accent} />
        ) : !permission.granted ? (
          <View style={styles.permission}>
            <Text style={styles.scannerText}>Serve la fotocamera per leggere il QR code del server.</Text>
            <Pressable style={styles.button} onPress={requestPermission}>
              <Text style={styles.buttonText}>Consenti la fotocamera</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (handled.current) return; // the callback fires many times per second
                handled.current = true;
                onCode(data);
              }}
            />
            <View style={styles.frame} pointerEvents="none" />
            <Text style={styles.scanHint}>{hint}</Text>
          </>
        )}
        <Pressable style={styles.close} onPress={onClose} hitSlop={12}>
          <Text style={styles.closeText}>Annulla</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 12 },
  card: { padding: 14, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, gap: 6 },
  cardTitle: { color: C.text, fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { color: C.muted, fontSize: 13 },
  error: { color: C.danger, fontSize: 13 },
  on: { color: C.accent },
  section: { color: C.text, fontWeight: '700', fontSize: 15, marginTop: 8 },
  empty: { textAlign: 'center', paddingVertical: 20, lineHeight: 19 },
  macRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12,
    backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border,
  },
  macIcon: { fontSize: 22 },
  macName: { color: C.text, fontWeight: '600', fontSize: 15, marginBottom: 2 },
  editHint: { color: C.muted, fontSize: 13, fontWeight: '400' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: C.accent },
  dotOff: { backgroundColor: C.muted },
  forget: { color: C.muted, fontSize: 22, paddingHorizontal: 6 },
  actions: { flexBasis: '100%', flexDirection: 'row', gap: 8, marginLeft: 34 },
  small: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: C.accent },
  smallText: { color: C.accent, fontWeight: '600', fontSize: 13 },
  transfer: { flexBasis: '100%', gap: 4, marginLeft: 34 },
  bar: { height: 4, borderRadius: 2, backgroundColor: C.bg, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: C.accent },
  button: { height: 48, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 18 },
  buttonText: { color: '#06221a', fontWeight: '700', fontSize: 15 },
  dim: { opacity: 0.5 },
  note: { textAlign: 'center', lineHeight: 18 },
  scanner: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  permission: { padding: 24, gap: 16, alignItems: 'stretch' },
  scannerText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  frame: { width: 240, height: 240, borderRadius: 20, borderWidth: 3, borderColor: C.accent },
  scanHint: { position: 'absolute', bottom: 140, left: 24, right: 24, color: '#fff', textAlign: 'center', fontSize: 15, fontWeight: '600' },
  close: { position: 'absolute', bottom: 60, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.15)' },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
