// The iPhone's own connectors: remote MCP servers the phone talks to directly
// (HTTPS), without going through the desktop. Saved in the Keychain, since they
// may contain access tokens.
//
// Who decides when to use them:
//  - in a chat with a desktop model, the desktop sees these tools too and asks the
//    phone to run them (the service only ever talks to the phone);
//  - in a chat with the iPhone's model, the phone does everything by itself.
import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { RemoteMcpClient, type McpTool } from './mcpClient';

export type Permission = 'auto' | 'ask' | 'off';
export type PhoneConnector = {
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  perms: Record<string, Permission>;
};
export type ConnectorState = {
  state: 'off' | 'connecting' | 'connected' | 'error';
  error?: string;
  tools: McpTool[];
  serverInfo?: { name?: string; title?: string; version?: string } | null;
  instructions?: string | null;
};

const KEY = 'qvac-phone-connectors';
const MAX_RESULT_CHARS = 6000;
const validName = (n: string) => /^[a-zA-Z0-9_-]{1,32}$/.test(n);

let list: PhoneConnector[] = [];
const clients = new Map<string, RemoteMcpClient>();
const states = new Map<string, ConnectorState>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
let loaded: Promise<void> | null = null;

async function save() {
  await SecureStore.setItemAsync(KEY, JSON.stringify(list));
}

export function loadConnectors() {
  loaded ??= (async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      list = raw ? JSON.parse(raw) : [];
    } catch {
      list = [];
    }
    await Promise.all(list.map(connect));
    notify();
  })();
  return loaded;
}

async function connect(c: PhoneConnector) {
  clients.get(c.name)?.close();
  clients.delete(c.name);
  if (!c.enabled) {
    states.set(c.name, { state: 'off', tools: [] });
    return;
  }
  states.set(c.name, { state: 'connecting', tools: [] });
  notify();
  const client = new RemoteMcpClient(c.url, c.headers);
  try {
    const tools = await client.listTools();
    clients.set(c.name, client);
    states.set(c.name, { state: 'connected', tools, serverInfo: client.serverInfo, instructions: client.instructions });
  } catch (err) {
    states.set(c.name, { state: 'error', error: (err as Error).message, tools: [] });
  }
  notify();
}

export function permissionOf(c: PhoneConnector, tool: McpTool): Permission {
  const chosen = c.perms[tool.name];
  if (chosen === 'auto' || chosen === 'ask' || chosen === 'off') return chosen;
  return tool.annotations?.readOnlyHint === true ? 'auto' : 'ask';
}

function checkUrl(url: string) {
  // Plain http only for a service on this network (tests, a box at home)
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)) {
    throw new Error('L’indirizzo deve iniziare con https:// (http:// solo per servizi nella tua rete)');
  }
}

export async function addConnector({ name, url, token }: { name: string; url: string; token?: string }) {
  await loadConnectors();
  const clean = name.trim();
  if (!validName(clean)) throw new Error('Nome non valido: usa lettere, numeri, - e _ (massimo 32)');
  checkUrl(url.trim());
  const headers: Record<string, string> = token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {};
  const c: PhoneConnector = { name: clean, url: url.trim(), headers, enabled: true, perms: list.find((x) => x.name === clean)?.perms ?? {} };
  list = [...list.filter((x) => x.name !== clean), c];
  await save();
  await connect(c);
  return states.get(clean);
}

// Paste { "mcpServers": { "name": { "url": "…", "headers": { … } } } }: remote ones only
export async function addFromJson(text: string) {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error('JSON non valido'); }
  const entries = Object.entries<any>(parsed.mcpServers ?? parsed);
  if (!entries.length) throw new Error('Nessun server trovato: incolla un oggetto { "mcpServers": { … } }');
  for (const [name, def] of entries) {
    if (def?.command) throw new Error(`“${name}” è un connettore locale (un comando): si aggiunge sul desktop, in QVAC-BOARD → Impostazioni → Connettori`);
    if (typeof def?.url !== 'string') throw new Error(`“${name}”: manca "url"`);
  }
  await loadConnectors();
  for (const [name, def] of entries) {
    if (!validName(name)) throw new Error(`Nome non valido: “${name}”`);
    checkUrl(def.url);
    const c: PhoneConnector = { name, url: def.url, headers: def.headers ?? {}, enabled: true, perms: list.find((x) => x.name === name)?.perms ?? {} };
    list = [...list.filter((x) => x.name !== name), c];
  }
  await save();
  await Promise.all(entries.map(([name]) => connect(list.find((x) => x.name === name)!)));
  return entries.map(([name]) => name);
}

export async function removeConnector(name: string) {
  clients.get(name)?.close();
  clients.delete(name);
  states.delete(name);
  list = list.filter((x) => x.name !== name);
  await save();
  notify();
}

export async function setConnectorEnabled(name: string, enabled: boolean) {
  const c = list.find((x) => x.name === name);
  if (!c) return;
  c.enabled = enabled;
  await save();
  await connect(c);
}

export async function setToolPermission(name: string, tool: string, permission: Permission) {
  const c = list.find((x) => x.name === name);
  if (!c) return;
  c.perms = { ...c.perms, [tool]: permission };
  await save();
  notify();
}

export async function reconnectConnector(name: string) {
  const c = list.find((x) => x.name === name);
  if (c) await connect(c);
}

// The tools offered to a model. Ids start with "tel_" so the desktop knows the phone runs them.
export function phoneToolsForModel() {
  const tools: { name: string; description: string; parameters: Record<string, unknown> }[] = [];
  const map = new Map<string, { server: string; tool: string; permission: Permission }>();
  for (const c of list) {
    const st = states.get(c.name);
    if (!c.enabled || st?.state !== 'connected') continue;
    for (const t of st.tools) {
      const permission = permissionOf(c, t);
      if (permission === 'off') continue;
      const id = `tel_${c.name}__${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
      map.set(id, { server: c.name, tool: t.name, permission });
      tools.push({
        name: id,
        description: `[${c.name}, dall’iPhone] ${t.description ?? ''}`.slice(0, 600),
        parameters: { type: 'object', properties: {}, ...(t.inputSchema ?? {}) },
      });
    }
  }
  return { tools, resolve: (id: string) => map.get(id) ?? null };
}

export async function callPhoneTool(server: string, tool: string, args: unknown) {
  const client = clients.get(server);
  if (!client) throw new Error(`Il connettore “${server}” non è collegato`);
  const r = await client.callTool(tool, args);
  return { ...r, text: r.text.length > MAX_RESULT_CHARS ? `${r.text.slice(0, MAX_RESULT_CHARS)}\n…(risultato accorciato)` : r.text };
}

export function useConnectors() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    loadConnectors();
    return () => { listeners.delete(fn); };
  }, []);
  return list.map((c) => ({
    ...c,
    hasToken: Boolean(c.headers.Authorization),
    status: states.get(c.name) ?? { state: c.enabled ? 'connecting' : 'off', tools: [] } as ConnectorState,
  }));
}
