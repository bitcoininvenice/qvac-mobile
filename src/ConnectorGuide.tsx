// A connector's guide: what the service is, and every tool it offers with its
// description, parameters and permission. Opens right after adding a connector.
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  permissionOf, reconnectConnector, removeConnector, setConnectorEnabled, setToolPermission, useConnectors,
  type Permission,
} from './connectors';
import type { McpTool } from './mcpClient';
import { tap } from './settings';
import { C } from './theme';

const PERMS: { key: Permission; label: string; note: string }[] = [
  { key: 'auto', label: 'Automatico', note: 'parte da solo' },
  { key: 'ask', label: 'Chiedi', note: 'ti chiede prima' },
  { key: 'off', label: 'Spento', note: 'il modello non lo vede' },
];

export default function ConnectorGuide({ name, onRemoved }: { name: string; onRemoved: () => void }) {
  const c = useConnectors().find((x) => x.name === name);
  if (!c) return <Text style={styles.about}>Connettore non trovato.</Text>;
  const st = c.status;
  const info = st.serverInfo;

  const confirmRemove = () =>
    Alert.alert(`Rimuovere “${name}”?`, 'Il connettore e il suo token verranno cancellati da questo dispositivo.', [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Rimuovi', style: 'destructive', onPress: async () => { await removeConnector(name); onRemoved(); } },
    ]);

  return (
    <>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text style={styles.service}>{info?.title || info?.name || name}{info?.version ? `  v${info.version}` : ''}</Text>
          <Text style={styles.note} numberOfLines={2}>{c.url}{c.hasToken ? '  · 🔑 con token' : ''}</Text>
          <Text style={[styles.note, st.state === 'connected' && styles.on, st.state === 'error' && styles.err]}>
            {st.state === 'connected' ? `collegato · ${st.tools.length} strumenti`
              : st.state === 'connecting' ? 'collegamento…'
                : st.state === 'off' ? 'spento'
                  : `errore: ${st.error}`}
          </Text>
        </View>
        {st.state === 'connecting' ? <ActivityIndicator color={C.accent} /> : (
          <Switch
            value={c.enabled}
            onValueChange={(v) => { tap(); setConnectorEnabled(name, v); }}
            trackColor={{ true: '#1f6b52', false: '#1a2320' }}
            thumbColor={c.enabled ? C.accent : C.muted}
          />
        )}
      </View>

      {!!st.instructions && (
        <View style={styles.box}>
          <Text style={styles.boxTitle}>Dal servizio</Text>
          <Text style={styles.boxText}>{st.instructions.trim()}</Text>
        </View>
      )}

      <Text style={styles.about}>
        🌐 Remoto: l’iPhone parla direttamente con questo servizio, che vede quello che il modello gli chiede. Il modello resta
        sul tuo dispositivo. Gli strumenti marcati “sola lettura” non modificano nulla.
      </Text>

      {st.tools.map((t) => <ToolCard key={t.name} server={name} tool={t} permission={permissionOf(c, t)} />)}
      {st.state === 'connected' && !st.tools.length && <Text style={styles.about}>Questo servizio non offre strumenti.</Text>}

      <View style={styles.actions}>
        {st.state === 'error' && (
          <Pressable onPress={() => { tap(); reconnectConnector(name); }} hitSlop={8}><Text style={styles.link}>Ricollega</Text></Pressable>
        )}
        <Pressable onPress={confirmRemove} hitSlop={8}><Text style={[styles.link, styles.err]}>Rimuovi il connettore</Text></Pressable>
      </View>
    </>
  );
}

// One tool: what it does, what it needs, and how much freedom the model has with it
function ToolCard({ server, tool, permission }: { server: string; tool: McpTool; permission: Permission }) {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, any>; required?: string[] };
  const params = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const readOnly = tool.annotations?.readOnlyHint === true;
  return (
    <View style={styles.tool}>
      <View style={styles.toolHead}>
        <Text style={styles.toolName}>{tool.name}</Text>
        <Text style={[styles.badge, readOnly ? styles.badgeRead : styles.badgeAct]}>{readOnly ? 'sola lettura' : 'può agire'}</Text>
      </View>
      {!!tool.description && <Text style={styles.desc}>{tool.description.trim()}</Text>}
      {params.length > 0 && (
        <View style={styles.params}>
          <Text style={styles.paramsTitle}>Parametri</Text>
          {params.map(([pname, p]) => (
            <Text key={pname} style={styles.param}>
              <Text style={styles.paramName}>{pname}</Text>
              <Text style={styles.paramType}> {Array.isArray(p?.enum) ? p.enum.join(' | ') : p?.type ?? ''}{required.has(pname) ? ' · obbligatorio' : ''}</Text>
              {p?.description ? <Text style={styles.paramDesc}>{`\n${p.description}`}</Text> : null}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.perms}>
        {PERMS.map((p) => (
          <Pressable
            key={p.key}
            onPress={() => { tap(); setToolPermission(server, tool.name, p.key); }}
            style={[styles.perm, permission === p.key && styles.permOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: permission === p.key }}
          >
            <Text style={[styles.permText, permission === p.key && styles.permTextOn]}>{p.label}</Text>
            <Text style={styles.permNote}>{p.note}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  service: { color: C.text, fontSize: 17, fontWeight: '700' },
  note: { color: C.muted, fontSize: 12, marginTop: 3 },
  on: { color: C.accent },
  err: { color: C.danger },
  about: { color: C.muted, fontSize: 13, lineHeight: 19, paddingVertical: 10 },
  box: { padding: 12, borderRadius: 10, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, marginBottom: 4 },
  boxTitle: { color: C.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6 },
  boxText: { color: C.text, fontSize: 13, lineHeight: 19 },
  tool: { paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, gap: 8 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  toolName: { color: C.text, fontSize: 15, fontWeight: '700', fontFamily: 'Menlo' },
  badge: { fontSize: 11, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, borderWidth: 1, overflow: 'hidden' },
  badgeRead: { color: C.accent, borderColor: C.accent },
  badgeAct: { color: C.warning, borderColor: C.warning },
  desc: { color: C.text, fontSize: 13, lineHeight: 19 },
  params: { padding: 10, borderRadius: 8, backgroundColor: C.bg, gap: 6 },
  paramsTitle: { color: C.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  param: { fontSize: 13, lineHeight: 18 },
  paramName: { color: C.text, fontFamily: 'Menlo', fontWeight: '600' },
  paramType: { color: C.muted, fontSize: 12 },
  paramDesc: { color: C.muted, fontSize: 12 },
  perms: { flexDirection: 'row', gap: 6 },
  perm: { flex: 1, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  permOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  permText: { color: C.muted, fontSize: 13, fontWeight: '600' },
  permTextOn: { color: C.accent },
  permNote: { color: C.muted, fontSize: 10, marginTop: 1 },
  actions: { flexDirection: 'row', gap: 20, paddingVertical: 14 },
  link: { color: C.accent, fontSize: 14, fontWeight: '600' },
});
