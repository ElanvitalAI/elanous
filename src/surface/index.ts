// ── IUL Phase S·a — public barrel ──

export {
  type SurfaceAddress,
  type SurfaceKind,
  surfaceKey,
  isSurfaceKind,
  sameSurface,
} from './address.js';

export {
  Z_TIER,
  SURFACE_KIND_FAMILY_POLICY,
  Z_TIER_ORDER,
  zTierRank,
  isZTier,
  zTiersCompatible,
  surfaceKindFamilyPolicy,
  modalTierToZTier,
  defaultZTierForKind,
  coerceZTier,
  normalizeZOrderTier,
  compareByZSemantics,
  type ZTier,
} from './z-tier.js';

export {
  hitKeyFromHit,
  legacyHitKeyAliasesFromHit,
  wildcardHitKeyFromHit,
  surfaceIdFromHit,
  legacySurfaceIdAliasesFromHit,
  surfaceAddressFromSurfaceId,
  hitFromSurfaceId,
  hitMatchesSurfaceId,
  surfaceAddressFromHit,
  surfaceKindFromHit,
} from './hit-projection.js';

export {
  createSurfaceRegistry,
  getSurfaceRegistry,
  __setGlobalSurfaceRegistry,
  type SurfaceRegistry,
  type SurfaceDescriptor,
  type SurfaceEvent,
  type SurfaceEventKind,
  type RegisterOpts,
  type UpdateOpts,
} from './registry.js';

export {
  createAuthoredSurfaceRegistry,
  getAuthoredSurfaceRegistry,
  __setGlobalAuthoredSurfaceRegistry,
  type AuthoredSurfaceRegistry,
  type AuthoredSurfaceDescriptor,
  type AuthoredSurfaceEvent,
  type AuthoredSurfaceEventKind,
  type AuthoredSurfaceSourceKind,
  type AuthoredSurfaceTargetKind,
  type AuthoredSurfaceRenderState,
  type RegisterAuthoredSurfaceOpts,
  type UpdateAuthoredSurfaceOpts,
} from './authored-surface-registry.js';

export {
  wireModalSurfaceAdapter,
  type ModalSurfaceAdapterOpts,
  type ModalSurfaceAdapterHandle,
} from './adapters/modal-surface-adapter.js';

export {
  registerPaneSurface,
  unregisterPaneSurface,
  importFactorySnapshot,
  type ImportSnapshotOpts,
} from './adapters/pane-surface-adapter.js';

export {
  wireWidgetSurfaceAdapter,
  type WidgetSurfaceAdapterOpts,
  type WidgetSurfaceAdapterHandle,
} from './adapters/widget-surface-adapter.js';

export {
  registerPopoverSurface,
  unregisterPopoverSurface,
  popoverIdFromAnchor,
  type PopoverRegisterOpts,
} from './adapters/popover-surface-adapter.js';

export {
  registerInlineSurface,
  unregisterInlineSurface,
  bindInlineSurfaceToRegistry,
  type InlineRegisterOpts,
  type BindInlineOpts,
  type InlineBindHandle,
  type InlineSurfaceLike,
} from './adapters/inline-surface-adapter.js';

export {
  registerBackgroundHandle,
  unregisterBackgroundHandle,
  bindBackgroundSurfaceToRegistry,
  type BgRegisterOpts,
  type BindBackgroundOpts,
  type BgBindHandle,
  type BackgroundSurfaceLike,
  type BgEntryLike,
  type BgRollupLike,
} from './adapters/bg-surface-adapter.js';

export {
  wireShellRunnerSurface,
  type WireShellRunnerSurfaceOpts,
  type WireShellRunnerSurfaceHandle,
} from './adapters/shell-runner-wiring.js';

export {
  buildGetUIStateTool,
  buildDescribeSurfaceTool,
  buildObserveSurfaceTool,
  dispatchGetUIState,
  dispatchDescribeSurface,
  dispatchObserveSurface,
  type GetUIStateOut,
  type UIStateSurface,
  type DescribeSurfaceOut,
  type ObserveSurfaceArgs,
  type ObserveSurfaceOut,
  type ObserveSurfaceEventOut,
  type SurfaceUIDeps,
  type SurfaceUIWidgetHost,
} from './llm-tools.js';
