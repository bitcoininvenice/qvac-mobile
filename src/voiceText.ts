// Testo per la conversazione a voce ("Parla"): niente React qui, così si prova con
// `node --experimental-strip-types`. Pulizia per la sintesi vocale, frasi da dire appena
// pronte, eco della propria voce, sì/no a voce.

export const LANGUAGES = [
  { code: 'it-IT', label: 'Italiano', flag: '🇮🇹' },
  { code: 'en-US', label: 'English (US)', flag: '🇺🇸' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧' },
  { code: 'es-ES', label: 'Español', flag: '🇪🇸' },
  { code: 'fr-FR', label: 'Français', flag: '🇫🇷' },
  { code: 'de-DE', label: 'Deutsch', flag: '🇩🇪' },
];

type Lang = 'it' | 'en' | 'es' | 'fr' | 'de';
export const langKey = (code: string): Lang => {
  const k = code.slice(0, 2).toLowerCase();
  return (['it', 'en', 'es', 'fr', 'de'] as const).includes(k as Lang) ? (k as Lang) : 'it';
};

// Frasi brevi che l'assistente dice da sé (attese, conferme, errori), per lingua
const PHRASES: Record<Lang, {
  wait: string[]; tool: (server: string) => string; ask: (tool: string, server: string) => string;
  denied: string; confirmTimeout: string; error: string; noModel: string; busy: string; sample: (name: string) => string;
}> = {
  it: {
    wait: ['Un attimo…', 'Ci penso un secondo.', 'Vediamo…', 'Dammi un momento.'],
    tool: (s) => `Controllo su ${s}.`,
    ask: (t, s) => `Posso usare ${t} di ${s}?`,
    denied: 'Va bene, non lo uso.',
    confirmTimeout: 'Non ho sentito una risposta, quindi non lo uso.',
    error: 'Scusa, qualcosa non ha funzionato.',
    noModel: 'Non ho un modello pronto: collega il server o aspetta che il modello del telefono sia caricato.',
    busy: 'Il server sta rispondendo a un’altra chat, riprovo tra un attimo.',
    sample: (n) => `Ciao, sono ${n}. Così suona la mia voce.`,
  },
  en: {
    wait: ['One moment…', 'Let me think.', 'Let’s see…', 'Give me a second.'],
    tool: (s) => `Checking ${s}.`,
    ask: (t, s) => `May I use ${t} from ${s}?`,
    denied: 'Okay, I won’t use it.',
    confirmTimeout: 'I didn’t hear an answer, so I won’t use it.',
    error: 'Sorry, something went wrong.',
    noModel: 'No model is ready: connect your server or wait for the phone model to load.',
    busy: 'The server is busy with another chat, trying again in a moment.',
    sample: (n) => `Hi, I’m ${n}. This is how my voice sounds.`,
  },
  es: {
    wait: ['Un momento…', 'Déjame pensar.', 'A ver…'],
    tool: (s) => `Consulto ${s}.`,
    ask: (t, s) => `¿Puedo usar ${t} de ${s}?`,
    denied: 'Vale, no lo uso.',
    confirmTimeout: 'No he oído respuesta, así que no lo uso.',
    error: 'Lo siento, algo ha fallado.',
    noModel: 'No hay ningún modelo listo: conecta el servidor o espera a que cargue el modelo del teléfono.',
    busy: 'El servidor está ocupado con otro chat, lo intento de nuevo enseguida.',
    sample: (n) => `Hola, soy ${n}. Así suena mi voz.`,
  },
  fr: {
    wait: ['Un instant…', 'Je réfléchis.', 'Voyons…'],
    tool: (s) => `Je vérifie sur ${s}.`,
    ask: (t, s) => `Je peux utiliser ${t} de ${s} ?`,
    denied: 'D’accord, je ne l’utilise pas.',
    confirmTimeout: 'Je n’ai pas entendu de réponse, je ne l’utilise pas.',
    error: 'Désolé, quelque chose n’a pas marché.',
    noModel: 'Aucun modèle n’est prêt : connecte le serveur ou attends le modèle du téléphone.',
    busy: 'Le serveur répond à une autre discussion, je réessaie dans un instant.',
    sample: (n) => `Bonjour, je suis ${n}. Voici ma voix.`,
  },
  de: {
    wait: ['Einen Moment…', 'Ich überlege kurz.', 'Mal sehen…'],
    tool: (s) => `Ich schaue bei ${s} nach.`,
    ask: (t, s) => `Darf ich ${t} von ${s} benutzen?`,
    denied: 'Gut, dann nicht.',
    confirmTimeout: 'Ich habe keine Antwort gehört, also lasse ich es.',
    error: 'Entschuldigung, da ist etwas schiefgegangen.',
    noModel: 'Kein Modell bereit: verbinde den Server oder warte, bis das Modell des Telefons geladen ist.',
    busy: 'Der Server antwortet gerade in einem anderen Chat, ich versuche es gleich noch einmal.',
    sample: (n) => `Hallo, ich bin ${n}. So klingt meine Stimme.`,
  },
};
export const phrases = (code: string) => PHRASES[langKey(code)];

// A filler never repeats the previous one
let lastWait = '';
export function waitPhrase(code: string) {
  const list = phrases(code).wait.filter((p) => p !== lastWait);
  lastWait = list[Math.floor(Math.random() * list.length)];
  return lastWait;
}

const LANG_RULE: Record<Lang, string> = {
  it: 'Rispondi sempre in italiano.',
  en: 'Always answer in English.',
  es: 'Responde siempre en español.',
  fr: 'Réponds toujours en français.',
  de: 'Antworte immer auf Deutsch.',
};

// System prompt for a spoken conversation: short turns, no formatting, tools when they help
export function voiceSystemPrompt(agent: string, code: string, tools: string[]) {
  const now = new Date();
  const when = now.toLocaleString(code, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return [
    `Sei ${agent}, un assistente che parla a voce con l'utente, come in una telefonata. ${LANG_RULE[langKey(code)]}`,
    'Il tuo testo viene letto ad alta voce: frasi brevi e naturali, di solito una o due, al massimo quattro se serve davvero.',
    'Niente elenchi, tabelle, titoli, markdown, emoji o link. Scrivi orari, numeri e sigle come si dicono.',
    'Se la domanda non è chiara chiedi una precisazione breve. Se non sai una cosa dillo, non inventare.',
    tools.length
      ? `Hai degli strumenti (${tools.slice(0, 8).join(', ')}): usali quando la domanda riguarda i loro dati, poi rispondi con i dati ottenuti, in parole semplici.`
      : '',
    `Ora è ${when}.`,
  ].filter(Boolean).join(' ');
}

// Text as it should be said: no reasoning blocks, no code, no markdown, no emoji
export function cleanForSpeech(text: string) {
  return text
    .replace(/<(think|thought)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(think|thought)>[\s\S]*/gi, ' ') // still open while streaming
    .replace(/<tool_call>[\s\S]*/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*_#`>|~]+/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/([^\s.!?…:;,])[ \t]*\n+\s*(?=\S)/g, '$1. ') // a line break is a pause (lists)
    .replace(/\s+/g, ' ')
    .trimStart();
}

// The next pieces ready to be spoken, from what has not been said yet.
// A sentence ends with . ! ? … followed by a space (not "3.5", not an abbreviation like "es.").
// A long sentence still being written is cut at a comma, so the voice starts sooner.
const ABBREV = /\b(es|ecc|sig|dott|prof|ing|pag|cfr|n|nr|mr|mrs|dr|st|vs|etc|e\.g|i\.e)\.$/i;
export function takeSentences(pending: string, final: boolean): { parts: string[]; used: number } {
  const parts: string[] = [];
  let used = 0;
  const re = /[.!?…]+["»”')\]]*\s+|\n+/g;
  let m: RegExpExecArray | null;
  let start = 0;
  while ((m = re.exec(pending))) {
    const end = m.index + m[0].length;
    const piece = pending.slice(start, end).trim();
    if (ABBREV.test(pending.slice(start, m.index + m[0].trimEnd().length))) continue; // "es. " is not an end
    if (piece.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) parts.push(piece);
    start = end;
    used = end;
  }
  const rest = pending.slice(start);
  if (final) {
    if (rest.trim().replace(/[^\p{L}\p{N}]/gu, '').length >= 1) parts.push(rest.trim());
    used = pending.length;
  } else if (!parts.length && rest.length > 140) {
    // first words of a long sentence: say them up to the last comma
    const comma = Math.max(rest.lastIndexOf(', '), rest.lastIndexOf('; '), rest.lastIndexOf(': '));
    if (comma > 50) {
      parts.push(rest.slice(0, comma + 1).trim());
      used = start + comma + 2;
    }
  }
  return { parts, used };
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
export const words = (s: string) => norm(s).split(/\s+/).filter(Boolean);

const STOP_WORDS = new Set(['stop', 'basta', 'aspetta', 'fermati', 'zitto', 'zitta', 'scusa', 'wait', 'espera', 'attends', 'warte', 'halt']);

// While the assistant speaks, the microphone also hears it. Words the user says that are
// not in what the assistant said (or a clear "stop") mean an interruption.
export function isInterruption(heard: string, spoken: Set<string>) {
  const w = words(heard);
  if (w.some((x) => STOP_WORDS.has(x) && !spoken.has(x))) return true;
  const fresh = w.filter((x) => x.length > 2 && !spoken.has(x));
  return fresh.length >= 2;
}

const YES = new Set(['si', 'certo', 'ok', 'okay', 'vai', 'procedi', 'consenti', 'usalo', 'pure', 'yes', 'yeah', 'sure', 'yep', 'claro', 'oui', 'ja', 'genau', 'dacordo']);
const NO = new Set(['no', 'nope', 'annulla', 'rifiuta', 'lascia', 'non', 'nein', 'non', 'niente', 'negativo']);

// "sì" / "no" in the user's answer to a question (ignoring words of the question itself)
export function yesNo(heard: string, asked = ''): boolean | null {
  const q = new Set(words(asked));
  const w = words(heard).filter((x) => !q.has(x) || x === 'si' || x === 'no');
  const joined = w.join(' ');
  if (/\b(va bene|d accordo|vai pure|fallo)\b/.test(joined)) return true;
  const yes = w.some((x) => YES.has(x));
  const no = w.some((x) => NO.has(x));
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}
