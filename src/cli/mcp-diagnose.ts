// `elanous mcp diagnose [serverId]` — PR3 (D · 2026-05-13) deep
// trace for external MCP servers (`xcrun mcpbridge`,
// `xcodebuildmcp`, …). Reproduces what `register-mcp-clients` does on
// boot but in a single-shot, verbose form: spawn the child, do the
// JSON-RPC `initialize`, then `tools/list`, print every stdout +
// stderr line + per-step wall-clock + the final tool count.
//
// The signal we're after is "where does daemon-side boot differ from
// a manual stdin trace?" — when a user reports `xcrun mcpbridge` hang
// inside `elanous nexus run` but `echo …| xcrun mcpbridge` answers
// fine, this command lets them spawn under both the current shell
// env AND a stripped env approximating bg-launch child, then diff
// the two outputs.
//
// Non-goals: this is NOT a daemon · NOT a long-running process · NOT
// integrated with the running daemon. It owns its own McpClient
// instance, runs once, prints, and exits. Mirrors `xcrun mcpbridge
// --help` ergonomics: short, scriptable, no side effects.

import { spawn as nodeSpawn } from 'node:child_process';

import { McpServerError,
  McpClient,
  McpConnectionError,
  formatMcpConnectionGuidance,
  type ChildProcessLike,
  type McpConnectionFailureReason,
} from '../mcp/client.js';
import { loadStoredAccessToken } from '../mcp/mcp-oauth.js';
import { getUserConfig } from '../user-config.js';
import type { McpServerSpec } from '../user-config/types.js';

export interface McpDiagnoseOpts {
  /** Optional id from user-config `mcp.servers[]`. When omitted, every
   *  enabled server is diagnosed in order. */
  serverId?: string;
  /** Per-call deadline (ms). Default 10000 — slightly above the boot
   *  guard (8000ms · PR #2527) so a borderline-slow handshake still
   *  surfaces a tool count instead of failing. */
  perCallTimeoutMs?: number;
  /** Output sink (default = console / stderr). */
  out?: { log: (s: string) => void; error: (s: string) => void };
  /** Test seam — override config read. */
  readConfigFn?: () => { mcp?: { servers: McpServerSpec[] } };
  /** Test seam — replace the McpClient factory. HTTP and stdio both reach it. */
  createClient?: (spec: McpServerSpec) => Pick<McpClient,
    'start' | 'listTools' | 'callTool' | 'dispose'> & { httpRequestCount?: number };
}

export interface McpDiagnoseResult {
  exitCode: number;
  /** Per-server diagnostic, keyed by spec.id. */
  perServer: Record<string, McpDiagnosePerServer>;
}

export interface McpDiagnosePerServer {
  status: 'ready' | 'failed' | 'not-found';
  startMs?: number;
  listToolsMs?: number;
  toolCount?: number;
  /** stderr lines captured during the boot — emptier than expected
   *  here usually means the child writes nothing on a normal start.
   *  A misbehaving server should at least emit one line that points
   *  at the underlying failure (auth · service discovery · etc.). */
  stderrLines: string[];
  /** When `status='failed'`, the captured error message. */
  reason?: string;
  /** Structured attach failure — auth-required / unreachable / not-mcp. */
  failureReason?: McpConnectionFailureReason;
  /** HTTP POSTs issued while attaching (retry vs no-retry). */
  httpRequestCount?: number;
}

export async function runMcpDiagnose(opts: McpDiagnoseOpts = {}): Promise<McpDiagnoseResult> {
  const out = opts.out ?? {
    log: (s: string) => process.stdout.write(s + '\n'),
    error: (s: string) => process.stderr.write(s + '\n'),
  };
  const cfg = (opts.readConfigFn ?? (() => getUserConfig()))();
  const allServers = cfg.mcp?.servers ?? [];
  const filtered = opts.serverId
    ? allServers.filter((s) => s.id === opts.serverId)
    : allServers.filter((s) => s.enabled !== false);
  const timeout = opts.perCallTimeoutMs ?? 10_000;

  out.log(`elanous mcp diagnose — ${filtered.length} server${filtered.length === 1 ? '' : 's'} to probe`);
  out.log('');

  const perServer: Record<string, McpDiagnosePerServer> = {};

  if (opts.serverId && filtered.length === 0) {
    out.error(`✗ server id '${opts.serverId}' not found in user-config mcp.servers[]`);
    out.error('  Try `elanous config get mcp.servers` to list available ids.');
    perServer[opts.serverId] = { status: 'not-found', stderrLines: [] };
    return { exitCode: 1, perServer };
  }

  let allOk = true;
  for (const spec of filtered) {
    const result = await diagnoseOne(spec, { out, timeout, createClient: opts.createClient });
    perServer[spec.id] = result;
    if (result.status !== 'ready') allOk = false;
    out.log('');
  }

  out.log(allOk ? '✓ all servers responded' : '✗ at least one server failed — see per-server lines above');
  return { exitCode: allOk ? 0 : 1, perServer };
}

interface DiagnoseOneCtx {
  out: NonNullable<McpDiagnoseOpts['out']>;
  timeout: number;
  createClient?: McpDiagnoseOpts['createClient'];
}

async function diagnoseOne(spec: McpServerSpec, ctx: DiagnoseOneCtx): Promise<McpDiagnosePerServer> {
  const { out, timeout } = ctx;
  const label = spec.transport === 'http' ? spec.url : spec.command.join(' ');
  out.log(`▸ ${spec.id}  (${label})`);
  const stderrLines: string[] = [];

  const createClient = ctx.createClient ?? ((s: McpServerSpec) => {
    if (s.transport === 'http') {
      // One immediate retry on unreachable; auth-required / not-mcp never retry.
      const httpTimeoutMs = timeout > 0 ? Math.max(250, Math.min(3_000, Math.floor(timeout / 3))) : 3_000;
      return new McpClient({
        id: s.id,
        url: s.url,
        reconnectBackoffMs: [0],
        httpTimeoutMs,
        logger: (event, data) => {
          if (event === 'mcp.client.parse-error') {
            out.error(`    parse  ─ ${typeof data?.line === 'string' ? data.line : '?'}`);
          }
        },
        ...(s.oauthIssuer ? { oauthIssuer: s.oauthIssuer } : {}),
        ...(s.oauthTokenEndpoint ? { oauthTokenEndpoint: s.oauthTokenEndpoint } : {}),
        ...(s.bearerTokenEnv ? { bearerTokenEnv: s.bearerTokenEnv } : {}),
      });
    }
    return new McpClient({
      id: s.id,
      command: s.command,
      logger: (event, data) => {
        if (event === 'mcp.client.stderr' && data && typeof data.line === 'string') {
          stderrLines.push(data.line);
          out.log(`    stderr ─ ${data.line}`);
        } else if (event === 'mcp.client.exit') {
          out.log(`    exit   ─ code=${data?.code ?? '?'} signal=${data?.signal ?? '-'}`);
        } else if (event === 'mcp.client.parse-error') {
          out.error(`    parse  ─ ${typeof data?.line === 'string' ? data.line : '?'}`);
        }
      },
      spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildProcessLike,
    });
  });
  const client = createClient(spec) as McpClient;

  const startT0 = Date.now();
  try {
    await withDeadline(`start (${spec.id})`, () => client.start(), timeout);
    const startMs = Date.now() - startT0;
    out.log(`    start  ✓ ${startMs}ms`);
    const listT0 = Date.now();
    const tools = await withDeadline(`listTools (${spec.id})`, () => client.listTools(), timeout);
    const listToolsMs = Date.now() - listT0;
    out.log(`    list   ✓ ${listToolsMs}ms · ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
    try { await client.dispose(); } catch { /* swallow */ }
    return {
      status: 'ready',
      startMs,
      listToolsMs,
      toolCount: tools.length,
      stderrLines,
      httpRequestCount: client.httpRequestCount,
    };
  } catch (err) {
    const classified = classifyDiagnoseFailure(err, spec);
    out.error(`    ✗ ${classified.reason}`);
    try { await client.dispose(); } catch { /* swallow */ }
    return {
      status: 'failed',
      stderrLines,
      reason: classified.reason,
      failureReason: classified.failureReason,
      startMs: Date.now() - startT0,
      httpRequestCount: client.httpRequestCount,
    };
  }
}

/** ⛔⭐ **우리가 «건» 마감**과 «상대가 보낸» 오류를 문면으로 가르면 안 된다.
 *  초판은 `/timeout/i` 로 갈라서, 서버가 정상 JSON-RPC 로 보낸
 *  `MCP error -32000: upstream timeout` 같은 응답까지 ***「닿지 못했다」로 둔갑***시켰다.
 *  ⇒ 마감은 «타입»으로 표시한다. (같은 형태를 오늘 `McpServerError` 로 한 번 고쳤다.) */
export class McpDiagnoseDeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: timeout after ${ms}ms`);
    this.name = 'McpDiagnoseDeadlineError';
  }
}

function classifyDiagnoseFailure(
  err: unknown,
  spec: McpServerSpec,
): { reason: string; failureReason?: McpConnectionFailureReason } {
  if (err instanceof McpConnectionError) {
    if (err.reason === 'auth-required' && spec.transport === 'http' && spec.oauthIssuer) {
      const credentialState = loadStoredAccessToken(spec.oauthIssuer)
        ? 'stored credentials were rejected'
        : 'no stored credentials for this server';
      return {
        reason: `${formatMcpConnectionGuidance(err)} — ${credentialState}`,
        failureReason: err.reason,
      };
    }
    return { reason: formatMcpConnectionGuidance(err), failureReason: err.reason };
  }
  // ⛔ 서버가 «응답»을 보낸 것이다 — 그 안에 'timeout' 이 있어도 우리는 닿았다.
  //    원문을 그대로 남긴다. 다시 분류하면 사람이 「네트워크 문제」로 오독한다.
  if (err instanceof McpServerError) return { reason: err.message };
  if (spec.transport === 'http' && err instanceof McpDiagnoseDeadlineError) {
    const wrapped = new McpConnectionError('unreachable', '', { detail: spec.url });
    return { reason: formatMcpConnectionGuidance(wrapped), failureReason: 'unreachable' };
  }
  return { reason: err instanceof Error ? err.message : String(err) };
}

function withDeadline<T>(label: string, op: () => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return op();
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new McpDiagnoseDeadlineError(label, ms)), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    op().then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
