// Impostazioni → Connettori AI: the iPhone's own remote MCP servers.
// Each row opens the connector's guide; adding one (by hand, from a QR code with
// the service URL, or by pasting a config) opens its guide right away.
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { addConnector, addFromJson, useConnectors } from './connectors';
import { Scanner } from './Devices';
import { tap } from './settings';
import { C } from './theme';

// A name proposed from the service address: orari-bus.example.app → orari-bus
function nameFromUrl(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const first = host.split('.')[0] || 'servizio';
    return first.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  } catch {
    return '';
  }
}

export default function ConnectorsSection({ onOpen }: { onOpen: (name: string) => void }) {
  const connectors = useConnectors();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  // The QR code holds just the MCP service URL: fill the fields, you check and add
  const onScan = (data: string) => {
    setScanning(false);
    const text = data.trim();
    if (!/^https?:\/\/\S+$/i.test(text)) {
      Alert.alert('QR non valido', 'Questo QR non contiene l’indirizzo di un servizio MCP (https://…).');
      return;
    }
    tap('success');
    setUrl(text);
    if (!name.trim()) setName(nameFromUrl(text));
  };

  const add = async () => {
    setBusy(true);
    try {
      const st = await addConnector({ name, url, token });
      tap(st?.state === 'connected' ? 'success' : 'warning');
      const added = name.trim();
      setName(''); setUrl(''); setToken('');
      onOpen(added); // its guide: every tool it offers
    } catch (err) {
      Alert.alert('Non aggiunto', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addPasted = async () => {
    setBusy(true);
    try {
      const names = await addFromJson(paste);
      tap('success');
      setPaste('');
      if (names.length === 1) onOpen(names[0]);
    } catch (err) {
      Alert.alert('Non aggiunto', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={styles.about}>
        Servizi remoti che l’iPhone usa direttamente, senza passare dal server. In chat con un modello del server li può
        usare anche lui (li esegue sempre l’iPhone); con il modello dell’iPhone funzionano anche a server spento, ma solo
        per richieste semplici.
      </Text>

      {connectors.map((c) => (
        <Pressable key={c.name} style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => onOpen(c.name)}>
          <Text style={styles.icon}>🌐</Text>
          <View style={styles.flex}>
            <Text style={styles.name}>{c.name}{c.hasToken ? '  🔑' : ''}</Text>
            <Text style={[styles.note, c.status.state === 'connected' && styles.on, c.status.state === 'error' && styles.err]} numberOfLines={1}>
              {c.status.state === 'connected' ? `collegato · ${c.status.tools.length} strumenti`
                : c.status.state === 'connecting' ? 'collegamento…'
                  : c.status.state === 'off' ? 'spento'
                    : `errore: ${c.status.error}`}
            </Text>
          </View>
          {c.status.state === 'connecting' ? <ActivityIndicator color={C.accent} /> : <Text style={styles.chevron}>Guida ›</Text>}
        </Pressable>
      ))}
      {!connectors.length && <Text style={styles.empty}>Nessun connettore. Aggiungine uno qui sotto.</Text>}

      <View style={styles.form}>
        <View style={styles.formHead}>
          <Text style={styles.label}>Aggiungi un connettore remoto</Text>
          <Pressable style={styles.scanBtn} onPress={() => { tap(); setScanning(true); }}>
            <Text style={styles.scanText}>Scansiona QR</Text>
          </Pressable>
        </View>
        <TextInput style={styles.input} value={url} onChangeText={(v) => { setUrl(v); if (!name.trim()) setName(nameFromUrl(v.trim())); }} placeholder="https://servizio.esempio/mcp" placeholderTextColor="#6f7f79" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Nome (es. meteo)" placeholderTextColor="#6f7f79" autoCapitalize="none" autoCorrect={false} />
        <TextInput style={styles.input} value={token} onChangeText={setToken} placeholder="Token di accesso (se serve)" placeholderTextColor="#6f7f79" autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Pressable style={[styles.addBtn, (busy || !name.trim() || !url.trim()) && styles.dim]} disabled={busy || !name.trim() || !url.trim()} onPress={add}>
          {busy ? <ActivityIndicator color="#06221a" /> : <Text style={styles.addText}>Aggiungi</Text>}
        </Pressable>
        <Text style={styles.note}>Il token resta nel portachiavi di questo dispositivo. I connettori locali (comandi) si aggiungono sul server.</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Oppure incolla una configurazione</Text>
        <TextInput
          style={[styles.input, styles.code]}
          value={paste}
          onChangeText={setPaste}
          placeholder={'{ "mcpServers": { "nome": { "url": "https://…" } } }'}
          placeholderTextColor="#6f7f79"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Pressable style={[styles.addBtn, (busy || !paste.trim()) && styles.dim]} disabled={busy || !paste.trim()} onPress={addPasted}>
          {busy ? <ActivityIndicator color="#06221a" /> : <Text style={styles.addText}>Aggiungi dalla configurazione</Text>}
        </Pressable>
      </View>

      <Scanner visible={scanning} onClose={() => setScanning(false)} onCode={onScan} hint="Inquadra il QR code con l’indirizzo del servizio MCP" />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  about: { color: C.muted, fontSize: 13, lineHeight: 19, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  pressed: { opacity: 0.6 },
  icon: { fontSize: 20 },
  name: { color: C.text, fontSize: 15, fontWeight: '600' },
  note: { color: C.muted, fontSize: 12, marginTop: 2 },
  on: { color: C.accent },
  err: { color: C.danger },
  dim: { opacity: 0.5 },
  chevron: { color: C.accent, fontSize: 13, fontWeight: '600' },
  empty: { color: C.muted, fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  form: { paddingVertical: 12, gap: 8 },
  formHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: C.muted, fontSize: 12 },
  scanBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.accent },
  scanText: { color: C.accent, fontWeight: '600', fontSize: 13 },
  input: { color: C.text, fontSize: 14, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  code: { fontFamily: 'Menlo', fontSize: 12, minHeight: 90, textAlignVertical: 'top' },
  addBtn: { height: 42, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#06221a', fontWeight: '700', fontSize: 15 },
});
