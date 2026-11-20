// Impostazioni: un elenco di contesti, ognuno con la sua pagina.
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as Speech from 'expo-speech';
import { LANGUAGES, phrases } from './voiceText';
import { askText } from './prompt';
import { PATHS, applyDeviceName, applyMessageOptions, applyPaths, applyRelays, deviceName, macLabel, nostrStatus, refreshNat, relaysInUse, useP2P, type RelayState } from './p2p';
import { LOCAL_MODEL, useLocal } from './local';
import { tap, updateSettings, useSettings } from './settings';
import ConnectorsSection from './ConnectorsSection';
import ConnectorGuide from './ConnectorGuide';
import { useConnectors } from './connectors';
import { C } from './theme';
import type { Go } from './Home';

const APP_VERSION = '0.5';

type Page = 'list' | 'chat' | 'home' | 'voice' | 'messages' | 'devices' | 'paths' | 'connectors' | 'info';

export default function Settings({ go, requested }: { go: Go; requested?: { page: string; n: number } | null }) {
  const [page, setPage] = useState<Page>('list');
  // Another screen asked to open a page directly (e.g. Parla → its settings)
  useEffect(() => { if (requested?.page) setPage(requested.page as Page); }, [requested?.n]);
  const [connector, setConnector] = useState<string | null>(null);
  const open = (p: Page) => { tap(); setPage(p); };

  if (connector) {
    return (
      <Subpage title={connector} back="Connettori AI" onBack={() => setConnector(null)}>
        <ConnectorGuide name={connector} onRemoved={() => setConnector(null)} />
      </Subpage>
    );
  }
  if (page === 'list') return <SettingsList open={open} />;
  const titles: Record<Exclude<Page, 'list'>, string> = {
    chat: 'Chat', home: 'Home', voice: 'Parla', messages: 'Messaggi', devices: 'Dispositivi', paths: 'Metodi di connessione', connectors: 'Connettori AI', info: 'Info dispositivo',
  };
  return (
    <Subpage title={titles[page]} back="Impostazioni" onBack={() => setPage('list')}>
      {page === 'chat' && <ChatPage />}
      {page === 'home' && <HomePage />}
      {page === 'voice' && <VoicePage />}
      {page === 'messages' && <MessagesPage />}
      {page === 'devices' && <DevicesPage go={go} />}
      {page === 'paths' && <PathsPage />}
      {page === 'connectors' && <ConnectorsSection onOpen={(name) => { tap(); setConnector(name); }} />}
      {page === 'info' && <InfoPage />}
    </Subpage>
  );
}

// The list of contexts, each with a one-line summary of its current state
function SettingsList({ open }: { open: (p: Page) => void }) {
  const s = useSettings();
  const p2p = useP2P();
  const loc = useLocal();
  const connectors = useConnectors();
  const defaultLabel = s.defaultModel === 'local' ? `Dispositivo mobile · ${LOCAL_MODEL.label}` : 'un modello del server';
  const onPaths = (Object.keys(PATHS) as (keyof typeof PATHS)[]).filter((k) => s.paths[k]).map((k) => PATHS[k].icon).join(' ');
  const items: { page: Page; icon: string; title: string; note: string }[] = [
    { page: 'chat', icon: '💬', title: 'Chat', note: `Predefinito: ${defaultLabel}${s.think ? ' · ragionamento' : ''}` },
    { page: 'home', icon: '🏠', title: 'Home', note: `${s.liveStats ? 'Dati dal vivo attivi' : 'Dati dal vivo spenti'} · vibrazione ${s.haptics ? 'sì' : 'no'}` },
    { page: 'voice', icon: '🎙️', title: 'Parla', note: `${s.agentName || 'Aura'} · ${LANGUAGES.find((l) => l.code === s.language)?.label ?? s.language} · ${s.voiceOnDevice ? 'riconoscimento sul dispositivo' : 'riconoscimento Apple'}` },
    { page: 'messages', icon: '✉️', title: 'Messaggi', note: `${p2p.msg.contacts.length} contatti · casella Nostr ${s.msgNostrMailbox ? 'attiva' : 'spenta'}` },
    { page: 'devices', icon: '💻', title: 'Dispositivi', note: `${p2p.macs.length} server abbinati` },
    { page: 'paths', icon: '🔗', title: 'Metodi di connessione', note: `Attivi: ${onPaths} · relay Nostr` },
    { page: 'connectors', icon: '🧩', title: 'Connettori AI', note: connectors.length ? `${connectors.length} connettori · ${connectors.filter((c) => c.status.state === 'connected').length} collegati` : 'Nessun connettore' },
    { page: 'info', icon: '📱', title: 'Info dispositivo', note: `${deviceName()} · modello ${loc.state.kind === 'ready' ? 'pronto' : loc.state.kind === 'deleted' ? 'eliminato' : '…'} · v${APP_VERSION}` },
  ];
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.card}>
        {items.map((it, i) => (
          <Pressable key={it.page} onPress={() => open(it.page)} style={({ pressed }) => [styles.listRow, i === items.length - 1 && styles.last, pressed && styles.pressed]}>
            <Text style={styles.listIcon}>{it.icon}</Text>
            <View style={styles.flex}>
              <Text style={styles.text}>{it.title}</Text>
              <Text style={styles.note} numberOfLines={1}>{it.note}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function Subpage({ title, back, onBack, children }: { title: string; back: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Pressable onPress={() => { tap(); onBack(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Indietro: ${back}`}>
        <Text style={styles.back}>‹ {back}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </ScrollView>
  );
}

function ChatPage() {
  const s = useSettings();
  const p2p = useP2P();
  // Modelli tra cui scegliere il predefinito: dispositivo mobile + quelli noti dei server (anche se ora offline)
  const options = [{ key: 'local', label: `Dispositivo mobile · ${LOCAL_MODEL.label}`, note: 'sempre disponibile, anche offline' }];
  for (const m of p2p.macs) {
    for (const model of p2p.status[m.mac]?.models ?? m.models ?? []) {
      options.push({ key: `${m.mac}|${model.id}`, label: `${macLabel(m)} · ${model.label.split(' — ')[0]}`, note: 'quando il server è raggiungibile' });
    }
  }
  return (
    <>
      <Text style={styles.label}>Modello predefinito</Text>
      {options.map((o) => (
        <Pressable key={o.key} style={styles.option} onPress={() => { tap(); updateSettings({ defaultModel: o.key }); }}>
          <View style={[styles.radio, s.defaultModel === o.key && styles.radioOn]} />
          <View style={styles.flex}>
            <Text style={styles.text}>{o.label}</Text>
            <Text style={styles.note}>{o.note}</Text>
          </View>
        </Pressable>
      ))}
      <Toggle label="Ragionamento attivo" note="Risposte più accurate ma più lente" value={s.think} onChange={(v) => updateSettings({ think: v })} />
      <Toggle
        label="Se il server non risponde, usa questo dispositivo"
        note={`Con un modello del server scelto: se il server è spento o irraggiungibile risponde ${LOCAL_MODEL.label}, poi si torna al server da soli`}
        value={s.fallbackLocal}
        onChange={(v) => updateSettings({ fallbackLocal: v })}
      />
    </>
  );
}

function HomePage() {
  const s = useSettings();
  return (
    <>
      <Toggle label="Dati dal vivo del server" note="CPU, GPU e RAM ogni 2 secondi, solo con la Home aperta" value={s.liveStats} onChange={(v) => updateSettings({ liveStats: v })} />
      <Toggle label="Vibrazione" note="Leggera, ai tocchi e quando arriva un file" value={s.haptics} onChange={(v) => updateSettings({ haptics: v })} />
    </>
  );
}

// Parla: the assistant's name and voice, and how the conversation behaves
function VoicePage() {
  const s = useSettings();
  const [voices, setVoices] = useState<Speech.Voice[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [name, setName] = useState(s.agentName || 'Aura');
  useEffect(() => { Speech.getAvailableVoicesAsync().then(setVoices, () => { }); return () => { Speech.stop(); }; }, []);
  const prefix = (s.language || 'it-IT').slice(0, 2).toLowerCase();
  const forLang = voices
    .filter((v) => v.language.toLowerCase().replace('_', '-').startsWith(prefix))
    .sort((a, b) => Number(b.quality === 'Enhanced') - Number(a.quality === 'Enhanced') || a.name.localeCompare(b.name));
  const listen = (id: string | undefined, key: string) => {
    tap();
    Speech.stop();
    setTesting(key);
    Speech.speak(phrases(s.language).sample(s.agentName || 'Aura'), {
      language: s.language, voice: id, rate: s.voiceSpeed || 1,
      onDone: () => setTesting(null), onStopped: () => setTesting(null), onError: () => setTesting(null),
    });
  };
  const chip = (active: boolean) => [styles.chip, active && styles.chipActive];
  return (
    <>
      <Section title="Assistente">
        <View style={styles.option}>
          <Text style={[styles.text, styles.flex]}>Nome</Text>
          <TextInput
            style={styles.inlineInput}
            value={name}
            onChangeText={setName}
            onEndEditing={() => updateSettings({ agentName: name.trim().slice(0, 24) || 'Aura' })}
            maxLength={24}
            placeholder="Aura"
            placeholderTextColor={C.muted}
            returnKeyType="done"
          />
        </View>
      </Section>
      <Section title="Lingua (parlato e ascolto)">
        <View style={styles.chips}>
          {LANGUAGES.map((l) => (
            <Pressable
              key={l.code}
              style={chip(s.language === l.code)}
              onPress={() => {
                tap();
                const match = voices.filter((v) => v.language.toLowerCase().replace('_', '-').startsWith(l.code.slice(0, 2).toLowerCase()));
                const best = match.find((v) => v.language.replace('_', '-') === l.code && v.quality === 'Enhanced') ?? match.find((v) => v.quality === 'Enhanced') ?? match[0];
                updateSettings({ language: l.code, voice: best?.name ?? '', voiceIdentifier: best?.identifier ?? '' });
              }}
            >
              <Text style={styles.chipText}>{l.flag} {l.label}</Text>
            </Pressable>
          ))}
        </View>
      </Section>
      <Section title="Voce">
        {!forLang.length && <Text style={styles.note}>Nessuna voce per questa lingua: si usa quella di sistema. Altre voci (anche di qualità migliorata) in Impostazioni di iOS → Accessibilità → Contenuto letto → Voci.</Text>}
        {forLang.map((v) => {
          const active = s.voiceIdentifier ? s.voiceIdentifier === v.identifier : s.voice === v.name;
          return (
            <View key={v.identifier} style={styles.option}>
              <Pressable style={styles.flex} onPress={() => { tap(); updateSettings({ voice: v.name, voiceIdentifier: v.identifier }); }}>
                <Text style={[styles.text, active && styles.activeText]}>{active ? '● ' : ''}{v.name}{v.quality === 'Enhanced' ? '  ✦ alta qualità' : ''}</Text>
                <Text style={styles.note}>{v.language}</Text>
              </Pressable>
              <Pressable onPress={() => listen(v.identifier, v.identifier)} hitSlop={8}>
                <Text style={styles.link}>{testing === v.identifier ? 'Ascolto…' : 'Ascolta'}</Text>
              </Pressable>
            </View>
          );
        })}
        <View style={styles.option}>
          <Text style={[styles.text, styles.flex]}>Velocità</Text>
          <View style={styles.chipsRow}>
            {[{ label: 'Lenta', v: 0.85 }, { label: 'Normale', v: 1 }, { label: 'Rapida', v: 1.15 }].map((o) => (
              <Pressable key={o.v} style={chip(Math.abs((s.voiceSpeed || 1) - o.v) < 0.01)} onPress={() => { tap(); updateSettings({ voiceSpeed: o.v }); }}>
                <Text style={styles.chipText}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Section>
      <Section title="Conversazione">
        <View style={styles.option}>
          <View style={styles.flex}>
            <Text style={styles.text}>Pausa prima di rispondere</Text>
            <Text style={styles.note}>Quanto silenzio aspetta per capire che hai finito</Text>
          </View>
          <View style={styles.chipsRow}>
            {([['short', 'Breve'], ['normal', 'Media'], ['long', 'Lunga']] as const).map(([k, label]) => (
              <Pressable key={k} style={chip(s.voicePause === k)} onPress={() => { tap(); updateSettings({ voicePause: k }); }}>
                <Text style={styles.chipText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Toggle
          label="Interrompi parlando"
          note="Il microfono resta acceso mentre l’assistente parla, con la cancellazione dell’eco: basta parlarle sopra (o dire “aspetta”). La voce può risultare un po’ più bassa."
          value={s.voiceBargeIn}
          onChange={(v) => updateSettings({ voiceBargeIn: v })}
        />
        <Toggle
          label="Riconoscimento sul dispositivo"
                    note={Platform.OS === 'android'
            ? 'Consigliato: la tua voce non esce dal telefono (serve la lingua offline di Google). Spento, Android può usare i server di Google.'
            : 'Consigliato: la tua voce non esce dall’iPhone. Spento, iOS può usare i server di Apple (serve la rete).'}
          value={s.voiceOnDevice}
          onChange={(v) => updateSettings({ voiceOnDevice: v })}
        />
      </Section>
      <Text style={styles.note}>
        Risponde il modello scelto in Impostazioni → Chat (server o dispositivo). Con un modello del server usa anche i connettori del server e di questo telefono; quelli impostati su “Chiedi” te li chiede a voce, rispondi “sì” o “no”.
      </Text>
    </>
  );
}

function MessagesPage() {
  const s = useSettings();
  const p2p = useP2P();
  const info = p2p.msg.info;
  return (
    <>
      <Section title="Consegna">
        <Toggle
          label="Casella Nostr"
          note="Quando né una via diretta né il server postino raggiungono il destinatario, il messaggio (solo testo) resta cifrato sui relay Nostr fino a 7 giorni, sotto un’etichetta che cambia ogni settimana e che conoscete solo voi due. Spenta: si aspetta che vi ritroviate o che il server sia acceso."
          value={s.msgNostrMailbox}
          onChange={(v) => { updateSettings({ msgNostrMailbox: v }).then(applyMessageOptions); }}
        />
        <Row label="Foto e file" value="fino a 25 MB, solo vie veloci" />
        <Row label="In uscita" value={info ? `${info.outbox} in attesa` : '…'} />
      </Section>
      <Section title="Sicurezza">
        <Text style={styles.note}>
          Cifratura end-to-end con Double Ratchet (lo stesso schema di Signal) su libsodium: ogni messaggio ha una chiave sua, cancellata dopo l’uso, quindi i messaggi passati restano illeggibili anche se un giorno qualcuno ruba le chiavi del telefono. Server e relay vedono solo buste cifrate. Ogni conversazione ha un numero di sicurezza: aprila e tocca il nome per confrontarlo.
        </Text>
        <Row label="Identità di questo dispositivo" value={info ? `${info.me.slice(0, 8)}…${info.me.slice(-4)}` : '…'} />
      </Section>
      <Text style={styles.note}>
        Su iPhone i messaggi arrivano quando l’app è aperta: senza le notifiche push di Apple nessun server esterno sa quando ti scrivono. I server QVAC-BOARD abbinati li tengono cifrati e li consegnano quando ti ricolleghi.
      </Text>
    </>
  );
}

function DevicesPage({ go }: { go: Go }) {
  const p2p = useP2P();
  useEffect(() => { refreshNat(); }, []);
  const nat = p2p.nat;
  const natLabel = !nat ? '–' : !nat.firewalled ? 'aperta' : nat.randomized ? 'NAT casuale' : 'NAT coerente';
  const natNote = !nat ? '' : !nat.firewalled
    ? 'Ottima: chiunque dei tuoi dispositivi ti raggiunge direttamente.'
    : nat.randomized
      ? 'Holepunch può collegarsi solo se il server ha un NAT coerente; tra un tentativo e l’altro servono 20 secondi.'
      : 'Buona: Holepunch riesce quasi sempre a collegarsi.';
  return (
    <>
      <Row label="Server abbinati" value={String(p2p.macs.length)} onPress={() => go('devices')} />
      <Row label="Chiave di questo dispositivo" value={p2p.state.kind === 'ready' ? `${p2p.state.publicKey.slice(0, 8)}…${p2p.state.publicKey.slice(-4)}` : '–'} />
      <Row label="Rete di questo dispositivo" value={natLabel} onPress={refreshNat} />
      {!!natNote && <Text style={styles.about}>{natNote}</Text>}
    </>
  );
}

function PathsPage() {
  const s = useSettings();
  return (
    <>
      {(Object.keys(PATHS) as (keyof typeof PATHS)[]).map((k) => {
        const on = s.paths[k];
        const last = on && Object.values(s.paths).filter(Boolean).length === 1;
        return (
          <Toggle
            key={k}
            label={`${PATHS[k].icon} ${PATHS[k].label}`}
            note={PATHS[k].privacy}
            value={on}
            onChange={async (v) => {
              if (!v && last) {
                Alert.alert('Serve almeno un metodo', 'Senza nessun metodo di connessione il dispositivo mobile non potrebbe più raggiungere i tuoi server.');
                return;
              }
              await updateSettings({ paths: { ...s.paths, [k]: v } });
              applyPaths();
            }}
          />
        );
      })}
      <Text style={styles.about}>
        Si usa il primo metodo disponibile in quest’ordine, tra quelli attivi sia qui sia sul server. Quando un metodo migliore
        torna disponibile ci passa da solo. In tutti il contenuto è cifrato con chiavi nuove a ogni collegamento.
      </Text>
      <Text style={[styles.label, styles.subhead]}>📡 Relay Nostr</Text>
      <Relays />
    </>
  );
}

function InfoPage() {
  const s = useSettings();
  const loc = useLocal();
  const removeModel = () =>
    Alert.alert(
      'Eliminare il modello dal dispositivo?',
      `${LOCAL_MODEL.label} (${LOCAL_MODEL.sizeMB} MB) verrà cancellato. Alla prossima apertura dell’app verrà riscaricato.`,
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Elimina', style: 'destructive', onPress: async () => {
            try { await loc.deleteModel?.(); tap('success'); } catch (err) { Alert.alert('Non riuscito', (err as Error).message); }
          },
        },
      ],
    );
  return (
    <>
      <Row
        label="Nome per i tuoi server"
        value={deviceName()}
        onPress={() => askText('Nome di questo dispositivo', 'È il nome che vedono i tuoi server. Vuoto = il modello del telefono.', s.deviceName).then(async (text) => {
          if (text === null) return;
          await updateSettings({ deviceName: text.replace(/\s+/g, ' ').trim().slice(0, 40) });
          applyDeviceName();
          tap('success');
        })}
      />
      <Row label="Modello locale" value={`${LOCAL_MODEL.label} · ${LOCAL_MODEL.sizeMB} MB`} />
      <Row
        label="Stato"
        value={loc.state.kind === 'ready' ? `pronto (${loc.state.device})` : loc.state.kind === 'deleted' ? 'eliminato' : loc.state.kind === 'loading' ? 'in caricamento' : 'errore'}
      />
      {loc.lastTokensPerSecond != null && <Row label="Ultima velocità" value={`${loc.lastTokensPerSecond.toFixed(1)} token/s`} />}
      <Pressable style={[styles.danger, loc.state.kind !== 'ready' && styles.dim]} disabled={loc.state.kind !== 'ready'} onPress={removeModel}>
        <Text style={styles.dangerText}>Elimina il modello dal dispositivo</Text>
      </Pressable>
      <Row label="Versione" value={`QVAC-BOARD ${APP_VERSION}`} />
      <Text style={styles.about}>
        I modelli girano sul dispositivo mobile o sul tuo server, mai nel cloud. Server e dispositivo mobile si parlano direttamente e cifrati:
        rete locale, Bluetooth, Holepunch o relay Nostr. Fatto con QVAC (Tether).
      </Text>
    </>
  );
}

const RELAY_RE = /^wss:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/i;

function Relays() {
  const s = useSettings();
  const p2p = useP2P();
  const [status, setStatus] = useState<{ active: boolean; relays: RelayState[] }>({ active: false, relays: [] });
  const [draft, setDraft] = useState('');
  const fromMac = new Set(p2p.macs.flatMap((m) => m.relays ?? []));

  // Stato dal vivo mentre la pagina è aperta
  useEffect(() => {
    let alive = true;
    const load = async () => { const st = await nostrStatus(); if (alive) setStatus(st); };
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const save = async (list: string[]) => {
    await updateSettings({ nostrRelays: list });
    applyRelays();
    setStatus(await nostrStatus());
  };

  const add = () => {
    let url = draft.trim().replace(/\/+$/, '');
    if (!url) return;
    if (!/^wss?:\/\//.test(url)) url = `wss://${url}`;
    if (!RELAY_RE.test(url)) {
      Alert.alert('Indirizzo non valido', 'Scrivi l’indirizzo del relay, per esempio wss://nos.lol');
      return;
    }
    tap('success');
    setDraft('');
    if (!s.nostrRelays.includes(url) && !fromMac.has(url)) save([...s.nostrRelays, url]);
  };

  const shown = status.relays.length ? status.relays : relaysInUse().map((url) => ({ url, open: false }));
  return (
    <>
      <Text style={styles.about}>
        {status.active
          ? 'In uso adesso: rete di casa e Holepunch non passano, il server si raggiunge tramite questi relay.'
          : 'Non in uso: il server si raggiunge direttamente. Servono solo con VPN + rete cellulare.'}
      </Text>
      {shown.map((r) => {
        const mine = s.nostrRelays.includes(r.url);
        return (
          <View key={r.url} style={styles.option}>
            <View style={[styles.relayDot, { backgroundColor: r.open ? C.accent : C.border }]} />
            <View style={styles.flex}>
              <Text style={styles.mono} numberOfLines={1}>{r.url.replace('wss://', '')}</Text>
              <Text style={styles.note}>
                {fromMac.has(r.url) ? 'indicato dal server' : mine ? 'aggiunto da te' : 'predefinito'}
                {status.active ? (r.open ? ' · collegato' : ' · non collegato') : ''}
              </Text>
            </View>
            {mine && (
              <Pressable hitSlop={10} onPress={() => { tap(); save(s.nostrRelays.filter((u) => u !== r.url)); }} accessibilityLabel={`Togli ${r.url}`}>
                <Text style={styles.remove}>×</Text>
              </Pressable>
            )}
          </View>
        );
      })}
      <View style={[styles.option, styles.addRow]}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="wss://relay.esempio.org"
          placeholderTextColor="#6f7f79"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={add}
        />
        <Pressable style={[styles.addBtn, !draft.trim() && styles.dim]} disabled={!draft.trim()} onPress={add}>
          <Text style={styles.addText}>Aggiungi</Text>
        </Pressable>
      </View>
      <Text style={styles.about}>
        La lista principale si sceglie in QVAC-BOARD server (Impostazioni → Relay Nostr) e arriva qui da sola.
        Quelli che aggiungi qui si sommano. I relay vedono solo messaggi cifrati che non conservano.
      </Text>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Toggle({ label, note, value, onChange }: { label: string; note?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.option}>
      <View style={styles.flex}>
        <Text style={styles.text}>{label}</Text>
        {!!note && <Text style={styles.note}>{note}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={(v) => { tap(); onChange(v); }}
        trackColor={{ true: '#1f6b52', false: '#1a2320' }}
        thumbColor={value ? C.accent : C.muted}
      />
    </View>
  );
}

function Row({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const body = (
    <View style={styles.option}>
      <Text style={[styles.text, styles.flex]}>{label}</Text>
      <Text style={styles.value}>{value}{onPress ? '  ›' : ''}</Text>
    </View>
  );
  return onPress ? <Pressable onPress={() => { tap(); onPress(); }}>{body}</Pressable> : body;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 18, paddingBottom: 32 },
  flex: { flex: 1 },
  section: { gap: 8 },
  sectionTitle: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginLeft: 4 },
  card: { borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 4 },
  label: { color: C.muted, fontSize: 12, marginTop: 10 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: C.muted },
  radioOn: { borderColor: C.accent, backgroundColor: C.accent },
  text: { color: C.text, fontSize: 15 },
  note: { color: C.muted, fontSize: 12, marginTop: 2 },
  value: { color: C.muted, fontSize: 14 },
  danger: { marginVertical: 12, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: C.danger, alignItems: 'center' },
  dangerText: { color: C.danger, fontWeight: '600', fontSize: 15 },
  dim: { opacity: 0.4 },
  about: { color: C.muted, fontSize: 13, lineHeight: 19, paddingVertical: 12 },
  relayDot: { width: 9, height: 9, borderRadius: 5 },
  mono: { color: C.text, fontSize: 14, fontFamily: 'Menlo' },
  remove: { color: C.muted, fontSize: 22, paddingHorizontal: 4 },
  addRow: { gap: 8 },
  input: { flex: 1, color: C.text, fontSize: 14, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  addBtn: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: C.accent },
  addText: { color: '#06221a', fontWeight: '700', fontSize: 13 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  last: { borderBottomWidth: 0 },
  pressed: { opacity: 0.6 },
  listIcon: { fontSize: 22, width: 30, textAlign: 'center' },
  chevron: { color: C.muted, fontSize: 22 },
  back: { color: C.accent, fontSize: 16, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  chipsRow: { flexDirection: 'row', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface2 },
  chipActive: { borderColor: C.accent, backgroundColor: C.accentSoft },
  chipText: { color: C.text, fontSize: 13, fontWeight: '600' },
  activeText: { color: C.accent, fontWeight: '700' },
  link: { color: C.accent, fontWeight: '600', fontSize: 14 },
  inlineInput: { minWidth: 140, textAlign: 'right', color: C.text, fontSize: 15, paddingVertical: 4 },
  pageTitle: { color: C.text, fontSize: 26, fontWeight: '800', marginTop: -6 },
  subhead: { marginTop: 18, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
});
