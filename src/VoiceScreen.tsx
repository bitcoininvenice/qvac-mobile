// "Parla": una conversazione a voce, a mani libere, come una telefonata.
//
// - Ascolta di continuo (SFSpeechRecognizer, sul dispositivo se impostato) e capisce da sola
//   quando hai finito di parlare (pausa regolabile in Impostazioni → Parla).
// - Risponde in streaming: ogni frase viene detta appena è pronta, una dopo l'altra senza buchi.
// - Puoi interromperla parlando: il microfono resta acceso mentre parla (con cancellazione
//   dell'eco), e la sua stessa voce non conta come interruzione.
// - Ricorda la conversazione (ultimi scambi) finché non tocchi "Nuova".
// - Usa i connettori come la Chat: quelli del server li gestisce il server, quelli del
//   telefono li esegue il telefono; gli strumenti "da confermare" li chiede a voce (sì / no).
//
// Tutto lo stato del motore vive in un ref (E): i gestori di eventi e i timer non leggono mai
// uno stato React vecchio. Lo stato React serve solo a disegnare.
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import * as Speech from 'expo-speech';
import { completion, cancel as cancelLocal } from '@qvac/sdk';
import { chatOnMac, macLabel, pathShort, store as p2pStore, useP2P } from './p2p';
import { callPhoneTool, phoneToolsForModel } from './connectors';
import { LOCAL_MODEL, local, useLocal } from './local';
import { getSettings, tap, useSettings } from './settings';
import { LANGUAGES, cleanForSpeech, isInterruption, phrases, takeSentences, voiceSystemPrompt, waitPhrase, words, yesNo } from './voiceText';
import { C } from './theme';
import type { Go } from './Home';

type Phase = 'starting' | 'listening' | 'thinking' | 'speaking' | 'confirm' | 'paused' | 'error';
type ToolLine = { id: string; label: string; status: string };
type Turn = { id: string; role: 'user' | 'assistant'; text: string; tools?: ToolLine[]; interrupted?: boolean };
type Target =
  | { kind: 'server'; mac: string; model: string; label: string }
  | { kind: 'local'; label: string };

const NUM_BARS = 22;
const REMOTE_CTX = 8192; // come la Chat: il server non ricarica il modello passando da una all'altra
const HISTORY_TURNS = 12; // messaggi ricordati (utente + assistente)
const PAUSE_MS = { short: 650, normal: 1000, long: 1600 };
const WAIT_MS = 1400; // nessuna voce dopo questo tempo → una breve frase d'attesa
const CONFIRM_MS = 25000;
const COLORS: Record<Phase, string> = {
  starting: '#6ee7b7', listening: '#34d399', thinking: '#fbbf24', speaking: '#38bdf8', confirm: '#f59e0b', paused: '#6b7280', error: C.danger,
};
const newId = () => Math.random().toString(36).slice(2, 10);
const ANDROID = Platform.OS === 'android';
const NO_PERMISSION = ANDROID
  ? 'Serve il permesso del microfono: Impostazioni di Android → App → QVAC-BOARD → Autorizzazioni.'
  : 'Serve il permesso del microfono e del riconoscimento vocale: Impostazioni di iOS → QVAC-BOARD.';
const noOnDevice = (lang: string) => ANDROID
  ? `Il riconoscimento offline per ${lang} non è installato. Scaricalo nelle impostazioni del riconoscimento vocale di Google (Lingue offline), oppure consenti il riconoscimento online in Impostazioni → Parla.`
  : `Il riconoscimento sul dispositivo per ${lang} non è disponibile. Scarica la lingua in Impostazioni di iOS → Generali → Tastiera → Dettatura, oppure consenti il riconoscimento di Apple in Impostazioni → Parla.`;

// Which model answers: the default of Impostazioni → Chat, else whatever is available
function pickTarget(): Target | null {
  const s = getSettings();
  const online = (mac: string) => Boolean(p2pStore.status[mac]?.online);
  const server = (mac: string, model?: string): Target | null => {
    const m = p2pStore.macs.find((x) => x.mac === mac);
    const models = p2pStore.status[mac]?.models ?? [];
    const chosen = models.find((x) => x.id === model) ?? models[0];
    return m && chosen ? { kind: 'server', mac, model: chosen.id, label: `${macLabel(m)} · ${chosen.label.split(' — ')[0]}` } : null;
  };
  const localReady = local.state.kind === 'ready' && Boolean(local.modelId);
  const localTarget: Target = { kind: 'local', label: `${LOCAL_MODEL.label} sul telefono` };
  if (s.defaultModel !== 'local') {
    const [mac, model] = s.defaultModel.split('|');
    if (mac && online(mac)) { const t = server(mac, model); if (t) return t; }
    if (localReady && s.fallbackLocal) return localTarget;
  } else if (localReady) return localTarget;
  const any = p2pStore.macs.find((m) => online(m.mac));
  if (any) { const t = server(any.mac); if (t) return t; }
  return localReady ? localTarget : null;
}

export default function VoiceScreen({ go }: { go?: Go }) {
  const p2p = useP2P();
  useLocal();
  const settings = useSettings();
  const agent = settings.agentName || 'Aura';
  const lang = settings.language || 'it-IT';
  const langObj = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  const [phase, setPhaseState] = useState<Phase>('starting');
  const [live, setLive] = useState(''); // what you are saying now
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState(''); // e.g. "Il server carica il modello…", or an error
  const [confirm, setConfirm] = useState<{ question: string } | null>(null);
  const bars = useRef(Array.from({ length: NUM_BARS }, () => new Animated.Value(0.12))).current;
  const scroll = useRef<ScrollViewInstance>(null);

  // ---------- engine state ----------
  const E = useRef({
    phase: 'starting' as Phase,
    mounted: true,
    active: true, // conversation on (not paused)
    background: false,
    fatal: '', // the recognizer cannot work (permission, language): no automatic restart
    listening: false,
    starting: false,
    failures: 0,
    restartTimer: null as ReturnType<typeof setTimeout> | null,
    endTimer: null as ReturnType<typeof setTimeout> | null,
    heard: '',
    lastText: '', // last transcript, whatever the phase
    turnWords: 0, // words in the transcript when your turn was sent
    userTurnId: '',
    confirmBase: 0, // transcript words before the yes/no question
    level: 0, // microphone level, for the bars
    gen: 0, // every answer has its number: late events of an older one are ignored
    chat: null as null | { cancel: () => void },
    answer: '', // raw text of the answer being written
    used: 0, // characters of the cleaned answer already handed to the voice
    genDone: false,
    pending: 0, // utterances queued in the synthesizer
    audioStarted: false,
    toolSaid: false,
    spoken: new Set<string>(), // words the assistant said in this answer (to recognise its own echo)
    waitTimer: null as ReturnType<typeof setTimeout> | null,
    turnId: '',
    history: [] as { role: 'user' | 'assistant'; content: string }[],
    confirm: null as null | { question: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> },
    confirmChain: Promise.resolve() as Promise<unknown>,
  }).current;

  const setPhase = (p: Phase) => {
    E.phase = p;
    setPhaseState(p);
  };
  const updateTurn = (id: string, fn: (t: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
  const addTurn = (t: Turn) => setTurns((prev) => [...prev, t].slice(-30));

  // ---------- microphone ----------

  const wantsMic = () => {
    if (!E.active || E.background || !E.mounted || E.fatal) return false;
    if (E.phase === 'listening' || E.phase === 'confirm') return true;
    // With "Interrompi parlando" the microphone stays on for the whole exchange
    return (E.phase === 'thinking' || E.phase === 'speaking') && getSettings().voiceBargeIn;
  };

  const startRecognition = () => {
    if (!wantsMic() || E.listening || E.starting) return;
    const s = getSettings();
    E.starting = true;
    E.heard = '';
    try {
      ExpoSpeechRecognitionModule.start({
        lang: s.language || 'it-IT',
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: s.voiceOnDevice,
        // echo cancellation: needed to hear you while the assistant speaks
        iosVoiceProcessingEnabled: s.voiceBargeIn,
        iosCategory: { category: 'playAndRecord', categoryOptions: ['defaultToSpeaker', 'allowBluetooth'], mode: 'default' },
        contextualStrings: [s.agentName || 'Aura', ...phoneToolsForModel().tools.map((t) => t.description.match(/^\[([^,\]]+)/)?.[1] ?? '').filter(Boolean)].slice(0, 20),
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      });
    } catch {
      E.starting = false;
      scheduleRestart(1000);
    }
  };

  const scheduleRestart = (ms: number) => {
    if (E.restartTimer) clearTimeout(E.restartTimer);
    E.restartTimer = setTimeout(() => { E.restartTimer = null; startRecognition(); }, ms);
  };

  // Stop the recognizer; it starts again by itself if the conversation needs the microphone
  const stopRecognition = () => {
    if (E.listening || E.starting) {
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* già fermo */ }
    } else startRecognition();
  };

  useSpeechRecognitionEvent('start', () => {
    E.starting = false;
    E.listening = true;
  });

  useSpeechRecognitionEvent('end', () => {
    E.starting = false;
    E.listening = false;
    if (E.phase === 'listening' && E.heard.trim()) return finishTurn();
    if (wantsMic()) scheduleRestart(Math.min(250 * 2 ** E.failures, 8000));
  });

  useSpeechRecognitionEvent('error', (e) => {
    if (e.error === 'aborted' || e.error === 'no-speech') return; // 'end' follows and restarts
    if (e.error === 'not-allowed') E.fatal = NO_PERMISSION;
    else if (e.error === 'language-not-supported' || e.error === 'service-not-allowed') {
      E.fatal = getSettings().voiceOnDevice
        ? noOnDevice(langObj.label)
        : `Il riconoscimento vocale per ${langObj.label} non è disponibile su questo telefono.`;
    } else {
      E.failures = Math.min(E.failures + 1, 5);
      if (e.error === 'network') setNote(`Riconoscimento online ${ANDROID ? 'di Google' : 'di Apple'} non raggiungibile: senza rete serve quello sul dispositivo (Impostazioni → Parla).`);
      return;
    }
    setNote(E.fatal);
    setPhase('error');
  });

  useSpeechRecognitionEvent('volumechange', (e) => {
    E.level = Math.max(0, Math.min(1, ((e.value ?? -2) + 2) / 10));
  });

  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results?.[0]?.transcript ?? '';
    if (!text) return;
    E.failures = 0;
    E.lastText = text;
    if (E.phase === 'listening') {
      E.heard = text;
      setLive(text);
      // You stopped talking: answer after a pause (a bit longer if the sentence looks unfinished)
      if (E.endTimer) clearTimeout(E.endTimer);
      const base = PAUSE_MS[getSettings().voicePause] ?? PAUSE_MS.normal;
      E.endTimer = setTimeout(finishTurn, /[.!?…]$/.test(text.trim()) ? base : base + 350);
      if (e.isFinal) finishTurn();
    } else if (E.phase === 'thinking') {
      // You went on talking before the answer started (the pause was too short): same turn
      if (getSettings().voiceBargeIn && !E.audioStarted && words(text).length > E.turnWords) resumeTurn(text);
    } else if (E.phase === 'speaking') {
      if (getSettings().voiceBargeIn && isInterruption(text, E.spoken)) interrupt();
    } else if (E.phase === 'confirm' && E.confirm) {
      const v = yesNo(words(text).slice(E.confirmBase).join(' '), E.confirm.question);
      if (v !== null) answerConfirm(v);
    }
  });

  // ---------- turns ----------

  function finishTurn() {
    if (E.endTimer) { clearTimeout(E.endTimer); E.endTimer = null; }
    const text = E.heard.trim();
    E.heard = '';
    setLive('');
    if (E.phase !== 'listening' || text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return;
    setPhase('thinking');
    // Without "Interrompi parlando" the microphone rests while the assistant answers
    if (!getSettings().voiceBargeIn) stopRecognition();
    E.turnWords = words(E.lastText || text).length;
    tap();
    E.userTurnId = newId();
    addTurn({ id: E.userTurnId, role: 'user', text });
    ask(text);
  }

  // The rest of your sentence arrived after it was sent: drop the answer just started, keep listening
  function resumeTurn(text: string) {
    E.gen++;
    if (E.waitTimer) { clearTimeout(E.waitTimer); E.waitTimer = null; }
    E.chat?.cancel();
    E.chat = null;
    const drop = new Set([E.turnId, E.userTurnId]);
    setTurns((prev) => prev.filter((t) => !drop.has(t.id)));
    if (E.history[E.history.length - 1]?.role === 'user') E.history.pop();
    setPhase('listening');
    E.heard = text;
    setLive(text);
    if (E.endTimer) clearTimeout(E.endTimer);
    E.endTimer = setTimeout(finishTurn, (PAUSE_MS[getSettings().voicePause] ?? PAUSE_MS.normal) + 350);
  }

  function ask(text: string) {
    const gen = ++E.gen;
    E.answer = '';
    E.used = 0;
    E.genDone = false;
    E.pending = 0;
    E.audioStarted = false;
    E.toolSaid = false;
    E.spoken = new Set(words(E.lastText || text)); // your own words are not an interruption
    E.turnId = newId();
    setNote('');
    addTurn({ id: E.turnId, role: 'assistant', text: '', tools: [] });
    E.history.push({ role: 'user', content: text });
    E.history = E.history.slice(-HISTORY_TURNS);
    if (E.waitTimer) clearTimeout(E.waitTimer);
    E.waitTimer = setTimeout(() => {
      if (gen === E.gen && !E.audioStarted && E.phase === 'thinking') say(waitPhrase(lang), gen, { filler: true });
    }, WAIT_MS);
    const target = pickTarget();
    if (!target) return fail(gen, phrases(lang).noModel);
    if (target.kind === 'server') runServer(gen, target, 0);
    else runLocal(gen);
  }

  function messagesFor(target: Target) {
    const phone = phoneToolsForModel();
    const system = voiceSystemPrompt(agent, lang, [...new Set(phone.tools.map((t) => t.description.match(/^\[([^,\]]+)/)?.[1] ?? ''))].filter(Boolean));
    const keep = target.kind === 'local' ? 6 : HISTORY_TURNS; // the phone's model has a small context
    const history = E.history.slice(-keep).map((m, i, all) => (i === all.length - 1 && m.role === 'user' ? { ...m, content: `${m.content} /no_think` } : m));
    return [{ role: 'system', content: system }, ...history];
  }

  function runServer(gen: number, target: Extract<Target, { kind: 'server' }>, tries: number) {
    const phone = phoneToolsForModel();
    const req = chatOnMac(target.mac, target.model, messagesFor(target), REMOTE_CTX, (ev) => {
      if (gen !== E.gen) return;
      if (ev.kind === 'token') { E.answer += ev.text; feed(gen, false); }
      else if (ev.kind === 'status') setNote(ev.text ?? '');
      else if (ev.kind === 'tool') {
        const line = { id: ev.callId, label: `${ev.server} › ${ev.tool}`, status: ev.status };
        updateTurn(E.turnId, (t) => ({ ...t, tools: [...(t.tools ?? []).filter((x) => x.id !== ev.callId), line] }));
        if (ev.status === 'running' && !E.toolSaid && !E.audioStarted) {
          E.toolSaid = true;
          say(phrases(lang).tool(ev.server), gen, { filler: true });
        }
      } else if (ev.kind === 'phonecall') {
        const t = phone.resolve(ev.tool);
        if (!t) { req.phoneResult(ev.callId, { isError: true, text: 'Strumento non disponibile su questo dispositivo' }); return; }
        const line = { id: ev.callId, label: `${t.server} › ${t.tool}`, status: 'running' };
        updateTurn(E.turnId, (x) => ({ ...x, tools: [...(x.tools ?? []).filter((y) => y.id !== ev.callId), line] }));
        const run = async () => {
          try {
            const r = await callPhoneTool(t.server, t.tool, ev.args);
            req.phoneResult(ev.callId, r);
            updateTurn(E.turnId, (x) => ({ ...x, tools: (x.tools ?? []).map((y) => (y.id === ev.callId ? { ...y, status: r.isError ? 'error' : 'done' } : y)) }));
          } catch (err) {
            req.phoneResult(ev.callId, { isError: true, text: (err as Error).message });
          }
        };
        // Same rules as the Chat: "Chiedi" means asking you first (here, by voice)
        if (t.permission === 'ask') {
          askConfirm(gen, t.tool, t.server).then((ok) => {
            if (ok) run();
            else {
              req.phoneResult(ev.callId, { denied: true, text: '' });
              updateTurn(E.turnId, (x) => ({ ...x, tools: (x.tools ?? []).map((y) => (y.id === ev.callId ? { ...y, status: 'denied' } : y)) }));
            }
          });
        } else run();
      } else if (ev.kind === 'confirm') {
        askConfirm(gen, ev.tool, ev.server).then((ok) => req.confirm(ev.callId, ok));
      } else if (ev.kind === 'done') {
        feed(gen, true);
      } else if (ev.kind === 'error') {
        // Right after an interruption the server may still be closing the previous answer
        if (/già rispondendo/i.test(ev.error) && tries < 4) {
          setTimeout(() => { if (gen === E.gen) runServer(gen, target, tries + 1); }, 700);
          return;
        }
        fail(gen, ev.error);
      }
    }, phone.tools);
    E.chat = { cancel: req.cancel };
  }

  function runLocal(gen: number) {
    if (!local.modelId) return fail(gen, phrases(lang).noModel);
    const run = completion({ modelId: local.modelId, history: messagesFor({ kind: 'local', label: '' }), stream: true } as any);
    E.chat = { cancel: () => { cancelLocal({ requestId: run.requestId }).catch(() => { }); } };
    (async () => {
      try {
        for await (const ev of run.events as AsyncIterable<any>) {
          if (gen !== E.gen) return;
          if (ev.type === 'contentDelta' && ev.text) { E.answer += ev.text; feed(gen, false); }
        }
        if (gen === E.gen) feed(gen, true);
      } catch (err) {
        if (gen === E.gen) fail(gen, (err as Error).message);
      }
    })();
  }

  // New text from the model: show it, and hand finished sentences to the voice
  function feed(gen: number, final: boolean) {
    if (gen !== E.gen) return;
    const clean = cleanForSpeech(E.answer);
    updateTurn(E.turnId, (t) => ({ ...t, text: clean.trim() }));
    const { parts, used } = takeSentences(clean.slice(E.used), final);
    E.used += used;
    for (const p of parts) say(p, gen);
    if (final) {
      E.genDone = true;
      E.chat = null;
      if (!clean.trim() && !E.pending) return answerFinished(gen);
      if (!E.pending) answerFinished(gen);
    }
  }

  function fail(gen: number, error: string) {
    if (gen !== E.gen) return;
    setNote(error);
    E.answer = '';
    E.genDone = true;
    E.chat = null;
    say(phrases(lang).error, gen, { filler: true });
  }

  // One utterance, queued in the synthesizer (they play back to back, no gaps)
  function say(text: string, gen: number, _kind: { filler?: boolean } = {}) {
    if (gen !== E.gen || !text.trim()) return;
    const s = getSettings();
    if (E.waitTimer) { clearTimeout(E.waitTimer); E.waitTimer = null; }
    E.pending++;
    E.audioStarted = true;
    for (const w of words(text)) E.spoken.add(w);
    if (E.phase === 'thinking') {
      setPhase('speaking');
      if (s.voiceBargeIn) startRecognition();
    }
    const done = () => {
      if (gen !== E.gen) return;
      E.pending = Math.max(0, E.pending - 1);
      if (!E.pending && E.genDone) answerFinished(gen);
    };
    Speech.speak(text, {
      language: s.language || 'it-IT',
      voice: s.voiceIdentifier || undefined,
      rate: s.voiceSpeed || 1,
      pitch: 1,
      onDone: done,
      onError: done,
    });
  }

  // The answer has been said: your turn
  function answerFinished(gen: number) {
    if (gen !== E.gen) return;
    const clean = cleanForSpeech(E.answer).trim();
    if (clean) E.history.push({ role: 'assistant', content: clean });
    E.history = E.history.slice(-HISTORY_TURNS);
    if (!clean) setTurns((prev) => prev.filter((t) => t.id !== E.turnId || t.text || t.tools?.length));
    E.chat = null;
    E.heard = '';
    E.lastText = '';
    setPhase('listening');
    stopRecognition(); // fresh transcript, without the assistant's own words
  }

  // You spoke over the assistant (or tapped): it stops at once and listens
  function interrupt() {
    const said = cleanForSpeech(E.answer).slice(0, E.used).trim();
    E.gen++;
    if (E.waitTimer) { clearTimeout(E.waitTimer); E.waitTimer = null; }
    E.chat?.cancel();
    E.chat = null;
    Speech.stop();
    E.pending = 0;
    E.genDone = false;
    if (E.confirm) answerConfirm(false, true);
    if (said) E.history.push({ role: 'assistant', content: `${said} …` });
    E.history = E.history.slice(-HISTORY_TURNS);
    const id = E.turnId;
    updateTurn(id, (t) => ({ ...t, text: said || t.text, interrupted: true }));
    E.heard = '';
    E.lastText = '';
    setLive('');
    tap('select');
    setPhase('listening');
    stopRecognition();
  }

  // ---------- "may I use this tool?" by voice ----------

  function askConfirm(gen: number, tool: string, server: string): Promise<boolean> {
    const next = E.confirmChain.then(() => new Promise<boolean>((resolve) => {
      if (gen !== E.gen) return resolve(false);
      const question = phrases(lang).ask(tool.replace(/[_-]+/g, ' '), server);
      const timer = setTimeout(() => {
        if (E.confirm?.timer === timer) { say(phrases(lang).confirmTimeout, gen, { filler: true }); answerConfirm(false); }
      }, CONFIRM_MS);
      E.confirm = { question, resolve, timer };
      E.confirmBase = words(E.lastText).length; // only what you say from now on counts
      setConfirm({ question });
      tap('warning');
      for (const w of words(question)) E.spoken.add(w);
      setPhase('confirm');
      const st = getSettings();
      Speech.speak(question, { language: st.language || 'it-IT', voice: st.voiceIdentifier || undefined, rate: st.voiceSpeed || 1 });
      startRecognition();
    }));
    E.confirmChain = next.catch(() => false);
    return next;
  }

  function answerConfirm(ok: boolean, silent = false) {
    const c = E.confirm;
    if (!c) return;
    E.confirm = null;
    clearTimeout(c.timer);
    setConfirm(null);
    // your "sì" / "no" is not an interruption, nor the rest of your previous turn
    for (const w of words(E.lastText)) E.spoken.add(w);
    E.turnWords = words(E.lastText).length;
    if (E.phase === 'confirm') {
      setPhase(E.audioStarted ? 'speaking' : 'thinking');
      if (!getSettings().voiceBargeIn) stopRecognition();
    }
    if (!ok && !silent) say(phrases(lang).denied, E.gen, { filler: true });
    tap(ok ? 'success' : 'select');
    c.resolve(ok);
  }

  // ---------- controls ----------

  const stopAll = () => {
    E.gen++;
    if (E.waitTimer) clearTimeout(E.waitTimer);
    if (E.endTimer) clearTimeout(E.endTimer);
    if (E.restartTimer) clearTimeout(E.restartTimer);
    E.chat?.cancel();
    E.chat = null;
    if (E.confirm) answerConfirm(false, true);
    Speech.stop();
    E.pending = 0;
    E.heard = '';
    setLive('');
    try { ExpoSpeechRecognitionModule.abort(); } catch { /* già fermo */ }
  };

  const pause = () => {
    E.active = false;
    stopAll();
    setPhase('paused');
  };

  const resume = () => {
    E.active = true;
    E.fatal = '';
    E.failures = 0;
    setNote('');
    setPhase('listening');
    startRecognition();
  };

  // The big button: send now / interrupt / resume
  const onMain = () => {
    tap();
    if (E.phase === 'paused' || E.phase === 'error') return resume();
    if (E.phase === 'listening') { if (E.heard.trim()) finishTurn(); return; }
    if (E.phase === 'thinking' || E.phase === 'speaking') interrupt();
  };

  const newConversation = () => {
    tap();
    stopAll();
    E.history = [];
    setTurns([]);
    setNote('');
    if (E.active) { setPhase('listening'); startRecognition(); } else setPhase('paused');
  };

  // ---------- lifecycle ----------

  useEffect(() => {
    E.mounted = true;
    (async () => {
      try {
        const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!E.mounted) return;
        if (!perm.granted) {
          E.fatal = NO_PERMISSION;
          setNote(E.fatal);
          return setPhase('error');
        }
        if (getSettings().voiceOnDevice && !ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
          setNote(`Questo telefono non riconosce la voce sul dispositivo: in Impostazioni → Parla puoi consentire il riconoscimento ${ANDROID ? 'online di Google' : 'di Apple'}.`);
        }
        setPhase('listening');
        startRecognition();
      } catch (err) {
        setNote(`Microfono non disponibile: ${(err as Error).message}`);
        setPhase('error');
      }
    })();
    // App in background: everything stops; back in the foreground, it listens again
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') {
        E.background = true;
        stopAll();
        if (E.active && E.phase !== 'error') setPhase('listening');
      } else if (st === 'active' && E.background) {
        E.background = false;
        if (E.active && !E.fatal) { setPhase('listening'); startRecognition(); }
      }
    });
    return () => {
      E.mounted = false;
      sub.remove();
      stopAll();
    };
  }, []);

  // A new language or recognition option: restart the recognizer with it
  useEffect(() => {
    if (E.listening || E.starting) stopRecognition();
  }, [settings.language, settings.voiceOnDevice, settings.voiceBargeIn]);

  // The bars: your voice while listening, a wave while speaking, a slow breath while thinking
  useEffect(() => {
    const t = setInterval(() => {
      const ph = E.phase;
      const now = Date.now();
      E.level *= 0.8;
      bars.forEach((a, i) => {
        let v = 0.12;
        if (ph === 'listening' || ph === 'confirm') {
          const center = 1 - (Math.abs(i - NUM_BARS / 2) / (NUM_BARS / 2)) * 0.45;
          v = Math.max(0.12, Math.min(1, E.level * 1.6 * center * (0.75 + Math.random() * 0.5)));
        } else if (ph === 'speaking') v = 0.18 + ((Math.sin(now / 130 + i * 0.35) + 1) / 2) * 0.7;
        else if (ph === 'thinking') v = 0.14 + ((Math.sin(now / 380 + i * 0.45) + 1) / 2) * 0.14;
        Animated.timing(a, { toValue: v, duration: 90, useNativeDriver: true }).start();
      });
    }, 90);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60); }, [turns, live]);

  // ---------- view ----------

  const target = pickTarget();
  const color = COLORS[phase];
  const via = target?.kind === 'server' ? pathShort(p2p.status[target.mac]?.via) : '';
  const status = {
    starting: 'Avvio del microfono…',
    listening: live ? 'Ti ascolto…' : 'Parla pure, ti ascolto',
    thinking: `${agent} ci pensa…`,
    speaking: settings.voiceBargeIn ? `${agent} parla · interrompila quando vuoi` : `${agent} parla`,
    confirm: 'Rispondi “sì” o “no”',
    paused: 'Conversazione in pausa',
    error: 'Il microfono non è attivo',
  }[phase];
  const mainLabel = {
    starting: 'Un momento…',
    listening: live ? 'Tocca per rispondere subito' : 'In ascolto',
    thinking: 'Tocca per interrompere',
    speaking: 'Tocca per interrompere',
    confirm: 'Rispondi a voce o con i pulsanti',
    paused: 'Tocca per riprendere',
    error: 'Tocca per riprovare',
  }[phase];

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View style={styles.serverPill}>
          <View style={[styles.statusDot, { backgroundColor: target ? '#34d399' : '#6b7280' }]} />
          <Text style={styles.serverText} numberOfLines={1}>
            {target ? `${target.kind === 'server' ? '💻' : '📱'} ${target.label}${via ? ` · ${via}` : ''}` : 'Nessun modello pronto'}
          </Text>
        </View>
        <Pressable style={styles.agentBadge} onPress={() => { tap(); go?.('settings', { page: 'voice' }); }}>
          <Text style={styles.agentName}>{agent}</Text>
          <Text style={styles.agentDivider}>·</Text>
          <Text style={styles.voiceLabel}>{langObj.flag} {settings.voice || langObj.label}</Text>
        </Pressable>
      </View>

      <ScrollView ref={scroll} style={styles.flex} contentContainerStyle={styles.turns}>
        {!turns.length && !live && (
          <Text style={styles.hint}>
            Parla come al telefono: {agent} capisce da sola quando hai finito, risponde a voce e puoi interromperla in qualsiasi momento. Ricorda quello che vi siete detti finché non tocchi “Nuova”.
          </Text>
        )}
        {turns.map((t) => (
          <View key={t.id} style={[styles.bubble, t.role === 'user' ? styles.bubbleUser : styles.bubbleAgent]}>
            {!!t.tools?.length && t.tools.map((x) => (
              <Text key={x.id} style={styles.tool}>
                {x.status === 'running' || x.status === 'waiting' ? '⏳' : x.status === 'done' ? '🔧' : x.status === 'denied' ? '🚫' : '⚠️'} {x.label}
              </Text>
            ))}
            {!!t.text && <Text style={styles.bubbleText}>{t.text}{t.interrupted ? ' …' : ''}</Text>}
            {!t.text && t.role === 'assistant' && !t.tools?.length && <Text style={styles.typing}>…</Text>}
          </View>
        ))}
        {!!live && (
          <View style={[styles.bubble, styles.bubbleUser, styles.bubbleLive]}>
            <Text style={styles.bubbleText}>{live}</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.waveformArea}>
        <Pressable onPress={onMain} style={styles.waveformCard} accessibilityRole="button" accessibilityLabel={mainLabel}>
          <View style={styles.barsRow}>
            {bars.map((anim, idx) => (
              <Animated.View key={idx} style={[styles.waveformBar, { backgroundColor: color, transform: [{ scaleY: anim }] }]} />
            ))}
          </View>
        </Pressable>
        <View style={styles.statusRow}>
          <View style={[styles.pulseIndicator, { backgroundColor: color }]} />
          <Text style={[styles.statusText, { color }]}>{status}</Text>
        </View>
        {!!note && <Text style={[styles.note, phase === 'error' && styles.noteError]}>{note}</Text>}
        {confirm && (
          <View style={styles.confirmCard}>
            <Text style={styles.confirmText}>{confirm.question}</Text>
            <View style={styles.confirmRow}>
              <Pressable style={[styles.confirmBtn, styles.confirmNo]} onPress={() => answerConfirm(false)}><Text style={styles.confirmBtnText}>No</Text></Pressable>
              <Pressable style={[styles.confirmBtn, styles.confirmYes]} onPress={() => answerConfirm(true)}><Text style={[styles.confirmBtnText, styles.confirmYesText]}>Sì</Text></Pressable>
            </View>
          </View>
        )}
      </View>

      <View style={styles.controlsBar}>
        <Pressable style={[styles.sideBtn]} onPress={newConversation} disabled={!turns.length}>
          <Text style={[styles.sideText, !turns.length && styles.dim]}>Nuova</Text>
        </Pressable>
        <Pressable style={[styles.mainTalkBtn, phase === 'paused' && styles.mainTalkBtnPaused]} onPress={onMain}>
          <View style={[styles.btnDot, { backgroundColor: color }]} />
          <Text style={styles.btnText}>{mainLabel}</Text>
        </Pressable>
        <Pressable style={styles.sideBtn} onPress={() => { tap(); if (phase === 'paused') resume(); else pause(); }}>
          <Text style={styles.sideText}>{phase === 'paused' ? 'Riprendi' : 'Pausa'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 8 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  serverPill: {
    flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: C.surface, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1, borderColor: C.border, flexShrink: 1,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  serverText: { color: C.text, fontSize: 12, fontWeight: '500', flexShrink: 1 },
  agentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1, borderColor: C.border,
  },
  agentName: { color: C.accent, fontSize: 12, fontWeight: '700' },
  agentDivider: { color: C.muted, fontSize: 12 },
  voiceLabel: { color: C.muted, fontSize: 12 },
  turns: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, flexGrow: 1, justifyContent: 'flex-end' },
  hint: { color: C.muted, fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 12 },
  bubble: { maxWidth: '86%', paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16, gap: 4 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: C.accentSoft, borderBottomRightRadius: 4 },
  bubbleAgent: { alignSelf: 'flex-start', backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, borderBottomLeftRadius: 4 },
  bubbleLive: { opacity: 0.7 },
  bubbleText: { color: C.text, fontSize: 15, lineHeight: 21 },
  typing: { color: C.muted, fontSize: 18 },
  tool: { color: C.muted, fontSize: 12 },
  waveformArea: { alignItems: 'center', paddingHorizontal: 20, paddingTop: 6, gap: 10 },
  waveformCard: {
    width: '100%', maxWidth: 300, height: 96, backgroundColor: '#050706', borderRadius: 28, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 12, elevation: 6,
  },
  barsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: '100%' },
  waveformBar: { width: 6, height: '100%', borderRadius: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pulseIndicator: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: '600', letterSpacing: 0.5 },
  note: { color: C.muted, fontSize: 12, textAlign: 'center', lineHeight: 17 },
  noteError: { color: C.danger },
  confirmCard: { width: '100%', padding: 12, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: '#5c4515', gap: 10 },
  confirmText: { color: C.text, fontSize: 15, textAlign: 'center' },
  confirmRow: { flexDirection: 'row', gap: 10 },
  confirmBtn: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  confirmNo: { borderColor: C.border },
  confirmYes: { backgroundColor: C.accent, borderColor: C.accent },
  confirmBtnText: { color: C.text, fontWeight: '700', fontSize: 15 },
  confirmYesText: { color: '#06221a' },
  controlsBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  mainTalkBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 54, borderRadius: 16,
    backgroundColor: C.surface, borderWidth: 1, borderColor: '#1f4d3e',
  },
  mainTalkBtnPaused: { borderColor: C.border, backgroundColor: C.surface2 },
  btnDot: { width: 9, height: 9, borderRadius: 5 },
  btnText: { color: C.text, fontSize: 13, fontWeight: '600' },
  sideBtn: { height: 54, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  sideText: { color: C.text, fontSize: 13, fontWeight: '600' },
  dim: { opacity: 0.4 },
});
