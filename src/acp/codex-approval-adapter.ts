// Codex approval adapter · H4 Phase 3.A scaffold.
//
// A thin bridge between elanous's existing HITL primitives (`AcpPermissionApprover`
// + `AcpQuestionApprover`) and the Codex-specific approval events that
// will land when we switch to app-server RPC in Phase 3.B:
//
//   - `ApplyExecPolicyAmendment`  — server asks client to approve an
//     exec command policy change (e.g. network access, specific shell)
//   - `ApplyNetworkPolicyAmendment` — server asks client to approve a
//     network egress policy change
//   - MCP tool-call approval — server may ask approval per-tool before
//     invoking a local stdio MCP server
//
// Why now (Phase 3.A) vs. wait for 3.B:
//   - Phase 3.B (app-server RPC client) is a multi-session arc (~1800
//     LOC · 8773-line Rust protocol to mirror). When it lands, wiring
//     the HITL bridge should be a drop-in: `adapter.onExec(...)`,
//     `adapter.onNetwork(...)`, `adapter.onMcp(...)`. Standing this
//     module up now means we have a stable callsite for the client to
//     target and for tests to exercise.
//   - The CodexNativeAgent Phase 1 code already accepts approvers but
//     has no way to surface an approval request. This module is where
//     that wiring lives.
//
// Current behavior (Phase 3.A):
//   - Stores the two approver refs.
//   - Exposes `hasApprover('permission'|'question')` + getters.
//   - `onExecPolicyAmendment` / `onNetworkPolicyAmendment` / `onMcpToolCall`
//     default to a pass-through (returns approval = true) with a
//     debug-log trace. `logOnly: true` option makes it explicit.
//   - When an approver IS attached, falls through to the approver —
//     ready for the day the app-server RPC client wires real events to
//     these methods.

import { debug } from '../debug/log.js';
import type {
  AcpPermissionApprover,
  AcpPermissionApprovalRequest,
  AcpQuestionApprover,
  AcpQuestionRequest,
} from './client.js';

/** Shape of a Codex exec-policy amendment request translated into a
 *  HITL-digestible form. Fields chosen to mirror what the Rust app-
 *  server protocol surfaces (`codex-rs/app-server-protocol/src/protocol
 *  /v2.rs::ExecPolicyAmendment`) without importing the full type. */
export interface CodexExecPolicyAmendmentRequest {
  sessionId: string;
  command: string[];
  cwd: string;
  reason?: string;
  kind: 'exec-policy';
}

export interface CodexNetworkPolicyAmendmentRequest {
  sessionId: string;
  host: string;
  port?: number;
  protocol?: 'http' | 'https' | 'tcp' | string;
  reason?: string;
  kind: 'network-policy';
}

export interface CodexMcpToolCallRequest {
  sessionId: string;
  server: string;
  tool: string;
  args?: unknown;
  kind: 'mcp-tool-call';
}

export type CodexApprovalRequest =
  | CodexExecPolicyAmendmentRequest
  | CodexNetworkPolicyAmendmentRequest
  | CodexMcpToolCallRequest;

export interface CodexApprovalDecision {
  approved: boolean;
  /** Approval scope when `approved`. `'session'` maps to codex
   *  `acceptForSession` so the user's "allow for this session" choice
   *  suppresses re-prompts server-side. Defaults to `'once'`. Only set
   *  when the user was asked via the multi-option question path. */
  scope?: 'once' | 'session';
  /** Free-form comment surfaced back to Codex. Rust protocol accepts
   *  a `reviewer_comment` field on `ReviewDecision`. */
  comment?: string;
}

export interface CodexApprovalAdapterOpts {
  permissionApprover?: AcpPermissionApprover | null;
  questionApprover?: AcpQuestionApprover | null;
  /** When true, NO approver invocation — approve by default with a
   *  debug trace. Used in tests and for the "no HITL attached" path. */
  logOnly?: boolean;
}

export interface CodexApprovalAdapter {
  setPermissionApprover(a: AcpPermissionApprover | null): void;
  setQuestionApprover(a: AcpQuestionApprover | null): void;
  hasApprover(kind: 'permission' | 'question'): boolean;
  onExecPolicyAmendment(req: CodexExecPolicyAmendmentRequest): Promise<CodexApprovalDecision>;
  onNetworkPolicyAmendment(req: CodexNetworkPolicyAmendmentRequest): Promise<CodexApprovalDecision>;
  onMcpToolCall(req: CodexMcpToolCallRequest): Promise<CodexApprovalDecision>;
}

/** The 3-way approval question's id and labels — exported so a surface that
 *  answers approvals by yes/no (an ACP turn's client) can recognise it. */
export const CODEX_APPROVAL_QUESTION_ID = 'codex_approval';
export const CODEX_APPROVAL_OPT_ONCE = 'Allow once';
export const CODEX_APPROVAL_OPT_REJECT = 'Reject';

/** Build a CodexApprovalAdapter. Intentionally minimal in Phase 3.A —
 *  the handlers degrade gracefully when no approver is attached, and
 *  the Phase 3.B app-server client will hook these methods up with real
 *  request/response plumbing. */
export function createCodexApprovalAdapter(
  opts: CodexApprovalAdapterOpts = {},
): CodexApprovalAdapter {
  let permission: AcpPermissionApprover | null = opts.permissionApprover ?? null;
  let question: AcpQuestionApprover | null = opts.questionApprover ?? null;
  const logOnly = opts.logOnly === true;

  const autoApprove = (
    req: CodexApprovalRequest,
    reason: string,
  ): CodexApprovalDecision => {
    if (debug.enabled) {
      debug.log('acp.codex.approval.auto-approve', req.sessionId, {
        kind: req.kind,
        reason,
      });
    }
    return { approved: true, comment: reason };
  };

  // 3-way approval option labels — surfaced as inline buttons when the
  // multi-option question path is used. "Allow for session" maps to codex
  // `acceptForSession` so the sub-agent stops re-prompting for the rest of
  // the run.
  const OPT_ONCE = CODEX_APPROVAL_OPT_ONCE;
  const OPT_SESSION = 'Allow for session';
  const OPT_REJECT = CODEX_APPROVAL_OPT_REJECT;
  const APPROVAL_QID = CODEX_APPROVAL_QUESTION_ID;

  /** Ask the user via the MULTI-OPTION question channel: Allow once /
   *  Allow for session / Reject. Returns the scoped decision. Only called
   *  when a questionApprover is attached. */
  const askQuestion = async (
    req: CodexApprovalRequest,
    title: string,
  ): Promise<CodexApprovalDecision> => {
    const qReq: AcpQuestionRequest = {
      backendId: 'codex-app-server',
      sessionId: req.sessionId,
      questions: [{
        id: APPROVAL_QID,
        header: 'Approve?',
        question: title,
        options: [
          { label: OPT_ONCE, description: 'Allow this action once' },
          { label: OPT_SESSION, description: 'Allow this + similar for the rest of the session' },
          { label: OPT_REJECT, description: 'Reject this action' },
        ],
        multiSelect: false,
        includeOther: false,
      }],
    };
    const resp = await question!(qReq);
    if (resp.cancelled) return { approved: false, comment: 'cancelled' };
    const ans = resp.answers?.[APPROVAL_QID];
    const label = Array.isArray(ans) ? ans[0] : ans;
    if (label === OPT_SESSION) return { approved: true, scope: 'session', comment: 'allowed for session' };
    if (label === OPT_ONCE) return { approved: true, scope: 'once', comment: 'allowed once' };
    return { approved: false, comment: 'rejected' };
  };

  /** Translate a Codex approval request into a HITL prompt and await the
   *  decision. Prefers the 3-way question path (Allow once / session /
   *  reject) when a questionApprover is attached; falls back to the yes/no
   *  permission approver (once/deny). Default-deny on throw. */
  const askPermission = async (
    req: CodexApprovalRequest,
    title: string,
    kind: string,
    rawInput?: unknown,
  ): Promise<CodexApprovalDecision> => {
    try {
      if (question) return await askQuestion(req, title);
      if (!permission) return autoApprove(req, 'no approver attached');
      const permReq: AcpPermissionApprovalRequest = {
        backendId: 'codex-app-server',
        sessionId: req.sessionId,
        title,
        kind,
        rawInput,
        options: [
          { optionId: 'allow_once', name: 'Allow this once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow this kind', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      };
      const approved = await permission(permReq);
      return { approved, scope: 'once', comment: approved ? 'allowed' : 'rejected' };
    } catch (err) {
      if (debug.enabled) {
        debug.log('acp.codex.approval.err', req.sessionId, {
          kind: req.kind,
          message: (err as Error)?.message,
        });
      }
      // Conservative fallback: deny on adapter failure. Matches elanous's
      // "default deny" posture everywhere else.
      return { approved: false, comment: 'approver threw' };
    }
  };

  return {
    setPermissionApprover(a) { permission = a ?? null; },
    setQuestionApprover(a) { question = a ?? null; },
    hasApprover(kind) {
      if (kind === 'permission') return permission !== null;
      return question !== null;
    },
    async onExecPolicyAmendment(req) {
      if (logOnly) return autoApprove(req, 'logOnly');
      return askPermission(
        req,
        `codex exec: ${req.command.join(' ')}`,
        'exec-policy',
        { command: req.command, cwd: req.cwd, reason: req.reason },
      );
    },
    async onNetworkPolicyAmendment(req) {
      if (logOnly) return autoApprove(req, 'logOnly');
      return askPermission(
        req,
        `codex network: ${req.protocol ?? 'tcp'}://${req.host}${req.port ? ':' + req.port : ''}`,
        'network-policy',
        { host: req.host, port: req.port, protocol: req.protocol },
      );
    },
    async onMcpToolCall(req) {
      if (logOnly) return autoApprove(req, 'logOnly');
      return askPermission(
        req,
        `codex mcp: ${req.server}.${req.tool}`,
        'mcp-tool-call',
        { server: req.server, tool: req.tool, args: req.args },
      );
    },
  };
}

/** Flatten an ACP `McpServer[]` array into the Codex CLI config shape.
 *  Codex reads MCP servers from `[mcp_servers.<name>]` TOML tables; the
 *  SDK's `CodexOptions.config` serializes nested objects into dotted
 *  `--config mcp_servers.<name>.command=...` overrides. Only stdio
 *  MCP transport is mapped — HTTP/SSE require Codex-side support that
 *  isn't exposed through SDK config today (Phase 3.B covers that via
 *  app-server). Unrecognized transports are dropped with a debug log. */
export function flattenMcpServersToCodexConfig(
  mcpServers: ReadonlyArray<{ type?: string; name: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> | Record<string, string>; url?: string }>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of mcpServers) {
    const type = s.type ?? 'stdio';  // ACP `McpServerStdio` has no `type` field (it's the absent-type variant)
    const isStdio = type === 'stdio' || (!s.type && typeof s.command === 'string');
    if (!isStdio) {
      if (debug.enabled) {
        debug.log('acp.codex.mcp.skip-non-stdio', s.name, { type });
      }
      continue;
    }
    // Stdio entry MUST have a command — Codex CLI can't launch otherwise.
    if (typeof s.command !== 'string' || s.command.length === 0) {
      if (debug.enabled) {
        debug.log('acp.codex.mcp.skip-no-command', s.name, {});
      }
      continue;
    }
    const entry: Record<string, unknown> = { command: s.command };
    if (Array.isArray(s.args)) entry.args = [...s.args];
    if (s.env) {
      entry.env = Array.isArray(s.env)
        ? Object.fromEntries(s.env.map((e) => [e.name, e.value]))
        : { ...s.env };
    }
    out[s.name] = entry;
  }
  return out;
}
