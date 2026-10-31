// ACP agent manager — one AcpAgent subprocess per backend id + cwd,
// kept alive for the bot's lifetime. Multiple chats / sessions share
// a subprocess when both backend and working directory match, just
// like zed reuses one connection per configured agent server.
//
// Lifecycle:
//   - Lazy spawn on first getAgent(backendId) call.
//   - process.on('exit') cleanup so a Ctrl+C leaves no orphans.
//   - Explicit stopAll() path for `/telegram off` etc.
//
// NOT thread-safe for concurrent starts — we rely on the fact that
// Node's event loop makes start() calls non-overlapping for the same
// backend. A concurrency bug here would cause double-spawn, which is
// annoying but not catastrophic (the stale one would fail to bind to
// stdio). Cheap mitigation if it ever matters: guard with a
// Promise<AcpAgent> cache instead of AcpAgent.

import { AcpAgent, type AcpAgentOpts } from './client.js';
import { getAcpBackend, canonicalizeBackendId } from './backend-registry.js';
import { CodexAppServerAgent } from './codex-app-server-agent.js';
import { createAskUserElicitationHandler } from './codex-elicitation-ask.js';
import type { CodexAppServerClient } from './codex-app-server-client.js';
import { getSessionCwd } from '../session/working-dir.js';

/** UI-Core arc Phase U1 — narrow change event for SessionStore facade
 *  subscription. Attach/drop only — the AcpAgent subprocess handle
 *  never crosses the event boundary. */
export type AcpAgentManagerChangeEvent =
  | { kind: 'agent-attached'; backendId: string; cwd: string }
  | { kind: 'agent-dropped'; backendId: string; cwd: string };

export class AcpAgentManager {
  private agents = new Map<string, { backendId: string; cwd: string; agent: AcpAgent }>();
  private shutdownHookInstalled = false;
  private exitHandler: (() => void) | undefined;
  private sigintHandler: (() => void) | undefined;
  private sigtermHandler: (() => void) | undefined;
  private changeListeners = new Set<(ev: AcpAgentManagerChangeEvent) => void>();

  async getAgent(backendId: string, opts: Omit<AcpAgentOpts, 'backendId'> = {}): Promise<AcpAgent> {
    this.installShutdownHook();
    // Normalize a friendly alias (codex/cx/cas → codex-app-server) up front
    // so the cache key, spec lookup, and the constructed agent's own
    // backendId all agree — otherwise `/cdx` ('codex') and an NL delegate
    // ('codex-app-server') would spawn two separate subprocesses.
    backendId = canonicalizeBackendId(backendId);
    const cwd = opts.cwd ?? getSessionCwd();
    const key = agentKey(backendId, cwd, opts.codexArgs);
    const existing = this.agents.get(key);
    if (existing) {
      existing.agent.setPermissionApprover(opts.permissionApprover);
      existing.agent.setQuestionApprover(opts.questionApprover);
      return existing.agent;
    }
    // Branch on backend transport. Two-way switch since sprint 5B
    // (2026-04-28) removed the legacy codex-sdk transport (CodexNative-
    // Agent + @openai/codex-sdk):
    //
    //   - 'codex-app-server'  → CodexAppServerAgent · direct JSON-RPC
    //                           v2 to a persistent `codex app-server`
    //                           subprocess · approval adapter wired
    //                           through server-originated requests.
    //                           Canonical codex path.
    //   - else                → plain ACP JSON-RPC stdio via AcpAgent.
    //
    // The non-default path casts at the factory boundary since it
    // duck-types the AcpAgent surface (newSession · prompt · cancel ·
    // stop · set*Approver · getCapabilities).
    const spec = getAcpBackend(backendId);
    let agent: AcpAgent;
    if (spec.transport === 'codex-app-server') {
      // ⛔📏 2026-08-21: 여기가 «비어 있어서» elanous 는 코덱스의 물음을 구조적으로 전부 거절했다.
      //   `setElicitationHandler` 의 프로덕션 호출자가 0 이었고, 기본 핸들러는 decline 이다.
      //   ⇒ 사람에게 묻는 기계는 이미 «끝까지» 있었다(ask-user-question · PWA 시트 · HITL).
      //     끊긴 것은 이 한 줄이다. ⭐ 매핑은 못 고르는 스키마를 «거절»한다 — 지어내지 않는다.
      agent = new CodexAppServerAgent({
        backendId,
        ...opts,
        remoteSocketPath: process.env.ELANOUS_CODEX_REMOTE_SIDETAB_SOCKET || undefined,
        elicitationHandler: createAskUserElicitationHandler(),
      }) as unknown as AcpAgent;
    } else {
      agent = new AcpAgent({ backendId, ...opts });
    }
    await agent.start();
    this.agents.set(key, { backendId, cwd, agent });
    this.fireChange({ kind: 'agent-attached', backendId, cwd });
    return agent;
  }

  /** Drop a running agent — used when we know the subprocess died
   *  unexpectedly (crash, OOM, etc.) so the next getAgent() spawns
   *  a fresh one instead of reusing a dead handle. */
  drop(backendId: string, cwd?: string): void {
    const keys = cwd
      ? [agentKey(backendId, cwd)]
      : Array.from(this.agents.entries())
          .filter(([, entry]) => entry.backendId === backendId)
          .map(([key]) => key);
    for (const key of keys) {
      const entry = this.agents.get(key);
      if (!entry) continue;
      // Fire-and-forget stop. If the process is already dead this
      // is a no-op; if it's alive but wedged, SIGTERM finishes it.
      void entry.agent.stop().catch(() => {});
      this.agents.delete(key);
      this.fireChange({ kind: 'agent-dropped', backendId: entry.backendId, cwd: entry.cwd });
    }
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.agents.values());
    this.agents.clear();
    await Promise.allSettled(entries.map(e => e.agent.stop()));
    for (const e of entries) {
      this.fireChange({ kind: 'agent-dropped', backendId: e.backendId, cwd: e.cwd });
    }
  }

  /** Release this manager's process hooks and its owned agents. Safe to call
   * repeatedly, which makes one-shot users able to clean up deterministically. */
  async dispose(): Promise<void> {
    await this.stopAll();
    if (!this.shutdownHookInstalled) return;
    if (this.exitHandler) process.removeListener('exit', this.exitHandler);
    if (this.sigintHandler) process.removeListener('SIGINT', this.sigintHandler);
    if (this.sigtermHandler) process.removeListener('SIGTERM', this.sigtermHandler);
    this.exitHandler = undefined;
    this.sigintHandler = undefined;
    this.sigtermHandler = undefined;
    this.shutdownHookInstalled = false;
  }

  running(): string[] {
    return Array.from(new Set(Array.from(this.agents.values()).map(entry => entry.backendId)));
  }

  /** UI-Core arc Phase U1 — SessionStore facade snapshot projection. */
  listAgents(): Array<{ backendId: string; cwd: string }> {
    return Array.from(this.agents.values()).map(e => ({ backendId: e.backendId, cwd: e.cwd }));
  }

  /** UI-Core arc Phase U1 — subscribe to attach/drop events. */
  onChange(listener: (ev: AcpAgentManagerChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private fireChange(ev: AcpAgentManagerChangeEvent): void {
    for (const l of Array.from(this.changeListeners)) {
      try { l(ev); } catch { /* listener errors must not wedge others */ }
    }
  }

  /** PLAN-codex-app-server-hermes-parity §5 Phase H2·1 wire (2026-05-16) —
   *  return the JSON-RPC client of the first running codex app-server
   *  agent (any cwd). Codex plugins are user-global — the `plugin/list`
   *  response doesn't depend on which working directory the agent is
   *  bound to, so the first hit is sufficient. Returns null when no
   *  codex agent is currently attached (UI hides sub-chips).
   *
   *  We can't narrow `entry.agent` with a plain `instanceof` here —
   *  TS reduces `AcpAgent & CodexAppServerAgent` to `never` because
   *  both have `private` members that conflict at the type level. The
   *  runtime `instanceof` still works (JS preserves the prototype chain
   *  past the `as unknown as AcpAgent` cast in getAgent()), so we cast
   *  through unknown first and use the boolean for the actual filter. */
  getActiveCodexClient(): CodexAppServerClient | null {
    for (const entry of this.agents.values()) {
      const candidate = entry.agent as unknown as CodexAppServerAgent;
      if (candidate instanceof CodexAppServerAgent) {
        const client = candidate.getClient();
        if (client) return client;
      }
    }
    return null;
  }

  private installShutdownHook(): void {
    if (this.shutdownHookInstalled) return;
    this.shutdownHookInstalled = true;
    // 'exit' fires synchronously on normal exits. We can only do
    // synchronous work in its handler, so kick off stop() without
    // awaiting — the child_process.kill inside stop() is itself
    // synchronous and sufficient to avoid orphaned subprocesses.
    this.exitHandler = () => {
      for (const entry of this.agents.values()) {
        void entry.agent.stop().catch(() => {});
      }
    };
    process.on('exit', this.exitHandler);
    // SIGINT / SIGTERM: promote to a clean shutdown so we get the
    // async stop() path too. process.exit calls the 'exit' handlers
    // synchronously after event-loop drains.
    const onSignal = async (): Promise<void> => {
      await this.stopAll();
      process.exit(0);
    };
    this.sigintHandler = () => void onSignal();
    this.sigtermHandler = () => void onSignal();
    process.on('SIGINT', this.sigintHandler);
    process.on('SIGTERM', this.sigtermHandler);
  }
}

function agentKey(backendId: string, cwd: string, codexArgs?: readonly string[]): string {
  return `${backendId}\0${cwd}\0${codexArgs ? JSON.stringify(codexArgs) : ''}`;
}

let _manager: AcpAgentManager | null = null;

/** Process-wide singleton. Rebuilt on first access after
 *  _resetAcpAgentManagerForTests (tests only). */
export function globalAcpAgentManager(): AcpAgentManager {
  if (!_manager) _manager = new AcpAgentManager();
  return _manager;
}

/** Tests: clear the singleton so a fresh Manager is constructed next
 *  call. Does NOT stop any previously-running agents — tests are
 *  responsible for that. */
export function _resetAcpAgentManagerForTests(): void {
  _manager = null;
}
