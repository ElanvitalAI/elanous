// ─────────────────────────────────────────────────────────────────
// App-level ModalType registry — Phase B-3a of PLAN-modal-lifecycle-
// primitive.md · ROADMAP-interaction-fabric §5.2 #14.
//
// B-2 landed generic `__coord-mirror:<tier>` types that cover every
// coordinator.pushModal() call via idempotency-keyed replacement. B-3a
// adds **named application-level types** alongside the mirror types so
// future caller migrations (B-3b pilot + B-3c) can use stable type
// names (`'attachment-popup'`, `'approval-dialog'`, …) instead of
// routing through the generic mirror path.
//
// What this file does
//   Single source of truth for the list of app-level modal types that
//   the coordinator auto-registers at construction time. `registerApp
//   ModalTypes(lifecycle)` is idempotent-friendly (callers may call it
//   exactly once; re-registration is a caller error and throws via the
//   primitive's name-uniqueness guard).
//
// What this file does NOT do
//   • It does NOT migrate any caller. coordinator.pushModal(surface)
//     still flows through the mirror types from B-2. Caller migration
//     (e.g. attachment popup → `mlc.push('attachment-popup', …)`) is
//     Phase B-3b.
//   • It does NOT carry any surface-construction logic. All factories
//     here are passthrough: the `state` argument IS the pre-built
//     ModalSurface from the caller's existing factory (createAttachment
//     PopupSurface, createApprovalModal, …). B-3b will migrate one
//     specific type (attachment-popup) to a declarative factory
//     signature; the rest follow in B-3c group-by-group.
//
// Why passthrough instead of real factories now
//   Each app-level modal has a bespoke spec shape (approval uses
//   yes/no strings, slash-picker uses a getFiltered callback, terminal
//   modal takes a command + cwd, …). A single ModalType<S> with
//   non-passthrough factory would either (a) force all specs to share
//   a type (loses typing) or (b) require a generic `ModalType<S>` per
//   caller-site which defeats the "register once at boot" goal. The
//   passthrough approach keeps B-3a additive + lets B-3b/c migrate
//   each caller one at a time, flipping its factory to a real one
//   when we're ready to delete the legacy surface construction path.
//
// Safety / backward compat
//   • App types use non-colon-prefixed names (`'attachment-popup'`,
//     not `'__coord-mirror:popup'`) so the two families never collide.
//   • `coordinator.pushModal(surface)` is unchanged — it uses the
//     mirror types. App types are opt-in via direct
//     `modalLifecycleAPI().push(typeName, opts, surface)` from future
//     caller migrations.
//   • If a caller migrates (B-3b), its push() replaces the
//     coordinator.pushModal() route. The surface.id-keyed duplicate
//     replacement policy is identical to the mirror path, so the
//     observable stack behaviour is preserved.
// ─────────────────────────────────────────────────────────────────

import type { ModalLifecycle, ModalType } from '../primitives/modal-lifecycle/index.js';
import type { ModalSurface } from './modal-stack.js';
import type { ModalTier } from './types.js';

/** Application-level modal type name. Each literal below must be
 *  unique and kebab-case. Adding a new kind: (1) add a literal here,
 *  (2) add a row to `APP_MODAL_TYPES` below. Downstream code that
 *  wants to type-check push-site type names can reference this union. */
export type AppModalTypeName =
  | 'approval-dialog'
  | 'ask-user-question-modal'
  | 'slash-picker'
  | 'arg-picker'
  | 'at-picker'
  | 'search-modal'
  | 'interactive-terminal-modal'
  | 'attachment-popup'
  | 'vw-rename'
  | 'plan-exit-modal'
  | 'transient-term'
  | 'pane-multi-modal'
  | 'model-picker'
  | 'wd-picker'
  | 'context-menu'
  | 'hover-tooltip'
  // DragSession primitive (ROADMAP §5.2 #16 · PLAN-drag-session-primitive.md)
  // consumers — pre-registered so DS-3 / DS-4 caller migrations can
  // push via typed API the day they land, without a registry edit.
  | 'copy-move-picker'         // DS-4b ambiguous drop disambiguation modal
  | 'drop-target-popover'      // DS-3 drop-zone highlight ephemeral popover
  // Widget-host instance opened as a modal-stack popup for /bg.
  | 'background-tasks-popup';

/** Declaration of an app-level modal type. `name` is the stable key
 *  downstream callers push with; `tier` controls z-order + scope
 *  classification in coordinator.topOfTier. */
interface AppModalTypeDecl {
  readonly name: AppModalTypeName;
  readonly tier: ModalTier;
}

/** Canonical list. Source of truth for which app types get auto-
 *  registered at coordinator boot. Ordering is documentary only —
 *  dialog/popup/picker families grouped for readability. Keep tier
 *  values in sync with the surface.tier each factory assigns. */
export const APP_MODAL_TYPES: readonly AppModalTypeDecl[] = [
  // Dialog tier (yes/no / multi-choice / rename / plan-exit)
  { name: 'approval-dialog',           tier: 'dialog' },
  { name: 'ask-user-question-modal',   tier: 'dialog' },
  { name: 'vw-rename',                 tier: 'dialog' },
  { name: 'plan-exit-modal',           tier: 'dialog' },

  // Picker tier (slash / arg / at / search / drag disambiguation)
  { name: 'slash-picker',              tier: 'picker' },
  { name: 'arg-picker',                tier: 'picker' },
  { name: 'at-picker',                 tier: 'picker' },
  { name: 'search-modal',              tier: 'picker' },
  { name: 'copy-move-picker',          tier: 'picker' },  // DragSession DS-4b

  // Popup tier (attachment / status-bar / multi-pane / drop-zone highlight)
  { name: 'attachment-popup',          tier: 'popup' },
  { name: 'model-picker',              tier: 'popup' },
  { name: 'wd-picker',                 tier: 'popup' },
  { name: 'pane-multi-modal',          tier: 'popup' },
  { name: 'drop-target-popover',       tier: 'popup' },   // DragSession DS-3

  // Terminal tier (interactive PTY modal)
  { name: 'interactive-terminal-modal', tier: 'terminal' },

  // Menu tier (context menus)
  { name: 'context-menu',              tier: 'menu' },

  // Tooltip tier (transient term notifications + hover tooltips)
  { name: 'transient-term',            tier: 'tooltip' },
  { name: 'hover-tooltip',             tier: 'tooltip' },
];

/** Passthrough factory shared by every app-level type. Takes the
 *  pre-built ModalSurface as `state` and returns it unchanged — same
 *  pattern as B-2's `__coord-mirror:<tier>` factories. B-3b will
 *  replace this for `'attachment-popup'` with a declarative factory;
 *  the rest keep passthrough until their caller group migrates. */
const passthroughFactory = (
  _ctx: unknown,
  state: unknown,
): ModalSurface => state as ModalSurface;

/** Register every app-level modal type on the given ModalLifecycle
 *  instance. Called once from DisplayCoordinator's constructor right
 *  after the `__coord-mirror:<tier>` loop. Safe to import from tests
 *  that spin up a standalone lifecycle (test/coordinator-modal-types-
 *  registry.test.ts exercises this path directly).
 *
 *  The primitive's `registerType` throws on duplicate names, so
 *  calling this twice on the same lifecycle will throw — callers who
 *  need re-registration (hot reload, plugin reload) should use the
 *  disposer returned from `registerType` and unregister first. */
export function registerAppModalTypes(lifecycle: ModalLifecycle): void {
  for (const decl of APP_MODAL_TYPES) {
    const type: ModalType<ModalSurface> = {
      name: decl.name,
      tier: decl.tier,
      factory: passthroughFactory,
    };
    lifecycle.registerType(type);
  }
}
