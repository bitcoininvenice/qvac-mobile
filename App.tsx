// QVAC-BOARD mobile — tappa 1: chat con un modello che gira sul dispositivo.
// Niente rete, niente Mac: il modello viene scaricato la prima volta e poi
// resta sul telefono.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QWEN3_600M_INST_Q4, cancel, completion, loadModel, unloadModel } from '@qvac/sdk';
import Svg, { Path } from 'react-native-svg';
import Devices from './src/Devices';
import Home, { type Go } from './src/Home';
import Settings from './src/SettingsScreen';
import VoiceScreen from './src/VoiceScreen';
import Messages from './src/Messages';
import { PromptHost } from './src/prompt';
import { chatOnMac, macLabel, refreshP2P, startP2P, useP2P } from './src/p2p';
import { callPhoneTool, phoneToolsForModel } from './src/connectors';
import { setLocal, type LocalModelState } from './src/local';
import { loadSettings, tap, useSettings } from './src/settings';
import { C } from './src/theme';

const MODEL_LABEL = 'Qwen3 0.6B';
const CTX = 2048; // i telefoni con 4 GB di RAM stanno larghi con un contesto piccolo
const REMOTE_CTX = 8192;
// Connector tools with the iPhone's own model: off until QVAC mobile supports tool calling
// without crashing (loading the model with tools: true aborts the app).
const LOCAL_MODEL_TOOLS = false; // i modelli del server hanno più memoria a disposizione
const SYSTEM = 'Sei QVAC, un assistente AI locale e privato. Rispondi in italiano, in modo chiaro e conciso.';

// "local" = il modello sul dispositivo; altrimenti "<chiave del server>|<id del modello>"
type Choice = { key: string; label: string; mac?: string; macName?: string; model?: string };
const shortLabel = (label: string) => label.split(' — ')[0];

type ToolLine = { id: string; label: string; status: string };
type Message = { role: 'user' | 'assistant'; content: string; thinking?: string; meta?: string; tools?: ToolLine[] };
type ModelState = LocalModelState;

const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

// Teniamo solo i messaggi più recenti che stanno nel contesto (lasciando spazio alla risposta)
function fitHistory(messages: Message[], think: boolean, ctx = CTX) {
  const budget = ctx * 0.6 - estimateTokens(SYSTEM);
  const out: { role: string; content: string }[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isLastUser = i === messages.length - 1 && m.role === 'user';
    const content = isLastUser && !think ? `${m.content} /no_think` : m.content;
    used += estimateTokens(content);
    if (used > budget && out.length) break;
    out.unshift({ role: m.role, content });
  }
  return [{ role: 'system', content: SYSTEM }, ...out];
}

type Tab = 'home' | 'chat' | 'messages' | 'voice' | 'devices' | 'settings';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'home', label: 'Home', icon: 'M4 13h6V4H4zm0 7h6v-5H4zm10 0h6v-9h-6zm0-16v5h6V4z' },
  { key: 'chat', label: 'Chat', icon: 'M4 4h16v12H8l-4 4z' },
  { key: 'messages', label: 'Messaggi', icon: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6zm8 5H6v-2h8zm4-6H6V6h12z' },
  { key: 'voice', label: 'Parla', icon: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z' },
  { key: 'devices', label: 'Dispositivi', icon: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h10V5zm5 14.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z' },
  { key: 'settings', label: 'Impostazioni', icon: 'M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z' },
];
const TITLES: Record<Tab, string> = { home: 'QVAC-BOARD', chat: 'Chat', messages: 'Messaggi', voice: 'Parla', devices: 'Dispositivi', settings: 'Impostazioni' };

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [requested, setRequested] = useState<{ key: string; n: number } | null>(null);
  const p2p = useP2P();
  const online = Object.values(p2p.status).filter((s) => s.online).length;

  const [settingsPage, setSettingsPage] = useState<{ page: string; n: number } | null>(null);
  const go: Go = (t, opts) => {
    if (opts?.model) setRequested({ key: opts.model, n: Date.now() });
    if (opts?.page) setSettingsPage({ page: opts.page, n: Date.now() });
    setTab(t);
  };

  // Il P2P parte subito; quando l'app torna in primo piano ricerchiamo i Mac
  useEffect(() => {
    loadSettings();
    startP2P();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refreshP2P(); });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.logo}><Text style={styles.logoText}>Q</Text></View>
            <View>
              <Text style={styles.title}>{TITLES[tab]}</Text>
              <Text style={styles.subtitle}>
                {online ? `${online} server online` : p2p.macs.length ? 'Server non raggiungibile' : 'AI su dispositivo mobile, niente cloud'}
              </Text>
            </View>
          </View>
        </View>
        {tab === 'home' && <View style={styles.flex}><Home go={go} /></View>}
        {/* La chat resta montata: cambiando scheda il modello non si ricarica */}
        <View style={[styles.flex, tab !== 'chat' && styles.hidden]}><Chat requested={requested} /></View>
        {tab === 'messages' && <View style={styles.flex}><Messages /></View>}
        {tab === 'voice' && <View style={styles.flex}><VoiceScreen go={go} /></View>}
        {tab === 'devices' && <View style={styles.flex}><Devices /></View>}
        {tab === 'settings' && <View style={styles.flex}><Settings go={go} requested={settingsPage} /></View>}
        <View style={styles.tabbar}>
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <Pressable key={t.key} style={styles.tabItem} onPress={() => { if (!active) tap(); setTab(t.key); }} accessibilityRole="tab" accessibilityState={{ selected: active }}>
                <Svg width={24} height={24} viewBox="0 0 24 24"><Path d={t.icon} fill={active ? C.accent : C.muted} /></Svg>
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{t.label}</Text>
                {t.key === 'devices' && online > 0 && <View style={styles.tabDot} />}
                {t.key === 'messages' && p2p.msg.unread > 0 && <View style={styles.tabBadge}><Text style={styles.tabBadgeText}>{p2p.msg.unread > 99 ? '99+' : p2p.msg.unread}</Text></View>}
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
      <PromptHost />
    </SafeAreaProvider>
  );
}

function Chat({ requested }: { requested: { key: string; n: number } | null }) {
  const [model, setModelState] = useState<ModelState>({ kind: 'loading', text: 'Avvio di QVAC…' });
  // Lo stato del modello locale serve anche a Home e Impostazioni
  const setModel = (m: ModelState) => { setModelState(m); setLocal({ state: m }); };
  const settings = useSettings();

  // Keyboard: lift the composer by exactly the part of the chat the keyboard covers.
  // (KeyboardAvoidingView got this wrong: the chat sits under the header and above
  // the tab bar, not at the top of the screen.)
  const chatBox = useRef<any>(null); // the chat container (a native view)
  const [keyboardPad, setKeyboardPad] = useState(0);
  useEffect(() => {
    const animate = (duration?: number) => {
      if (duration) LayoutAnimation.configureNext(LayoutAnimation.create(duration, LayoutAnimation.Types.keyboard, LayoutAnimation.Properties.opacity));
    };
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', (e) => {
      chatBox.current?.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        animate(e.duration);
        setKeyboardPad(Math.max(0, y + h - e.endCoordinates.screenY));
      });
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', (e) => {
      animate(e.duration);
      setKeyboardPad(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [think, setThink] = useState(settings.think);
  const [choiceKey, setChoiceKey] = useState(settings.defaultModel);

  // Predefiniti dalle Impostazioni, e modello chiesto dalla Home
  useEffect(() => { setThink(settings.think); }, [settings.think]);
  useEffect(() => { setChoiceKey(settings.defaultModel); }, [settings.defaultModel]);
  useEffect(() => { if (requested) setChoiceKey(requested.key); }, [requested]);
  const modelId = useRef<string | null>(null);
  const requestId = useRef<string | null>(null);
  const remoteCancel = useRef<(() => void) | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  // Keyboard opened: keep the last message in sight above the composer
  useEffect(() => { if (keyboardPad > 0) setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50); }, [keyboardPad]);
  const p2p = useP2P();

  // Modelli tra cui scegliere: quello dell'iPhone + quelli dei server online
  const choices: Choice[] = [{ key: 'local', label: `Mobile · ${MODEL_LABEL}` }];
  for (const m of p2p.macs) {
    const st = p2p.status[m.mac];
    if (!st?.online) continue;
    for (const model of st.models) {
      choices.push({ key: `${m.mac}|${model.id}`, label: `Server · ${shortLabel(model.label)}`, mac: m.mac, macName: macLabel(m), model: model.id });
    }
  }
  const choice = choices.find((c) => c.key === choiceKey);
  // A server model was chosen but that server is unreachable (off, asleep, no network):
  // the mobile's model answers by itself, and the server takes over again when it is back
  const wanted = choiceKey !== 'local';
  const fallback = wanted && !choice && settings.fallbackLocal;
  const remote = wanted && !fallback;

  // Carica il modello all'avvio: GPU (Metal) se possibile, altrimenti CPU
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const device of ['gpu', 'cpu']) {
        try {
          setModel({ kind: 'loading', text: device === 'gpu' ? `Carico ${MODEL_LABEL}…` : 'GPU non disponibile, provo con la CPU…' });
          const id = await loadModel({
            modelSrc: QWEN3_600M_INST_Q4,
            // No "tools" here: on the iPhone QVAC crashes with it (2026-11-19). The phone's connectors
            // work through the server's models; with this small model they are not offered.
            modelConfig: { ctx_size: CTX, device },
            onProgress: (p: { percentage?: number }) => {
              if (!cancelled && p.percentage != null && p.percentage < 100) {
                setModel({ kind: 'loading', text: `Scarico ${MODEL_LABEL} (solo la prima volta)`, percent: p.percentage });
              }
            },
          });
          if (cancelled) {
            unloadModel({ modelId: id, clearStorage: false }).catch(() => { });
            return;
          }
          modelId.current = id;
          setModel({ kind: 'ready', device: device === 'gpu' ? 'GPU' : 'CPU' });
          setLocal({
            modelId: id,
            deleteModel: async () => {
              const current = modelId.current;
              modelId.current = null;
              setLocal({ modelId: null });
              if (current) await unloadModel({ modelId: current, clearStorage: true });
              setModel({ kind: 'deleted' });
            },
          });
          return;
        } catch (err) {
          if (device === 'cpu' && !cancelled) setModel({ kind: 'error', text: (err as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (requestId.current) cancel({ requestId: requestId.current }).catch(() => { });
      if (modelId.current) unloadModel({ modelId: modelId.current, clearStorage: false }).catch(() => { });
    };
  }, []);

  const update = (fn: (last: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1])]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (remote ? !choice : !modelId.current) return;
    setInput('');
    const next: Message[] = [...messages, { role: 'user', content: text }];
    setMessages([...next, { role: 'assistant', content: '' }]);
    setBusy(true);
    const started = Date.now();

    // Sul server: la risposta arriva in streaming via P2P (o rete di casa)
    if (remote && choice?.mac && choice.model) {
      let tps: number | undefined;
      let failed = '';
      const phone = phoneToolsForModel();
      const { finished, cancel: stopRemote, confirm, phoneResult } = chatOnMac(choice.mac, choice.model, fitHistory(next, think, REMOTE_CTX), REMOTE_CTX, (e) => {
        if (e.kind === 'token') update((m) => ({ ...m, content: m.content + e.text }));
        else if (e.kind === 'thinking') update((m) => ({ ...m, thinking: (m.thinking ?? '') + e.text }));
        else if (e.kind === 'status') update((m) => ({ ...m, meta: e.text || undefined }));
        else if (e.kind === 'done') tps = e.tokensPerSecond;
        else if (e.kind === 'error') failed = e.error;
        else if (e.kind === 'tool') {
          // A connector tool used by the server's agent
          const line = { id: e.callId, label: `${e.server} › ${e.tool}${e.status === 'denied' ? ' — non autorizzato' : e.status === 'error' ? ` — ${e.summary ?? 'errore'}` : ''}`, status: e.status };
          update((m) => ({ ...m, tools: [...(m.tools ?? []).filter((t) => t.id !== e.callId), line] }));
        } else if (e.kind === 'phonecall') {
          // The server's model picked one of this phone's connectors: we run it, the server never sees the service
          const target = phone.resolve(e.tool);
          const run = async () => {
            try { phoneResult(e.callId, await callPhoneTool(target!.server, target!.tool, e.args)); }
            catch (err) { phoneResult(e.callId, { isError: true, text: (err as Error).message }); }
          };
          if (!target) phoneResult(e.callId, { isError: true, text: 'Strumento non disponibile su questo dispositivo' });
          else if (target.permission === 'ask') {
            tap('warning');
            Alert.alert(
              'Usare un connettore di questo dispositivo?',
              `${target.server} › ${target.tool}\n\n${JSON.stringify(e.args ?? {}, null, 2).slice(0, 600)}`,
              [
                { text: 'Rifiuta', style: 'cancel', onPress: () => phoneResult(e.callId, { denied: true, text: '' }) },
                { text: 'Consenti', onPress: run },
              ],
              { cancelable: false },
            );
          } else run();
        } else if (e.kind === 'confirm') {
          tap('warning');
          update((m) => ({ ...m, tools: [...(m.tools ?? []).filter((t) => t.id !== e.callId), { id: e.callId, label: `${e.server} › ${e.tool}`, status: 'waiting' }] }));
          Alert.alert(
            'Il server vuole usare uno strumento',
            `${e.server} › ${e.tool}${e.remote ? ' (servizio remoto)' : ''}\n\n${JSON.stringify(e.args ?? {}, null, 2).slice(0, 600)}`,
            [
              { text: 'Rifiuta', style: 'cancel', onPress: () => confirm(e.callId, false) },
              { text: 'Consenti', onPress: () => confirm(e.callId, true) },
            ],
            { cancelable: false },
          );
        }
      }, phone.tools);
      remoteCancel.current = stopRemote;
      await finished;
      remoteCancel.current = null;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      update((m) => ({
        ...m,
        content: m.content.trim() || (failed ? `Errore: ${failed}` : ''),
        meta: `sul server · ${choice.label.replace('Server · ', '')}${tps ? ` · ${tps.toFixed(1)} token/s` : ''} · ${secs} s${failed && m.content ? ' · interrotto' : ''}`,
      }));
      setBusy(false);
      return;
    }

    try {
      // The iPhone's model, with the iPhone's own connectors (works with the server off too)
      const phone = phoneToolsForModel();
      const tools = LOCAL_MODEL_TOOLS ? phone.tools.map((t) => ({ type: 'function', ...t })) : [];
      let history: any[] = fitHistory(next, think);
      let tps: number | null = null;
      for (let step = 0; step < 4; step++) {
        const run = completion({ modelId: modelId.current!, history, stream: true, captureThinking: true, ...(tools.length ? { tools } : {}) } as any);
        requestId.current = run.requestId;
        let content = '';
        let hiding = false; // the text of a tool call is not part of the answer
        for await (const ev of run.events as AsyncIterable<any>) {
          if (ev.type === 'contentDelta' && ev.text) {
            if (hiding) continue;
            let text: string = ev.text;
            const at = (content + text).indexOf('<tool_call>');
            if (at !== -1) { text = text.slice(0, Math.max(0, at - content.length)); hiding = true; }
            content += text;
            if (text) update((m) => ({ ...m, content: m.content + text }));
          } else if (ev.type === 'thinkingDelta') update((m) => ({ ...m, thinking: (m.thinking ?? '') + ev.text }));
          else if (ev.type === 'completionStats') tps = ev.stats?.tokensPerSecond ?? null;
        }
        const final: any = await (run as any).final;
        const calls: any[] = final?.toolCalls ?? [];
        if (!calls.length) break;
        history = [...history, { role: 'assistant', content: (final.contentText ?? content).trim(), toolCalls: calls }];
        for (const c of calls) {
          const id = c.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const target = phone.resolve(c.name);
          const label = target ? `${target.server} › ${target.tool}` : c.name;
          const setLine = (status: string, extra = '') =>
            update((m) => ({ ...m, tools: [...(m.tools ?? []).filter((t) => t.id !== id), { id, label: label + extra, status }] }));
          let result: string;
          if (!target) result = `Errore: lo strumento “${c.name}” non esiste.`;
          else {
            let allowed = target.permission === 'auto';
            if (!allowed) {
              setLine('waiting');
              tap('warning');
              allowed = await new Promise<boolean>((resolve) => Alert.alert(
                'Usare un connettore?',
                `${label}\n\n${JSON.stringify(c.arguments ?? {}, null, 2).slice(0, 600)}`,
                [{ text: 'Rifiuta', style: 'cancel', onPress: () => resolve(false) }, { text: 'Consenti', onPress: () => resolve(true) }],
                { cancelable: false },
              ));
            }
            if (!allowed) {
              setLine('denied', ' — non autorizzato');
              result = 'L’utente non ha autorizzato questo strumento. Rispondi senza usarlo.';
            } else {
              setLine('running');
              try {
                const r = await callPhoneTool(target.server, target.tool, c.arguments ?? {});
                setLine(r.isError ? 'error' : 'done', r.isError ? ` — ${r.text.slice(0, 60)}` : '');
                result = r.isError ? `Errore dello strumento: ${r.text}` : r.text;
              } catch (err) {
                setLine('error', ` — ${(err as Error).message}`);
                result = `Errore: ${(err as Error).message}`;
              }
            }
          }
          history.push({ role: 'tool', content: result, toolCallId: id, toolName: c.name });
        }
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      update((m) => ({ ...m, content: m.content.trim(), meta: `${fallback ? 'dal dispositivo (server non raggiungibile) · ' : ''}${tps ? `${tps.toFixed(1)} token/s · ` : ''}${secs} s` }));
      if (tps) setLocal({ lastTokensPerSecond: tps });
    } catch (err) {
      const msg = (err as Error).message;
      update((m) => ({ ...m, content: m.content || `Errore: ${msg}`, meta: m.content ? 'Interrotto' : undefined }));
    } finally {
      requestId.current = null;
      setBusy(false);
    }
  }, [input, busy, messages, think, remote, choice, fallback]);

  const stop = () => {
    if (remoteCancel.current) return remoteCancel.current();
    if (requestId.current) cancel({ requestId: requestId.current }).catch(() => { });
  };


  const ready = remote ? Boolean(choice) : model.kind === 'ready';

  return (
    <View ref={chatBox} style={[styles.flex, { paddingBottom: keyboardPad }]}>
      <View style={styles.chatTop}>
        <View style={styles.flex}><ModelBar state={model} /></View>
        <Pressable onPress={() => setMessages([])} disabled={busy || !messages.length} hitSlop={10}>
          <Text style={[styles.newChat, (busy || !messages.length) && styles.dim]}>+ Nuova</Text>
        </Pressable>
      </View>

      {choices.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow} contentContainerStyle={styles.chips}>
          {choices.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => setChoiceKey(c.key)}
              disabled={busy}
              style={[styles.chip, c.key === choiceKey && styles.chipActive, busy && styles.dim]}
            >
              <Text style={[styles.chipText, c.key === choiceKey && styles.chipTextActive]}>{c.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <ScrollView
        ref={scroll}
        style={styles.flex}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        keyboardDismissMode="interactive"
      >
        {!messages.length && (
          <Text style={styles.empty}>
            {remote && choice
              ? `Risponde ${shortLabel(choice.label.replace('Server · ', ''))}  “${choice.macName}”.\nIl collegamento è diretto e cifrato.`
              : fallback
                ? `Il server non è raggiungibile: intanto risponde ${MODEL_LABEL}, su questo dispositivo.\nAppena il server torna online, risponde di nuovo lui.`
                : `Scrivi un messaggio: risponde ${MODEL_LABEL}, che gira su questo dispositivo.\nFunziona anche offline.`}
          </Text>
        )}
        {messages.map((m, i) => <Bubble key={i} message={m} streaming={busy && i === messages.length - 1} />)}
      </ScrollView>

      {fallback && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Server non raggiungibile: risponde il modello di questo dispositivo.</Text>
        </View>
      )}
      {remote && !choice && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Il modello scelto è sul server, che ora non è raggiungibile.</Text>
          <Pressable onPress={() => { tap(); setChoiceKey('local'); }} hitSlop={8}>
            <Text style={styles.bannerAction}>Usa l’iPhone</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.options}>
        <Text style={styles.optionLabel}>Ragionamento (più lento)</Text>
        <Switch value={think} onValueChange={setThink} trackColor={{ true: '#1f6b52', false: '#1a2320' }} thumbColor={think ? '#2fbf8f' : '#8a9a94'} />
      </View>

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={ready ? 'Scrivi un messaggio…' : 'Attendi il modello…'}
          placeholderTextColor="#6f7f79"
          multiline
          editable={ready}
        />
        <Pressable
          style={[styles.send, busy && styles.stop, (!ready || (!busy && !input.trim())) && styles.dim]}
          onPress={busy ? stop : send}
          disabled={!ready || (!busy && !input.trim())}
        >
          <Text style={styles.sendText}>{busy ? 'Stop' : 'Invia'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ModelBar({ state }: { state: ModelState }) {
  if (state.kind === 'ready') {
    return (
      <View style={styles.modelBar}>
        <View style={[styles.dot, styles.dotOk]} />
        <Text style={styles.modelText}>{MODEL_LABEL} · sull’iPhone ({state.device}) · {CTX / 1024}k di contesto</Text>
      </View>
    );
  }
  if (state.kind === 'deleted') {
    return (
      <View style={styles.modelBar}>
        <View style={[styles.dot, styles.dotErr]} />
        <Text style={styles.modelText}>Modello dell’iPhone eliminato: riapri l’app per riscaricarlo, o usa un modello del server.</Text>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.modelBar}>
        <View style={[styles.dot, styles.dotErr]} />
        <Text style={[styles.modelText, styles.errText]} numberOfLines={3}>Modello non caricato: {state.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.modelBar}>
      <ActivityIndicator size="small" color="#2fbf8f" />
      <Text style={styles.modelText}>{state.text}{state.percent != null ? ` · ${Math.round(state.percent)}%` : ''}</Text>
      {state.percent != null && (
        <View style={styles.progress}><View style={[styles.progressFill, { width: `${state.percent}%` }]} /></View>
      )}
    </View>
  );
}

function Bubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const user = message.role === 'user';
  return (
    <View style={[styles.bubble, user ? styles.user : styles.assistant]}>
      {!!message.thinking && (
        <Pressable onPress={() => setOpen(!open)}>
          <Text style={styles.thinkingToggle}>{open ? '▾' : '▸'} Ragionamento</Text>
          {open && <Text style={styles.thinking}>{message.thinking.trim()}</Text>}
        </Pressable>
      )}
      {message.tools?.map((t) => (
        <Text key={t.id} style={[styles.toolLine, (t.status === 'error' || t.status === 'denied') && styles.toolErr]}>
          {({ running: '⏳', done: '✓', error: '⚠', denied: '✕', waiting: '❓' } as Record<string, string>)[t.status] ?? '•'} {t.label}
        </Text>
      ))}
      <Text style={styles.text} selectable>
        {message.content || (streaming ? '…' : '')}
      </Text>
      {!!message.meta && <Text style={styles.meta}>{message.meta}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#06221a', fontWeight: '800', fontSize: 18 },
  toolLine: { color: C.muted, fontSize: 12, fontFamily: 'Menlo', marginBottom: 4 },
  toolErr: { color: C.danger },
  title: { color: C.text, fontWeight: '700', fontSize: 16 },
  subtitle: { color: C.muted, fontSize: 12 },
  newChat: { color: C.accent, fontWeight: '600', fontSize: 15, marginRight: 16, marginBottom: 8 },
  hidden: { display: 'none' },
  chatTop: { flexDirection: 'row', alignItems: 'center' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 10, padding: 3, borderRadius: 10, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  tabActive: { backgroundColor: C.accentSoft },
  tabText: { color: C.muted, fontWeight: '600', fontSize: 13 },
  tabTextActive: { color: C.accent },
  chipsRow: { flexGrow: 0, marginBottom: 4 },
  tabbar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center', gap: 3, paddingBottom: 2 },
  tabLabel: { color: C.muted, fontSize: 11, fontWeight: '600' },
  tabLabelActive: { color: C.accent },
  tabBadge: { position: 'absolute', top: -4, left: '52%', minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  tabBadgeText: { color: '#06221a', fontSize: 11, fontWeight: '800' },
  tabDot: { position: 'absolute', top: 0, right: '30%', width: 7, height: 7, borderRadius: 4, backgroundColor: C.accent },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 6, padding: 10, borderRadius: 10, backgroundColor: '#2a2210', borderWidth: 1, borderColor: '#5a4718' },
  bannerText: { flex: 1, color: '#e8b04a', fontSize: 13 },
  bannerAction: { color: C.accent, fontWeight: '700', fontSize: 13 },
  chips: { paddingHorizontal: 16, gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface },
  chipActive: { borderColor: C.accent, backgroundColor: C.accentSoft },
  chipText: { color: C.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: C.accent },
  dim: { opacity: 0.4 },
  modelBar: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOk: { backgroundColor: C.accent },
  dotErr: { backgroundColor: C.danger },
  modelText: { color: C.muted, fontSize: 12, flexShrink: 1 },
  errText: { color: C.danger },
  progress: { flexBasis: '100%', height: 4, borderRadius: 2, backgroundColor: C.surface2, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: C.accent },
  messages: { padding: 16, gap: 10, flexGrow: 1 },
  empty: { color: C.muted, textAlign: 'center', marginTop: 80, lineHeight: 21, fontSize: 14 },
  bubble: { maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1 },
  user: { alignSelf: 'flex-end', backgroundColor: C.accentSoft, borderColor: '#1f4d3e' },
  assistant: { alignSelf: 'flex-start', backgroundColor: C.surface2, borderColor: C.border },
  text: { color: C.text, fontSize: 15, lineHeight: 21 },
  meta: { color: C.muted, fontSize: 11, marginTop: 6 },
  thinkingToggle: { color: C.muted, fontSize: 12, marginBottom: 4 },
  thinking: { color: C.muted, fontSize: 12, lineHeight: 17, marginBottom: 8, fontStyle: 'italic' },
  options: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 4 },
  optionLabel: { color: C.muted, fontSize: 12 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 12, paddingTop: 8 },
  input: {
    flex: 1, minHeight: 44, maxHeight: 140, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, borderRadius: 12,
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, color: C.text, fontSize: 15,
  },
  send: { height: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  stop: { backgroundColor: C.danger },
  sendText: { color: '#06221a', fontWeight: '700', fontSize: 15 },
});
