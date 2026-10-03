// PCH-2b (0.2.10 · security D-20261002-08) — ACP turns ask the client before
// write/shell tools run; «allow always» is remembered per session and tool.
// Goal: 내부 문서 `ASK-pwa-chat-turns-run-write-and-shell-tools-without-approval-2026-10-02`
import { debug } from '../debug/log.js';
import type { AcpApprovalDecision, AcpTurnContext } from './server.js';

/** PCH-2b — tools that write files or run shell commands. ACP turns (PWA·iOS·
 * remote TUI) ask the client before these run; everything else runs as before.
 * One list, here, because the daemon catalog has no read-only/mutating flag. */
const ACP_APPROVAL_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'applypatch', 'apply_patch', 'patch',
  'bash', 'shell', 'runshell', 'exec_command',
  'ptyshellstart', 'ptyshellsend', 'webterminalinput',
  'delegate_code_agent',
]);
export function requiresAcpToolApproval(toolName: string): boolean {
  const name = toolName.startsWith('functions.') ? toolName.slice('functions.'.length) : toolName;
  // Codex app-server only sends a permission request when it wants to act.
  return ACP_APPROVAL_TOOLS.has(name.toLowerCase()) || name.startsWith('codex ');
}

export type AcpToolDenialReason = 'rejected' | 'cancelled' | 'timeout' | 'error';
export type AcpToolApprovalResult =
  | { allowed: true }
  | { allowed: false; reason: AcpToolDenialReason };

/** The tool result the LLM sees when a protected tool was not run. */
export function acpToolDenialResult(toolName: string, reason: AcpToolDenialReason): { error: string } {
  if (reason === 'rejected') {
    return { error: `${toolName}: 사람이 이 호출을 거절했다. 같은 턴에서 같은 도구를 다시 요청하지 말고, 이유를 묻거나 다른 길을 제안하라 — 실행하지 않았다 (tool not run: approval ${reason})` };
  }
  if (reason === 'timeout') {
    return { error: `${toolName}: 사람의 답이 없었다(시한 초과) — 실행하지 않았다. 사용자에게 한 줄로 알려라 (tool not run: approval ${reason})` };
  }
  const why = reason === 'cancelled' ? '승인 요청이 취소됐다' : '승인을 받지 못했다';
  return { error: `${toolName}: ${why} — 실행하지 않았다 (tool not run: approval ${reason})` };
}

/** One policy per ACP server: grants are scoped to the session AND exact tool
 * name, not to a turn, connection, argument set, or other session. */
export function createAcpSessionApprovalPolicy(): {
  resolve: (
    sessionId: string,
    request: Parameters<AcpTurnContext['requestApproval']>[0],
    requestApproval: AcpTurnContext['requestApproval'],
    rejectedThisTurn?: Set<string>,
  ) => Promise<AcpToolApprovalResult>;
  clearSession: (sessionId: string) => void;
} {
  const alwaysAllowed = new Map<string, Set<string>>();
  const sessionGenerations = new Map<string, number>();
  const observe = (event: 'requested' | 'decided' | 'timeout' | 'remembered', sessionId: string, tool: string, outcome?: string) => {
    // Tool arguments are deliberately not logged.
    debug.log('acp.approval', event, { sessionId, tool, ...(outcome !== undefined ? { outcome } : {}) });
  };
  // Same-turn calls to one tool are asked one at a time, so a concurrent second call sees the first's denial
  // instead of opening a second sheet (round 1 should-fix).
  const turnInflight = new WeakMap<Set<string>, Map<string, Promise<void>>>();
  const decide = async (
    sessionId: string,
    request: Parameters<AcpTurnContext['requestApproval']>[0],
    requestApproval: AcpTurnContext['requestApproval'],
    rejectedThisTurn?: Set<string>,
  ): Promise<AcpToolApprovalResult> => {
      if (rejectedThisTurn?.has(request.toolName)) {
        debug.log('acp.approval', 'repeat-denied', { sessionId, tool: request.toolName });
        return { allowed: false, reason: 'rejected' };
      }
      if (alwaysAllowed.get(sessionId)?.has(request.toolName)) {
        observe('remembered', sessionId, request.toolName, 'allow-always');
        return { allowed: true };
      }
      const generation = sessionGenerations.get(sessionId) ?? 0;
      observe('requested', sessionId, request.toolName);
      let decision: AcpApprovalDecision;
      try {
        decision = await requestApproval(request);
      } catch {
        observe('decided', sessionId, request.toolName, 'error');
        return { allowed: false, reason: 'error' };
      }
      observe(decision === 'timeout' ? 'timeout' : 'decided', sessionId, request.toolName, decision);
      if (generation !== (sessionGenerations.get(sessionId) ?? 0)) return { allowed: false, reason: 'cancelled' };
      if (decision === 'allow-always') {
        let tools = alwaysAllowed.get(sessionId);
        if (!tools) {
          tools = new Set();
          alwaysAllowed.set(sessionId, tools);
        }
        tools.add(request.toolName);
      }
      if (decision === 'allow-once' || decision === 'allow-always') return { allowed: true };
      if (decision === 'deny-once' || decision === 'deny-always') rejectedThisTurn?.add(request.toolName);
      return {
        allowed: false,
        reason: decision === 'timeout' ? 'timeout' : decision === 'cancelled' ? 'cancelled' : 'rejected',
      };
  };
  return {
    async resolve(sessionId, request, requestApproval, rejectedThisTurn) {
      if (!requiresAcpToolApproval(request.toolName)) return { allowed: true };
      if (!rejectedThisTurn) return decide(sessionId, request, requestApproval);
      let inflight = turnInflight.get(rejectedThisTurn);
      if (!inflight) {
        inflight = new Map();
        turnInflight.set(rejectedThisTurn, inflight);
      }
      const prior = inflight.get(request.toolName);
      let release!: () => void;
      const mine = new Promise<void>((done) => { release = done; });
      const chained = (prior ?? Promise.resolve()).then(() => mine);
      inflight.set(request.toolName, chained);
      try {
        if (prior) await prior;
        return await decide(sessionId, request, requestApproval, rejectedThisTurn);
      } finally {
        release();
        if (inflight.get(request.toolName) === chained) inflight.delete(request.toolName);
      }
    },
    clearSession(sessionId) {
      alwaysAllowed.delete(sessionId);
      sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1);
    },
  };
}
