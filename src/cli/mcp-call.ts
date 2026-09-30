import { resolveDaemonEndpoint, type ResolveDaemonEndpointOpts } from '../nexus/daemon-endpoint.js';
import { RemotesStore } from './remotes.js';
import { bookmarkAttachDefaults } from './remote-resolve.js';
import { getNodeKind } from '../graph-kinds/registry.js';

export type McpCliClassification =
  | 'ok'
  | 'mcp-authorization-denied'
  | 'mcp-transport-error'
  | 'mcp-http-error'
  | 'mcp-server-error'
  | 'mcp-tool-error'
  | 'mcp-remote-error'
  | 'mcp-usage-error';

export interface McpCliResult {
  exitCode: number;
  classification: McpCliClassification;
  message: string;
}

export interface McpCallOpts {
  tool: string;
  args?: string | readonly string[];
  /** Repeatable `--arg-json k=<json>` entries. Values are JSON.parse'd per key. */
  argJson?: string | readonly string[];
  argsJson?: string;
  json?: boolean;
  /** `true` = value-less `-r` (default bookmark). string = `--remote <name>`. omitted = local daemon. */
  remote?: string | boolean;
  out?: { log: (line: string) => void; error: (line: string) => void };
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  remotesStore?: () => RemotesStore;
  localUrl?: string;
  localToken?: string;
  /** Test seam — daemon address. `null` means this universe has no daemon (do not guess a port). */
  resolveEndpoint?: (opts?: ResolveDaemonEndpointOpts) => { baseUrl: string } | null;
}

export type McpListOpts = Omit<McpCallOpts, 'tool' | 'args' | 'argJson' | 'argsJson'>;

const TYPED_ARG_GUIDANCE =
  'This value must be passed with --arg-json k=<json> or --args-json \'<json>\'.';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface ResolvedEndpoint {
  url: string;
  token?: string;
  remoteLabel?: string;
}

class McpCliFailure extends Error {
  readonly classification: Exclude<McpCliClassification, 'ok'>;
  constructor(
    classification: Exclude<McpCliClassification, 'ok'>,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'McpCliFailure';
    this.classification = classification;
  }
}

export async function runMcpCall(opts: McpCallOpts): Promise<McpCliResult> {
  const out = opts.out ?? defaultOut();
  const parsed = parseCallArguments(opts.args, opts.argsJson, opts.argJson);
  if (!parsed.ok) return fail(out, 'mcp-usage-error', parsed.message);
  return runMcpRpc(opts, out, { tool: opts.tool, arguments: parsed.arguments }, opts.tool);
}

function mcpToolRequest(tool: string, args: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextRpcId(), method: 'tools/call', params: { name: tool, arguments: args } };
}

/** Invoke one tool through the daemon's JSON-RPC MCP gateway. Returns the raw tools/call result. */
export async function callDaemonMcpTool(opts: {
  tool: string;
  arguments: Record<string, unknown>;
  endpoint?: string | ResolvedEndpoint;
  fetchFn?: McpCallOpts['fetchFn'];
  pluginKind?: string;
}): Promise<unknown> {
  if (opts.pluginKind) {
    const entry = getNodeKind('workflow', opts.pluginKind);
    if (!entry || entry.core || !entry.plugin || !entry.run || !('mcp' in entry.run)
      || opts.tool !== `${entry.run.mcp.server}.${entry.run.mcp.tool}`) {
      throw new McpCliFailure('mcp-usage-error', 'invalid plugin MCP kind');
    }
  }
  const endpoint = typeof opts.endpoint === 'string' ? { url: opts.endpoint } : opts.endpoint;
  const resolved = endpoint ? { ok: true as const, value: endpoint } : resolveMcpEndpoint({});
  if (!resolved.ok) throw new McpCliFailure(resolved.classification, resolved.message);
  const payload = await dispatchMcpRpc(
    { fetchFn: opts.fetchFn }, mcpToolRequest(opts.tool, opts.arguments), opts.tool, resolved.value,
  );
  return payload.result;
}

export async function runMcpList(opts: McpListOpts = {}): Promise<McpCliResult> {
  const out = opts.out ?? defaultOut();
  return runMcpRpc(opts, out, {
    jsonrpc: '2.0',
    id: nextRpcId(),
    method: 'tools/list',
  });
}

async function runMcpRpc(
  opts: McpListOpts,
  out: NonNullable<McpCallOpts['out']>,
  request: JsonRpcRequest | { tool: string; arguments: Record<string, unknown> },
  tool?: string,
): Promise<McpCliResult> {
  const endpoint = resolveMcpEndpoint(opts);
  if (!endpoint.ok) return fail(out, endpoint.classification, endpoint.message);

  try {
    const result = 'tool' in request
      ? await callDaemonMcpTool({ tool: request.tool, arguments: request.arguments, endpoint: endpoint.value, fetchFn: opts.fetchFn })
      : (await dispatchMcpRpc(opts, request, tool, endpoint.value)).result;
    const message = opts.json === true
      ? JSON.stringify(result, null, 2)
      : formatPayload(result, false);
    out.log(message);
    return { exitCode: 0, classification: 'ok', message };
  } catch (err) {
    const failure = err instanceof McpCliFailure
      ? err
      : new McpCliFailure(
        'mcp-transport-error',
        `mcp transport error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    const message = annotateRemote(endpoint.value.remoteLabel, failure.message);
    return fail(out, failure.classification, message);
  }
}

async function dispatchMcpRpc(
  opts: McpListOpts,
  request: JsonRpcRequest,
  tool: string | undefined,
  endpoint: ResolvedEndpoint,
): Promise<{ result: unknown }> {
  const fetchFn = opts.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(endpoint.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
      },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new McpCliFailure(
      'mcp-transport-error',
      `mcp transport error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    const body = await readBody(response);
    throw new McpCliFailure(
      'mcp-http-error',
      `mcp http error: HTTP ${response.status}${body ? `: ${body}` : ''}`,
    );
  }

  const raw = await readBody(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new McpCliFailure('mcp-server-error', `mcp server error: non-JSON response: ${raw}`);
  }

  const envelope = parseJsonRpcResponse(parsed, request.id);
  if (envelope.error) {
    const denial = authorizationDeniedFromFailure(envelope.error);
    if (denial !== undefined) {
      throw new McpCliFailure('mcp-authorization-denied', withToolName(denial, tool));
    }
    throw new McpCliFailure(
      'mcp-server-error',
      withTypedArgGuidance(`mcp server error: ${envelope.error.message}`),
    );
  }

  const result = envelope.result;
  const denial = authorizationDeniedFromResult(result);
  if (denial !== undefined) {
    throw new McpCliFailure('mcp-authorization-denied', withToolName(denial, tool));
  }

  if (isToolLevelFailure(result)) {
    throw new McpCliFailure('mcp-tool-error', withTypedArgGuidance(formatPayload(result, true)));
  }

  return { result };
}

function parseJsonRpcResponse(
  parsed: unknown,
  expectedId: number,
): {
  result?: unknown;
  error?: { code: number; message: string } & Record<string, unknown>;
} {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpCliFailure('mcp-server-error', 'mcp server error: unexpected JSON-RPC envelope');
  }
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') {
    throw new McpCliFailure('mcp-server-error', 'mcp server error: response is not JSON-RPC 2.0');
  }
  if (record.id !== expectedId) {
    throw new McpCliFailure(
      'mcp-server-error',
      `mcp server error: JSON-RPC id mismatch (expected ${expectedId}, got ${String(record.id)})`,
    );
  }
  const hasResult = Object.prototype.hasOwnProperty.call(record, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(record, 'error');
  if (hasResult === hasError) {
    throw new McpCliFailure(
      'mcp-server-error',
      hasResult
        ? 'mcp server error: JSON-RPC response has both result and error'
        : 'mcp server error: JSON-RPC response has neither result nor error',
    );
  }
  if (hasError) {
    const err = record.error;
    if (!isJsonRpcErrorObject(err)) {
      throw new McpCliFailure('mcp-server-error', 'mcp server error: JSON-RPC error envelope is invalid');
    }
    return { error: err };
  }
  return { result: record.result };
}

function isJsonRpcErrorObject(
  value: unknown,
): value is { code: number; message: string } & Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { code?: unknown }).code === 'number'
    && typeof (value as { message?: unknown }).message === 'string';
}

function resolveMcpEndpoint(opts: McpListOpts):
  | { ok: true; value: ResolvedEndpoint }
  | { ok: false; classification: 'mcp-remote-error'; message: string } {
  if (opts.remote === undefined) {
    const url = opts.localUrl ?? localMcpUrl(opts);
    if (!url) {
      return {
        ok: false,
        classification: 'mcp-remote-error',
        message: 'mcp: no local daemon. Start one with `elanous nexus run` (a port is not guessed).',
      };
    }
    return {
      ok: true,
      value: {
        url,
        ...(opts.localToken ? { token: opts.localToken } : {}),
      },
    };
  }

  const store = (opts.remotesStore ?? (() => new RemotesStore()))();
  const named = typeof opts.remote === 'string' && opts.remote.length > 0 ? opts.remote : undefined;
  const entry = named ? store.getRemote(named) : store.getDefaultRemote();
  const defaultName = named ? undefined : store.listRemotes().find((row) => row.isDefault)?.name;
  const label = named ?? defaultName ?? '<default>';
  if (!entry) {
    return {
      ok: false,
      classification: 'mcp-remote-error',
      message: named
        ? `--remote ${named}: unknown bookmark. Run \`elanous nexus list\` to see available remotes.`
        : 'no default remote bookmark. Run `elanous nexus connect <host> --default` to set one.',
    };
  }

  let defaults: { host: string; tokenFile: string };
  try {
    defaults = bookmarkAttachDefaults(entry);
  } catch (err) {
    return {
      ok: false,
      classification: 'mcp-remote-error',
      message: `mcp: remote bookmark ${label}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const token = store.readToken(entry)?.trim();
  if (!token) {
    return {
      ok: false,
      classification: 'mcp-remote-error',
      message: `mcp: remote bookmark ${label} (${entry.host}): token file is missing or empty (${defaults.tokenFile})`,
    };
  }

  let origin: string;
  try {
    origin = mcpRemoteHttpOrigin(defaults.host);
  } catch (err) {
    return {
      ok: false,
      classification: 'mcp-remote-error',
      message: `mcp: remote bookmark ${label}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, value: { url: `${origin}/v1/mcp`, token, remoteLabel: label } };
}

function localMcpUrl(opts: McpListOpts): string | null {
  const endpoint = (opts.resolveEndpoint ?? resolveDaemonEndpoint)();
  return endpoint ? `${endpoint.baseUrl}/v1/mcp` : null;
}

function mcpRemoteHttpOrigin(host: string): string {
  const raw = host.trim();
  if (!raw) throw new Error('remote bookmark host is empty');
  const parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`remote bookmark host has unsupported protocol ${parsed.protocol}`);
  }
  return parsed.origin;
}

function parseCallArguments(
  args: McpCallOpts['args'],
  argsJson: string | undefined,
  argJson?: McpCallOpts['argJson'],
): { ok: true; arguments: Record<string, unknown> } | { ok: false; message: string } {
  const merged: Record<string, unknown> = {};
  if (argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson) as unknown;
    } catch (err) {
      return { ok: false, message: `invalid --args-json: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'invalid --args-json: expected a JSON object' };
    }
    Object.assign(merged, parsed as Record<string, unknown>);
  }
  const jsonList = Array.isArray(argJson) ? argJson : argJson ? [argJson] : [];
  for (const kv of jsonList) {
    const eq = kv.indexOf('=');
    if (eq <= 0) return { ok: false, message: `invalid --arg-json ${kv}: expected k=<json>` };
    const key = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      return {
        ok: false,
        message: `invalid --arg-json ${key}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    merged[key] = parsed;
  }
  const list = Array.isArray(args) ? args : args ? [args] : [];
  for (const kv of list) {
    const eq = kv.indexOf('=');
    if (eq <= 0) return { ok: false, message: `invalid --arg ${kv}: expected k=v` };
    merged[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return { ok: true, arguments: merged };
}

function isTypeValidationErrorMessage(message: string): boolean {
  if (/input validation/i.test(message)) return true;
  if (/invalid input/i.test(message)) return true;
  if (/expected (?:a )?(number|integer|boolean|object|array|null|string)/i.test(message)
    && /(received|got)/i.test(message)) {
    return true;
  }
  return false;
}

function withTypedArgGuidance(message: string): string {
  if (!isTypeValidationErrorMessage(message)) return message;
  if (message.includes('--arg-json') || message.includes('--args-json')) return message;
  return `${message}\n${TYPED_ARG_GUIDANCE}`;
}

function authorizationDeniedFromFailure(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const rec = error as Record<string, unknown>;
  if (rec.classification === 'mcp-authorization-denied') {
    return typeof rec.message === 'string' ? rec.message
      : typeof rec.output === 'string' ? rec.output
        : 'mcp authorization denied';
  }
  const data = rec.data;
  if (data && typeof data === 'object' && !Array.isArray(data)
    && (data as Record<string, unknown>).classification === 'mcp-authorization-denied') {
    const dataRec = data as Record<string, unknown>;
    return typeof dataRec.output === 'string' ? dataRec.output
      : typeof rec.message === 'string' ? rec.message
        : 'mcp authorization denied';
  }
  return undefined;
}

function authorizationDeniedFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const rec = result as Record<string, unknown>;
  if (rec.classification === 'mcp-authorization-denied') {
    return typeof rec.output === 'string' ? rec.output : 'mcp authorization denied';
  }
  const structured = rec.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const nested = structured as Record<string, unknown>;
    if (nested.classification === 'mcp-authorization-denied') {
      return typeof nested.output === 'string' ? nested.output
        : typeof rec.output === 'string' ? rec.output
          : 'mcp authorization denied';
    }
  }
  return undefined;
}

function withToolName(denial: string, tool: string | undefined): string {
  return denial.includes(tool ?? '') || !tool ? denial : `${denial}: ${tool}`;
}

function annotateRemote(label: string | undefined, message: string): string {
  if (!label) return message;
  if (message.includes(`remote bookmark ${label}`)) return message;
  return `mcp: remote bookmark ${label}: ${message}`;
}

function isToolLevelFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const rec = result as Record<string, unknown>;
  if (rec.isError === true) return true;
  const structured = rec.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return (structured as Record<string, unknown>).ok === false;
  }
  return rec.ok === false;
}

function formatPayload(result: unknown, asError: boolean): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    if (rec.structuredContent !== undefined) {
      return typeof rec.structuredContent === 'string'
        ? rec.structuredContent
        : JSON.stringify(rec.structuredContent, null, 2);
    }
    if (typeof rec.output === 'string') return rec.output;
    if (Array.isArray(rec.content)) {
      const texts = rec.content
        .map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : ''))
        .filter((text) => text.length > 0);
      if (texts.length > 0) return texts.join('\n');
    }
  }
  if (typeof result === 'string') return result;
  const encoded = JSON.stringify(result, null, 2);
  return asError ? `mcp tool error: ${encoded}` : encoded;
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function fail(
  out: NonNullable<McpCallOpts['out']>,
  classification: Exclude<McpCliClassification, 'ok'>,
  message: string,
): McpCliResult {
  out.error(message);
  return { exitCode: 1, classification, message };
}

function defaultOut(): NonNullable<McpCallOpts['out']> {
  return {
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}

let rpcSeq = 0;
function nextRpcId(): number {
  rpcSeq += 1;
  return rpcSeq;
}
