// ── ShellRunner module barrel ──
//
// Public surface of the unified 4-mode shell execution layer. See
// 내부 문서 `CAPABILITIES-shell-runner` + 내부 문서 `PLAN-session-nt`.

export * from './types.js';
export { createPtyCaptureEngine } from './pty-engine.js';
export type { TerminalHost, PtyEngineOpts } from './pty-engine.js';
export { createFileCaptureEngine } from './file-engine.js';
export type { FileEngineOpts } from './file-engine.js';
export {
  createShellRegistry,
  initShellRegistry,
  getShellRegistry,
  resetShellRegistry,
} from './registry.js';
export type { ShellRegistry, ShellRegistryOpts } from './registry.js';
export { createInlineSurface } from './inline-surface.js';
export type { InlineSurface, InlineSurfaceOpts, InlineSnapshot } from './inline-surface.js';
export { createBackgroundSurface } from './background-surface.js';
export type {
  BackgroundSurface,
  BackgroundSurfaceOpts,
  BgRollup,
  BgEntry,
} from './background-surface.js';
export { createModalSurface } from './modal-surface.js';
export type { ModalSurface, ModalSurfaceOpts, ModalSnapshot } from './modal-surface.js';
export { createVwSurface } from './vw-surface.js';
export type { VwSurface, VwSurfaceOpts, VwSnapshot } from './vw-surface.js';
export {
  promoteSurface,
  autoBgTargetFor,
  isLegalPromote,
} from './surface-promote.js';
export type { PromoteOpts as SurfacePromoteOpts } from './surface-promote.js';
export {
  runShell,
  resolveMode,
  setShellRunnerDeps,
  getShellRunnerDeps,
  resetShellRunnerDeps,
} from './dispatch.js';
export type { ShellRunnerDeps, RunShellOpts } from './dispatch.js';
export { decideAttach } from './attach-routing.js';
export type { AttachOutcome, AttachRoutingDeps } from './attach-routing.js';
export {
  detectShellKind,
  makeOsc133RcFile,
} from './osc133-rc.js';
export type { SupportedShell, RcFileHandle } from './osc133-rc.js';
