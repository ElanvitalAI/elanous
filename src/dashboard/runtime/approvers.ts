// Dashboard-side approvers — T1-P2.
//
// Bridges the mutating-LLM-tool approval protocol to the shared
// approval modal. Each create…Approver() factory returns a function
// that matches a specific tool's approval-request shape; internally
// they all route through the same openApproval() primitive so the
// user sees a consistent Yes/No modal regardless of which tool
// asked.
//
// Wiring responsibility:
//   • dashboard.ts calls initDashboardApprovers(coord, termSize) at
//     startup.
//   • skill-runner.ts pulls the factories and injects them into the
//     three approver-requiring dispatchers (TerminalModalInject,
//     PaneInject, BroadcastPanes).
//   • dashboard.ts readKey loop forwards keys to approvalModalRouter
//     whenever a modal is active (Y/N/Esc).

import {
  createApprovalModal,
  approvalModalRouter,
  type ApprovalModalHandle,
} from '../../approval-modal.js';
import { C } from '../../tui.js';
import type { DisplayCoordinator } from '../../display/coordinator.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import type { InjectApprovalRequest } from '../../skills/tools/terminal-modal-inject.js';
import type { AcpPermissionApprovalRequest } from '../../acp/client.js';
import type {
  ApprovalRequest as ShellApprovalRequest,
  ApprovalDecision as ShellApprovalDecision,
} from '../../shell-primitive/index.js';
import {
  renderEditBlock,
  type CodeEditApprovalRequest,
} from '../../code-edit/index.js';

export interface PaneInjectApprovalRequest {
  paneAddr: string;
  paneKind: string;
  previewBytes: string;
  totalBytes: number;
}

export interface BroadcastApprovalRequest {
  targets: string[];
  previewBytes: string;
  totalBytes: number;
}

export interface DashboardApproversDeps {
  coordinator: DisplayCoordinator;
  termSize: () => { cols: number; rows: number };
  getTheme?: () => ThemeTokens | null | undefined;
}

let state: DashboardApproversDeps | null = null;

export function initDashboardApprovers(deps: DashboardApproversDeps): void {
  state = deps;
}

export function _resetDashboardApproversForTesting(): void {
  approvalModalRouter._resetForTesting();
  state = null;
}

interface OpenApprovalSpec {
  title: string;
  prompt: string;
  detail?: string | string[];
  yesLabel?: string;
  noLabel?: string;
}

async function openApproval(spec: OpenApprovalSpec): Promise<boolean> {
  if (!state) {
    throw new Error('dashboard approvers not initialized — call initDashboardApprovers first');
  }
  const { cols, rows } = state.termSize();
  const width = Math.min(70, Math.max(40, cols - 4));
  const detailLineCount = Array.isArray(spec.detail)
    ? spec.detail.length
    : spec.detail ? spec.detail.split('\n').length : 0;
  const height = Math.min(Math.max(7, rows - 4), 6 + Math.min(8, detailLineCount));
  const bounds = {
    row: Math.max(1, Math.floor((rows - height) / 2)),
    col: Math.max(1, Math.floor((cols - width) / 2)),
    width,
    height,
  };
  const modal = createApprovalModal({
    id: `approval:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
    bounds,
    title: spec.title,
    prompt: spec.prompt,
    detail: spec.detail,
    yesLabel: spec.yesLabel,
    noLabel: spec.noLabel,
    theme: state.getTheme?.() ?? undefined,
  });
  const modalHandle = state.coordinator.pushModal(modal.surface);
  const installed = approvalModalRouter.set(modal, () => {
    try { modalHandle.dispose(); } catch { /* ignore */ }
  }, 'approval');
  if (!installed) {
    // Another approval is already pending — reject this one rather
    // than stacking prompts on the user. The caller surfaces this
    // as "rejected by user" via the tool-level guard.
    modal.dispose(false);
    try { modalHandle.dispose(); } catch { /* ignore */ }
    return false;
  }
  return modal.promise;
}

export function createInjectApprover(): (req: InjectApprovalRequest) => Promise<boolean> {
  return async (req) => openApproval({
    title: 'Approve terminal inject?',
    prompt: `${req.sessionTitle} (${req.sessionId.slice(0, 12)}) ← ${req.totalBytes} bytes`,
    detail: req.isKey
      ? `key: ${req.keyName}`
      : `preview: ${req.previewBytes}`,
  });
}

export function createPaneInjectApprover(): (req: PaneInjectApprovalRequest) => Promise<boolean> {
  return async (req) => openApproval({
    title: 'Approve pane inject?',
    prompt: `${req.paneAddr} (${req.paneKind}) ← ${req.totalBytes} bytes`,
    detail: `preview: ${req.previewBytes}`,
  });
}

export function createBroadcastApprover(): (req: BroadcastApprovalRequest) => Promise<boolean> {
  return async (req) => openApproval({
    title: 'Approve pane broadcast?',
    prompt: `${req.targets.length} panes ← ${req.totalBytes} bytes`,
    detail: `targets: ${req.targets.join(', ')}\npreview: ${req.previewBytes}`,
  });
}

// T6-K4 — config-set approver. Surfaces the key + old → new value
// so the user can judge intent at a glance before confirming.
export interface ConfigSetApprovalRequest {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

export function createConfigSetApprover(): (req: ConfigSetApprovalRequest) => Promise<boolean> {
  return async (req) => openApproval({
    title: 'Approve config change?',
    prompt: `${req.key}`,
    detail: `${JSON.stringify(req.oldValue)} → ${JSON.stringify(req.newValue)}`,
  });
}

/** Shell-primitive approver. Maps the modal's binary answer to an
 *  ApprovalDecision:
 *   • yes → `allow-session` (remember for the session — cache hit next
 *     time the same (cwd,argv) runs, skipping the prompt).
 *   • no  → `deny-once` (block this call; don't poison the cache so
 *     a fresh approval can still pass later).
 *
 *  Callers that want a strict "allow just this call" or "deny forever"
 *  semantics pick approval='always' or 'none' at the ShellRequest
 *  level and the runtime obeys — but the modal itself stays binary
 *  so the UX doesn't change per tool. */
export function createShellApprover(): (req: ShellApprovalRequest) => Promise<ShellApprovalDecision> {
  return async (req) => {
    const argvPreview = req.command.join(' ');
    const ok = await openApproval({
      title: 'Approve shell command?',
      prompt: argvPreview.length > 60 ? argvPreview.slice(0, 59) + '…' : argvPreview,
      detail: [
        `cwd: ${req.cwd}`,
        req.context ?? '',
      ].filter(Boolean).join('\n'),
      yesLabel: 'Allow session (y)',
      noLabel: 'Deny once (n)',
    });
    return ok ? 'allow-session' : 'deny-once';
  };
}

export function createCodeEditApprover(): (req: CodeEditApprovalRequest) => Promise<boolean> {
  return async (req) => {
    let detail: string | string[] = [
      req.changeSummary,
      req.reason ? `(${req.reason})` : '',
    ].filter(Boolean).join('\n');
    if (req.preview) {
      const cols = Math.min(72, Math.max(44, state?.termSize().cols ?? 72) - 12);
      const rows = renderEditBlock({
        ok: true,
        file_path: req.file_path,
        structuredPatch: req.preview.structuredPatch,
        originalContent: req.preview.originalContent,
        newContent: req.preview.newContent,
        edits: [{ old_string: req.preview.originalContent, new_string: req.preview.newContent }],
        linesAdded: req.preview.linesAdded,
        linesRemoved: req.preview.linesRemoved,
      }, {
        cols,
        syntax: false,
        headerStyle: 'edited',
      });
      detail = [
        req.changeSummary,
        req.reason ? `(${req.reason})` : '',
        '',
        ...rows.slice(0, 8),
        ...(rows.length > 8 ? [C.muted(`… ${rows.length - 8} more lines`)] : []),
      ].filter(Boolean);
    }
    return openApproval({
      title: req.kind === 'edit' ? 'Approve file edit?' : 'Approve file write?',
      prompt: req.file_path,
      detail,
    });
  };
}

export function createAcpPermissionApprover(): (req: AcpPermissionApprovalRequest) => Promise<boolean> {
  return async (req) => {
    const raw = req.rawInput === undefined ? '' : JSON.stringify(req.rawInput, null, 2);
    const options = req.options.map(o => `${o.kind}: ${o.name}`).join('\n');
    const detail = [
      `backend: ${req.backendId}`,
      `session: ${req.sessionId}`,
      req.kind ? `kind: ${req.kind}` : '',
      options ? `options:\n${options}` : '',
      raw ? `input:\n${raw}` : '',
    ].filter(Boolean).join('\n');
    return openApproval({
      title: 'Approve ACP tool?',
      prompt: req.title,
      detail,
      yesLabel: 'Allow (y)',
      noLabel: 'Reject (n/Esc)',
    });
  };
}

/** Expose a testing hook — some tests want to bypass the modal
 *  entirely by injecting a direct approver function. */
export function _testOpenApproval(spec: OpenApprovalSpec): Promise<boolean> {
  return openApproval(spec);
}

/** F1 — Phase 3 · open a generic approval modal. Same path as the
 *  tool-specific approvers (`createCodeEditApprover` etc.) so the
 *  ACP `requestPermission` fallback shares UX with direct-dispatch
 *  approvals. Exported without the `_test` prefix because it's a
 *  production entry point for the ACP bridge. */
export function openGenericApproval(spec: OpenApprovalSpec): Promise<boolean> {
  return openApproval(spec);
}

/** Bound approver used by the ApprovalModalHandle tests. Resolves
 *  immediately without invoking the coordinator — useful when the
 *  caller only needs to verify the request shape. */
export function makeAutoApprover<R>(answer: boolean): (req: R) => Promise<boolean> {
  return async () => answer;
}
