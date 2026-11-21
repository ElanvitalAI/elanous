// ── shell-primitive public API ──
//
// Consumers (skill-runner, internal routers, future skill-tool-shell)
// import from './shell-primitive'. Tests reach into the sub-modules
// directly for the cache reset seam.

export { runShell, gateShellCommand, setShellApprover } from './runtime.js';
export { commandKey } from './approval-cache.js';
export {
  recordAudit, setAuditLogRootForTesting, setAuditSinkForTesting,
  type AuditEvent,
} from './audit-log.js';
export {
  applySandbox, buildMacOsProfile, buildLinuxBwrapArgs,
  resolveBwrapPath, SandboxUnavailableError,
  type SandboxMode, type NetworkMode, type SandboxDecision, type SandboxTool,
} from './sandbox.js';
export {
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, SHELL_MAX_OUTPUT,
  type ShellRequest, type ShellResult, type ShellApprover,
  type ApprovalDecision, type ApprovalRequest,
} from './types.js';
export {
  getSandboxEscalationPrompt,
  buildSandboxEscalationSystemMessages,
  detectSandboxFailure,
} from './escalation-prompt.js';
