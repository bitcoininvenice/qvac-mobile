// Home: la dashboard dell'app, a schede (widget) animate.
import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionButton, Badge, Card, CardTitle, PulseDot, Ring, Sparkline } from './ui';
import { macLabel, pathShort, useP2P, watchSystem, type Mac, type MacStatus, type MacSystem } from './p2p';
import { LOCAL_MODEL, useLocal } from './local';
import { useSettings } from './settings';
import { pickAndSend } from './Devices';
import { C } from './theme';

export type Go = (tab: 'home' | 'chat' | 'messages' | 'voice' | 'devices' | 'settings', opts?: { model?: string; page?: string }) => void;

const greeting = () => {
  const h = new Date().getHours();
  return h < 6 ? 'Buonanotte' : h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
};
const gb = (b: number | null) => (b == null ? '–' : `${(b / 1024 ** 3).toFixed(1)} GB`);
const formatSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export default function Home({ go }: { go: Go }) {
  const p2p = useP2P();
  const loc = useLocal();
  const settings = useSettings();
  const onlineMacs = p2p.macs.filter((m) => p2p.status[m.mac]?.online);

  // Chiediamo i dati dal vivo solo mentre la Home è aperta (e se attivi)
  const macKeys = p2p.macs.map((m) => m.mac).join(',');
  useEffect(() => {
    if (!settings.liveStats || p2p.state.kind !== 'ready') return;
    const keys = macKeys ? macKeys.split(',') : [];
    keys.forEach((k) => watchSystem(k, true));
    return () => keys.forEach((k) => watchSystem(k, false));
  }, [macKeys, settings.liveStats, p2p.state.kind]);

  const summary = !p2p.macs.length
    ? 'Collega il tuo server per usare i suoi modelli e scambiare file.'
    : onlineMacs.length
      ? `${onlineMacs.map(macLabel).join(', ')} ${onlineMacs.length > 1 ? 'sono online' : 'è online'} · ${pathShort(p2p.status[onlineMacs[0].mac]?.via)}.`
      : 'Il server non è raggiungibile: il dispositivo mobile continua a funzionare da solo.';

  const firstMac = onlineMacs[0];
  const firstMacModel = firstMac ? p2p.status[firstMac.mac]?.models.find((m) => /4B/.test(m.label)) ?? p2p.status[firstMac.mac]?.models[0] : null;
  const transfers = Object.values(p2p.transfers);

  let delay = 0;
  const next = () => (delay += 70);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.hero}>
        <Text style={styles.hello}>{greeting()}</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>

      {!p2p.macs.length && (
        <Card delay={next()} onPress={() => go('devices')}>
          <CardTitle>Il tuo server</CardTitle>
          <Text style={styles.big}>Collega il server</Text>
          <Text style={styles.muted}>Da QVAC-BOARD server: Dispositivi → Collega telefono, poi inquadra il QR.</Text>
        </Card>
      )}

      {p2p.macs.map((m) => (
        <MacCard key={m.mac} mac={m} status={p2p.status[m.mac]} system={p2p.system[m.mac]} live={settings.liveStats} delay={next()} />
      ))}

      <Card delay={next()}>
        <CardTitle right={<Badge tone={loc.state.kind === 'ready' ? 'accent' : 'muted'}>{loc.state.kind === 'ready' ? loc.state.device : loc.state.kind === 'deleted' ? 'eliminato' : '…'}</Badge>}>
          questo dispositivo
        </CardTitle>
        <View style={styles.row}>
          <PulseDot on={loc.state.kind === 'ready'} />
          <View style={styles.flex}>
            <Text style={styles.name}>{LOCAL_MODEL.label}</Text>
            <Text style={styles.muted}>
              {loc.state.kind === 'ready' ? 'pronto, anche offline'
                : loc.state.kind === 'loading' ? `${loc.state.text}${loc.state.percent != null ? ` ${Math.round(loc.state.percent)}%` : ''}`
                  : loc.state.kind === 'deleted' ? 'modello eliminato: riapri l’app per riscaricarlo'
                    : `errore: ${loc.state.text}`}
            </Text>
          </View>
          {loc.lastTokensPerSecond != null && (
            <View style={styles.stat}>
              <Text style={styles.statValue}>{loc.lastTokensPerSecond.toFixed(0)}</Text>
              <Text style={styles.statLabel}>token/s</Text>
            </View>
          )}
        </View>
      </Card>

      <Card delay={next()}>
        <CardTitle>Azioni rapide</CardTitle>
        <View style={styles.actions}>
          <ActionButton icon="💬" label="Chiedi al dispositivo" onPress={() => go('chat', { model: 'local' })} />
          <ActionButton
            icon="🖥"
            label={firstMacModel ? `Chiedi al server (${firstMacModel.label.split(' — ')[0]})` : 'Chiedi al server'}
            disabled={!firstMac || !firstMacModel}
            onPress={() => firstMac && firstMacModel && go('chat', { model: `${firstMac.mac}|${firstMacModel.id}` })}
          />
        </View>
        <View style={styles.actions}>
          <ActionButton icon="🖼" label="Invia foto al server" disabled={!firstMac} onPress={() => firstMac && pickAndSend(firstMac, 'photo')} />
          <ActionButton icon="📄" label="Invia file al server" disabled={!firstMac} onPress={() => firstMac && pickAndSend(firstMac, 'file')} />
        </View>
      </Card>

      <Card delay={next()} onPress={() => go('devices')}>
        <CardTitle right={<Text style={styles.link}>Tutti ›</Text>}>File</CardTitle>
        {transfers.map((t) => (
          <View key={t.id} style={styles.transfer}>
            <Text style={styles.muted} numberOfLines={1}>{t.direction === 'out' ? '↑ al server' : '↓ dal server'} · {t.name}</Text>
            <View style={styles.bar}><View style={[styles.barFill, { width: `${t.total ? Math.min(100, (t.sent / t.total) * 100) : 0}%` }]} /></View>
          </View>
        ))}
        {!transfers.length && !p2p.received.length && <Text style={styles.muted}>Nessun file ricevuto dal server.</Text>}
        {p2p.received.slice(0, 3).map((f) => (
          <View key={f.uri} style={styles.row}>
            <Text style={styles.fileIcon}>{/\.(png|jpe?g|heic|gif|webp)$/i.test(f.name) ? '🖼' : '📄'}</Text>
            <Text style={[styles.name, styles.flex]} numberOfLines={1}>{f.name}</Text>
            <Text style={styles.muted}>{formatSize(f.size)}</Text>
          </View>
        ))}
      </Card>

      <Card delay={next()} style={styles.soon}>
        <CardTitle right={<Badge>in arrivo</Badge>}>Bitaxe</CardTitle>
        <Text style={styles.muted}>
          Temperatura e hashrate dei tuoi Bitaxe, letti dal server sulla rete di casa. Si attiva con l’agente sul server.
        </Text>
      </Card>
    </ScrollView>
  );
}

function MacCard({ mac, status, system, live, delay }: { mac: Mac; status?: MacStatus; system?: MacSystem; live: boolean; delay: number }) {
  const online = Boolean(status?.online);
  const fresh = online && system && Date.now() - system.at < 8000;
  const mem = system?.memUsed && system?.memTotal ? system.memUsed / system.memTotal : null;
  return (
    <Card delay={delay} style={!online ? styles.offline : undefined}>
      <CardTitle
        right={online
          ? <Badge tone="accent">{pathShort(status?.via)}{status?.rtt != null ? ` · ${status.rtt} ms` : ''}</Badge>
          : <Badge>offline</Badge>}
      >
        Server
      </CardTitle>
      <View style={styles.row}>
        <PulseDot on={online} />
        <Text style={[styles.big, styles.flex]} numberOfLines={1}>{macLabel(mac)}</Text>
      </View>

      {online && live && (
        <>
          <View style={styles.rings}>
            <Ring value={fresh ? system!.cpu : null} label="CPU" />
            <Ring value={fresh ? system!.gpu : null} label="GPU" />
            <Ring value={fresh ? mem : null} label={`RAM ${gb(system?.memUsed ?? null)}`} warnAt={0.9} />
          </View>
          <View>
            <Text style={styles.chartLabel}>CPU, ultimi 80 secondi</Text>
            <Sparkline values={system?.history.cpu ?? []} />
          </View>
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.muted}>Modello in memoria</Text>
              <Text style={styles.name}>{system?.model ? `${system.model.label.split(' — ')[0]}${system.model.busy ? ' · sta rispondendo' : ''}` : 'nessuno'}</Text>
            </View>
            {system?.tokensPerSecond != null && (
              <View style={styles.stat}>
                <Text style={styles.statValue}>{system.tokensPerSecond.toFixed(0)}</Text>
                <Text style={styles.statLabel}>token/s</Text>
              </View>
            )}
          </View>
        </>
      )}
      {online && !live && <Text style={styles.muted}>Dati dal vivo disattivati nelle Impostazioni.</Text>}
      {!online && <Text style={styles.muted}>Lo cerco in rete di casa e via internet…</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 32 },
  flex: { flex: 1 },
  hero: { paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6, gap: 4 },
  hello: { color: C.text, fontSize: 28, fontWeight: '800' },
  summary: { color: C.muted, fontSize: 15, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  big: { color: C.text, fontSize: 20, fontWeight: '700' },
  name: { color: C.text, fontSize: 15, fontWeight: '600' },
  muted: { color: C.muted, fontSize: 13, lineHeight: 18 },
  link: { color: C.accent, fontSize: 13, fontWeight: '600' },
  rings: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 4 },
  chartLabel: { color: C.muted, fontSize: 11, marginBottom: 4 },
  stat: { alignItems: 'flex-end' },
  statValue: { color: C.accent, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: C.muted, fontSize: 11 },
  actions: { flexDirection: 'row', gap: 10 },
  fileIcon: { fontSize: 18 },
  transfer: { gap: 4 },
  bar: { height: 4, borderRadius: 2, backgroundColor: C.bg, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: C.accent },
  offline: { opacity: 0.75 },
  soon: { opacity: 0.7 },
});
