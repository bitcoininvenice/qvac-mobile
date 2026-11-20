// Minimal MCP client for remote servers ("Streamable HTTP" transport), with plain fetch.
// No Node APIs: it runs in the app (React Native) and, for tests, in Node.
//
// Each request is a JSON-RPC POST; the server answers with JSON or with a short
// event stream (we read the whole body and pick our answer out of it).

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 30_000;

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export class McpError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export class RemoteMcpClient {
  private url: string;
  private headers: Record<string, string>;
  private sessionId: string | null = null;
  private seq = 0;
  private ready: Promise<void> | null = null;
  // What the server says about itself when we connect (shown in the connector's guide)
  serverInfo: { name?: string; title?: string; version?: string } | null = null;
  instructions: string | null = null;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  private async post(body: object, expectAnswer: boolean): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new McpError((err as Error).name === 'AbortError' ? 'Il servizio non risponde' : `Servizio non raggiungibile: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (res.status === 401 || res.status === 403) throw new McpError('Accesso negato: serve un token valido', res.status);
    if (res.status === 404 && this.sessionId) throw new McpError('Sessione scaduta', 404);
    if (!res.ok) throw new McpError(`Il servizio ha risposto ${res.status}`, res.status);
    if (!expectAnswer) return null;

    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const messages: any[] = [];
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) try { messages.push(JSON.parse(data)); } catch { /* not ours */ }
      }
    } else if (text.trim()) {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    const answer = messages.find((m) => 'id' in m && m.id === (body as any).id);
    if (!answer) throw new McpError('Risposta del servizio non valida');
    if (answer.error) throw new McpError(answer.error.message ?? 'Errore del servizio');
    return answer.result;
  }

  private request(method: string, params?: object) {
    return this.post({ jsonrpc: '2.0', id: ++this.seq, method, ...(params ? { params } : {}) }, true);
  }

  private connect() {
    this.ready ??= (async () => {
      const init = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qvac-mobile', version: '1.0.0' },
      });
      this.serverInfo = init?.serverInfo ?? null;
      this.instructions = typeof init?.instructions === 'string' ? init.instructions : null;
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  // A request, reconnecting once if the server forgot our session
  private async call(method: string, params?: object): Promise<any> {
    await this.connect();
    try {
      return await this.request(method, params);
    } catch (err) {
      if (!(err instanceof McpError) || err.status !== 404) throw err;
      this.sessionId = null;
      this.ready = null;
      await this.connect();
      return this.request(method, params);
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.call('tools/list', cursor ? { cursor } : undefined);
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
    const result = await this.call('tools/call', { name, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .map((p: any) => (p.type === 'text' ? p.text : p.type === 'resource' ? p.resource?.text ?? '' : `[${p.type}]`))
      .join('\n')
      .trim();
    return { isError: Boolean(result?.isError), text: text || '(nessun risultato)' };
  }

  close() {
    // Tell the server we are done with the session (best effort)
    if (!this.sessionId) return;
    fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, ...this.headers } }).catch(() => {});
    this.sessionId = null;
    this.ready = null;
  }
}
