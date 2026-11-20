// "Messaggi": testo, emoji, foto e file tra i tuoi dispositivi e con altre persone.
// Cifrati end-to-end (Double Ratchet, vedi p2p-worker/msg-core.js): server e relay vedono
// solo buste cifrate. La via la sceglie il P2P da solo (diretta, server postino, casella Nostr).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, Keyboard, LayoutAnimation, Modal, Platform, Pressable, ScrollView, Share,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import Svg, { Rect } from 'react-native-svg';
import { toQR } from 'toqr';
import {
  PATHS, acceptContactCode, cancelContactInvite, createContactInvite, deleteMessage, fileUri, loadHistory, markRead,
  parseContactUri, removeContact, renameContact, sendMessage, sendMessageFile, useP2P, type ChatMsg, type MsgContact, type PathKind,
} from './p2p';
import { Scanner } from './Devices';
import { tap } from './settings';
import { C } from './theme';
import { askText, shareFile } from './prompt';

const MAX_FILE = 25 * 1024 * 1024;
const formatSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const time = (ts: number) => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
};
const icon = (c: Pick<MsgContact, 'kind'>) => (c.kind === 'desktop' ? '💻' : '📱');
const viaLabel = (via: string | null) => (via && via in PATHS ? `${PATHS[via as PathKind].icon} ${PATHS[via as PathKind].short}` : via === 'direct' ? '⚡ Diretto' : '');

export default function Messages() {
  const p2p = useP2P();
  const [peer, setPeer] = useState<string | null>(null);
  const contact = p2p.msg.contacts.find((c) => c.key === peer);
  if (peer && contact) return <Conversation contact={contact} onBack={() => setPeer(null)} />;
  return <ContactList onOpen={(k) => { tap(); setPeer(k); }} />;
}

// ---------- elenco ----------

function ContactList({ onOpen }: { onOpen: (key: string) => void }) {
  const p2p = useP2P();
  const [inviting, setInviting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [joining, setJoining] = useState(false);
  const mine = p2p.msg.contacts.filter((c) => c.group === 'mine');
  const people = p2p.msg.contacts.filter((c) => c.group === 'person');

  const accept = async (code: string) => {
    setJoining(true);
    try {
      const c = await acceptContactCode(code);
      tap('success');
      Alert.alert('Contatto aggiunto', `Ora puoi scrivere a “${c.name}”. I messaggi sono cifrati end-to-end.`);
    } catch (err) {
      Alert.alert('Contatto non aggiunto', (err as Error).message);
    } finally {
      setJoining(false);
    }
  };

  const add = () => Alert.alert('Aggiungi un contatto', 'Una persona con QVAC-BOARD ti mostra il suo QR o il suo codice, oppure tu mostri il tuo. Il codice vale 10 minuti e una volta sola.', [
    { text: 'Mostra il mio codice', onPress: () => setInviting(true) },
    { text: 'Scansiona QR', onPress: () => setScanning(true) },
    { text: 'Inserisci codice', onPress: () => askText('Codice contatto', '12 caratteri, es. ABCD-EFGH-JKMN').then((t) => { if (t) accept(t); }) },
    { text: 'Annulla', style: 'cancel' },
  ]);

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.page}>
        <Pressable style={({ pressed }) => [styles.addButton, pressed && styles.pressed]} onPress={add} disabled={joining}>
          {joining ? <ActivityIndicator color="#06221a" /> : <Text style={styles.addText}>＋ Aggiungi contatto</Text>}
        </Pressable>
        <Text style={styles.lock}>🔒 Cifrati end-to-end: nemmeno il server o i relay possono leggerli.</Text>
        {!!mine.length && <Text style={styles.section}>I tuoi dispositivi</Text>}
        {mine.map((c) => <ContactRow key={c.key} c={c} onPress={() => onOpen(c.key)} />)}
        <Text style={styles.section}>Contatti</Text>
        {people.map((c) => <ContactRow key={c.key} c={c} onPress={() => onOpen(c.key)} />)}
        {!people.length && (
          <Text style={[styles.muted, styles.empty]}>
            Nessun contatto. Per scrivere a un’altra persona tocca “Aggiungi contatto”: uno dei due mostra il codice, l’altro lo inquadra o lo digita.
          </Text>
        )}
        {!p2p.msg.contacts.length && (
          <Text style={[styles.muted, styles.empty]}>Abbina un server in Dispositivi: comparirà qui con gli altri tuoi dispositivi.</Text>
        )}
        <Text style={[styles.muted, styles.note]}>
          Su iPhone i messaggi arrivano quando l’app è aperta (niente notifiche push di Apple, per la privacy). Il server li tiene per te, cifrati, finché non ti ricolleghi.
        </Text>
      </ScrollView>
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
      <Scanner
        visible={scanning}
        hint="Inquadra il QR del contatto (QVAC-BOARD → Messaggi → Mostra il mio codice)"
        onClose={() => setScanning(false)}
        onCode={(data) => {
          setScanning(false);
          const info = parseContactUri(data);
          if (!info) return Alert.alert('QR non valido', 'Questo non è il QR di un contatto QVAC-BOARD.');
          accept(info.code);
        }}
      />
    </View>
  );
}

function ContactRow({ c, onPress }: { c: MsgContact; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.contact, pressed && styles.pressed]}>
      <View>
        <Text style={styles.avatar}>{icon(c)}</Text>
        <View style={[styles.dot, c.online ? styles.dotOn : styles.dotOff]} />
      </View>
      <View style={styles.flex}>
        <View style={styles.rowBetween}>
          <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
          {c.last && <Text style={styles.time}>{time(c.last.ts)}</Text>}
        </View>
        <View style={styles.rowBetween}>
          <Text style={[styles.muted, styles.flex]} numberOfLines={1}>
            {c.last ? `${c.last.dir === 'out' ? 'Tu: ' : ''}${c.last.text}` : c.online ? `Online · ${viaLabel(c.via)}` : 'Nessun messaggio'}
          </Text>
          {c.unread > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{c.unread}</Text></View>}
        </View>
      </View>
    </Pressable>
  );
}

// QR + codice: l'altra persona lo inquadra o lo digita (10 minuti, una volta sola)
function InviteModal({ onClose }: { onClose: () => void }) {
  const p2p = useP2P();
  const [invite, setInvite] = useState<{ code: string; uri: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    createContactInvite().then(setInvite, (err) => setError((err as Error).message));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const done = p2p.msg.invite?.state === 'done' ? p2p.msg.invite.contact : null;
  useEffect(() => {
    if (!done) return;
    tap('success');
    Alert.alert('Contatto aggiunto', `“${done.name}” è nei tuoi contatti.`);
    onClose();
  }, [done]);
  const close = () => { cancelContactInvite(); onClose(); };
  const left = invite ? Math.max(0, Math.round((invite.expiresAt - now) / 1000)) : 0;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.modal}>
        <Text style={styles.modalTitle}>Il mio codice contatto</Text>
        <Text style={[styles.muted, styles.center]}>Fallo inquadrare (o digitare) dall’altra persona in QVAC-BOARD → Messaggi → Aggiungi contatto.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : !invite ? <ActivityIndicator color={C.accent} /> : (
          <>
            <View style={styles.qrBox}><Qr text={invite.uri} size={240} /></View>
            <Text style={styles.code} selectable>{invite.code}</Text>
            <Text style={styles.muted}>{left > 0 ? `Valido ancora ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · una volta sola` : 'Scaduto: chiudi e creane un altro'}</Text>
            <View style={styles.row}><ActivityIndicator color={C.accent} size="small" /><Text style={styles.muted}>In attesa dell’altra persona…</Text></View>
            <Pressable onPress={() => Share.share({ message: `Il mio codice contatto QVAC-BOARD: ${invite.code} (vale 10 minuti)` })}>
              <Text style={styles.link}>Condividi il codice</Text>
            </Pressable>
          </>
        )}
        <Pressable style={styles.closeButton} onPress={close}><Text style={styles.closeText}>Chiudi</Text></Pressable>
      </View>
    </Modal>
  );
}

function Qr({ text, size }: { text: string; size: number }) {
  const cells = useMemo(() => toQR(text), [text]);
  const n = Math.round(Math.sqrt(cells.length));
  const q = 2; // margine bianco
  const rects: React.ReactNode[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (cells[y * n + x]) rects.push(<Rect key={y * n + x} x={x + q} y={y + q} width={1.02} height={1.02} fill="#000" />);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${n + q * 2} ${n + q * 2}`}>
      <Rect x={0} y={0} width={n + q * 2} height={n + q * 2} fill="#fff" />
      {rects}
    </Svg>
  );
}

// ---------- conversazione ----------

function Conversation({ contact, onBack }: { contact: MsgContact; onBack: () => void }) {
  const p2p = useP2P();
  const list = p2p.msg.histories[contact.key] ?? [];
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMsg>>(null);
  const box = useRef<any>(null);
  const [keyboardPad, setKeyboardPad] = useState(0);

  useEffect(() => { loadHistory(contact.key).catch(() => { }); }, [contact.key]);
  // Letti: aprendo la conversazione e quando ne arrivano di nuovi mentre è aperta
  useEffect(() => { if (contact.unread) markRead(contact.key); }, [contact.unread, contact.key]);
  useEffect(() => { setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80); }, [list.length]);

  // Tastiera: stessa tecnica della Chat (la conversazione sta tra intestazione e barra delle schede)
  useEffect(() => {
    const animate = (duration?: number) => {
      if (duration) LayoutAnimation.configureNext(LayoutAnimation.create(duration, LayoutAnimation.Types.keyboard, LayoutAnimation.Properties.opacity));
    };
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', (e) => {
      box.current?.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        animate(e.duration);
        setKeyboardPad(Math.max(0, y + h - e.endCoordinates.screenY));
      });
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', (e) => { animate(e.duration); setKeyboardPad(0); });
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => { if (keyboardPad > 0) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50); }, [keyboardPad]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    try {
      await sendMessage(contact.key, text);
      tap();
    } catch (err) {
      setInput(text);
      Alert.alert('Non inviato', (err as Error).message);
    }
  };

  const attach = async (kind: 'photo' | 'camera' | 'file') => {
    let asset: { uri: string; name: string; size: number; mime: string } | null = null;
    try {
      if (kind === 'file') {
        const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
        if (r.canceled || !r.assets?.length) return;
        const a = r.assets[0];
        asset = { uri: a.uri, name: a.name, size: a.size ?? 0, mime: a.mimeType ?? '' };
      } else {
        if (kind === 'camera') {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) return Alert.alert('Fotocamera', 'Serve il permesso della fotocamera per scattare una foto.');
        }
        const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, allowsMultipleSelection: false };
        const r = kind === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
        if (r.canceled || !r.assets?.length) return;
        const a = r.assets[0];
        asset = { uri: a.uri, name: a.fileName || a.uri.split('/').pop() || 'foto.jpg', size: a.fileSize ?? 0, mime: a.mimeType ?? 'image/jpeg' };
      }
    } catch (err) {
      return Alert.alert('Allegato', (err as Error).message);
    }
    if (asset.size > MAX_FILE) return Alert.alert('File troppo grande', `Il massimo è ${MAX_FILE / 1024 / 1024} MB.`);
    setSending(true);
    try {
      await sendMessageFile(contact.key, asset.uri, asset.name, asset.mime);
      tap();
    } catch (err) {
      Alert.alert('Non inviato', (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const chooseAttach = () => Alert.alert('Allega', 'Foto e file viaggiano solo sulle vie veloci (rete locale, Bluetooth, Holepunch), massimo 25 MB.', [
    { text: 'Foto dalla galleria', onPress: () => attach('photo') },
    { text: 'Scatta una foto', onPress: () => attach('camera') },
    { text: 'File', onPress: () => attach('file') },
    { text: 'Annulla', style: 'cancel' },
  ]);

  const contactMenu = () => Alert.alert(contact.name, `🔒 Numero di sicurezza\n${contact.safety}\n\nConfrontatelo di persona o in chiamata: se è uguale sui due dispositivi, nessuno è in mezzo.`, [
    { text: 'Rinomina', onPress: () => askText('Nome del contatto', 'Vuoto = il nome che si dà il dispositivo.', contact.customName ?? contact.name).then((t) => { if (t !== null) renameContact(contact.key, t); }) },
    ...(contact.group === 'person' ? [{
      text: 'Elimina contatto', style: 'destructive' as const,
      onPress: () => Alert.alert('Eliminare il contatto?', 'Spariscono la conversazione e le sue chiavi. Per riscrivervi servirà un nuovo codice.', [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Elimina', style: 'destructive', onPress: () => { removeContact(contact.key); onBack(); } },
      ]),
    }] : []),
    { text: 'Chiudi', style: 'cancel' },
  ]);

  const status = contact.online
    ? `Online · ${viaLabel(contact.via)}`
    : contact.group === 'mine' ? 'Non raggiungibile ora: i messaggi partono appena possibile' : 'Non raggiungibile ora: casella Nostr o appena vi ritrovate';

  return (
    <View ref={box} style={[styles.flex, { paddingBottom: keyboardPad }]}>
      <View style={styles.convHeader}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={styles.back}>‹ Messaggi</Text></Pressable>
        <Pressable onPress={contactMenu} style={styles.convTitle}>
          <Text style={styles.name} numberOfLines={1}>{icon(contact)} {contact.name}</Text>
          <Text style={styles.small} numberOfLines={1}>{contact.secure ? '🔒 ' : '🔐 avvio cifratura… · '}{status}</Text>
        </Pressable>
      </View>
      <FlatList
        ref={listRef}
        data={list}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.messages}
        renderItem={({ item }) => <Bubble m={item} peer={contact.key} progress={p2p.msg.progress[item.id]} />}
        ListEmptyComponent={<Text style={[styles.muted, styles.empty]}>Scrivi il primo messaggio. Testo ed emoji 😀 vanno ovunque, foto e file sulle vie veloci.</Text>}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />
      <View style={styles.composer}>
        <Pressable onPress={chooseAttach} disabled={sending} hitSlop={8} style={styles.attach}>
          {sending ? <ActivityIndicator color={C.accent} size="small" /> : <Text style={styles.attachText}>＋</Text>}
        </Pressable>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Messaggio"
          placeholderTextColor={C.muted}
          multiline
          maxLength={8000}
        />
        <Pressable onPress={send} disabled={!input.trim()} style={[styles.send, !input.trim() && styles.dim]}>
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Bubble({ m, peer, progress }: { m: ChatMsg; peer: string; progress?: { done: number; total: number } }) {
  const out = m.dir === 'out';
  const ticks = out ? ({ queued: '🕓', sent: '✓', delivered: '✓✓', failed: '⚠️' } as Record<string, string>)[m.status] ?? '' : '';
  const isImage = m.t === 'file' && (m.file?.mime ?? '').startsWith('image/') && m.file?.path;
  const menu = () => Alert.alert('Messaggio', undefined, [
    ...(m.text ? [{ text: 'Condividi testo', onPress: () => Share.share({ message: m.text! }) }] : []),
    ...(m.file?.path ? [{ text: 'Condividi file', onPress: () => { shareFile(fileUri(m.file!.path!), m.file!.mime).catch((err) => Alert.alert('Condividi', (err as Error).message)); } }] : []),
    { text: 'Elimina da questo dispositivo', style: 'destructive' as const, onPress: () => deleteMessage(peer, m.id) },
    { text: 'Annulla', style: 'cancel' as const },
  ]);
  return (
    <Pressable onLongPress={menu} onPress={m.file?.path && !isImage ? menu : undefined} style={[styles.bubble, out ? styles.bubbleOut : styles.bubbleIn]}>
      {m.t === 'text' && <Text style={styles.text} selectable>{m.text}</Text>}
      {isImage && <Image source={{ uri: fileUri(m.file!.path!) }} style={styles.image} resizeMode="cover" />}
      {m.t === 'file' && !isImage && (
        <Text style={styles.text}>📎 {m.file?.name} <Text style={styles.small}>({formatSize(m.file?.size ?? 0)})</Text></Text>
      )}
      {m.status === 'downloading' && <Text style={styles.small}>{m.file?.mime?.startsWith('image/') ? '📷' : '📎'} {m.file?.name} · in arrivo, serve una via veloce…</Text>}
      {progress && progress.done < progress.total && (
        <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.round((progress.done / progress.total) * 100)}%` }]} /></View>
      )}
      {m.error && <Text style={styles.error}>{m.error}</Text>}
      <Text style={styles.meta}>{time(m.ts)} {ticks}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 10, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pressed: { opacity: 0.7 },
  dim: { opacity: 0.4 },
  muted: { color: C.muted, fontSize: 13 },
  small: { color: C.muted, fontSize: 12 },
  error: { color: C.danger, fontSize: 13 },
  empty: { textAlign: 'center', paddingVertical: 14, lineHeight: 19 },
  note: { textAlign: 'center', lineHeight: 18, marginTop: 12 },
  center: { textAlign: 'center' },
  lock: { color: C.muted, fontSize: 12, textAlign: 'center' },
  section: { color: C.text, fontWeight: '700', fontSize: 15, marginTop: 8 },
  addButton: { height: 46, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#06221a', fontWeight: '700', fontSize: 15 },
  contact: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  avatar: { fontSize: 26 },
  dot: { position: 'absolute', right: -2, bottom: 0, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: C.surface },
  dotOn: { backgroundColor: C.accent },
  dotOff: { backgroundColor: C.muted },
  name: { color: C.text, fontWeight: '600', fontSize: 15, flexShrink: 1 },
  time: { color: C.muted, fontSize: 12 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#06221a', fontWeight: '800', fontSize: 12 },
  modal: { flex: 1, backgroundColor: C.bg, padding: 24, gap: 14, alignItems: 'center', justifyContent: 'center' },
  modalTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  qrBox: { padding: 10, borderRadius: 16, backgroundColor: '#fff' },
  code: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  link: { color: C.accent, fontWeight: '600', fontSize: 15 },
  closeButton: { marginTop: 10, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 24, borderWidth: 1, borderColor: C.border },
  closeText: { color: C.text, fontWeight: '600', fontSize: 15 },
  convHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  back: { color: C.accent, fontSize: 16, fontWeight: '600' },
  convTitle: { flex: 1 },
  messages: { padding: 12, gap: 6, flexGrow: 1 },
  bubble: { maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, gap: 4 },
  bubbleOut: { alignSelf: 'flex-end', backgroundColor: C.accentSoft, borderBottomRightRadius: 4 },
  bubbleIn: { alignSelf: 'flex-start', backgroundColor: C.surface2, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: C.border },
  text: { color: C.text, fontSize: 16, lineHeight: 22 },
  image: { width: 220, height: 220, borderRadius: 10, backgroundColor: C.bg },
  meta: { color: C.muted, fontSize: 11, alignSelf: 'flex-end' },
  bar: { height: 4, borderRadius: 2, backgroundColor: C.bg, overflow: 'hidden', minWidth: 120 },
  barFill: { height: 4, backgroundColor: C.accent },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  attach: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  attachText: { color: C.accent, fontSize: 22, fontWeight: '600', marginTop: -2 },
  input: { flex: 1, minHeight: 38, maxHeight: 120, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 9, borderRadius: 19, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, color: C.text, fontSize: 16 },
  send: { width: 38, height: 38, borderRadius: 19, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#06221a', fontSize: 20, fontWeight: '800' },
});
