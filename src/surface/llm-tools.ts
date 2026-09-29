// ── IUL Phase L (subset) — LLM UX awareness tools ──
//
// Reads the live SurfaceRegistry (production-wired by Bundle 3) to
// give the LLM a single-call view of the screen. Three tools:
//
//   GetUIState({tier?, kind?, includeHidden?})
//     → z-ordered visible surfaces snapshot
//
//   DescribeSurface({addr})
//     → kind-agnostic detail block. Branches by addr.kind:
//       * pane    → describePane() result (capture/sources/pane-source)
//       * modal   → ModalIdentityRegistry.get(modalId) metadata
//       * widget  → READ-ONLY widget-host get(id) + defFor(id) snapshot
//       * other   → SurfaceDescriptor passthrough
//
//   ObserveSurface({addr?, durationMs, kind?})
//     → time-window collection of register/unregister/update events
//       from SurfaceRegistry.on(). Filterable by addr or kind.
//
// All three are READ-ONLY — no mutation surface in IUL Phase L per
// PLAN-iul-unified-observation.md. MaterializeFromIntent (Bundle 4W)
// is the write-side companion the widget team is shipping.
//
// Cross-track ownership notes (PLAN-iul-closure-roadmap §0.5):
//   * widget-host is widget-team owned; we only call its existing
//     read methods (`get` / `defFor` / `listInstanceIds`) — no edits.
//   * SurfaceRegistry / ModalIdentityRegistry / pane-source are
//     terminal-team owned, edited freely.

import type { LLMToolSpec } from '../llm.js';
import {
  getSurfaceRegistry,
  type SurfaceAddress,
  type SurfaceDescriptor,
  type SurfaceEvent,
  type SurfaceRegistry,
} from './index.js';
import { getModalIdentityRegistry, type ModalIdentityRegistry } from '../display/modal-identity.js';
import { describePane } from '../capture/sources/pane-source.js';
import type { PaneVisualStateStore } from '../panes/visual-state.js';
import { coerceZTier, isZTier } from './z-tier.js';

// ── DI shape — widget-host is OPT-IN, READ-ONLY ────────────────

/** Minimal widget-host face we consume for `DescribeSurface(widget)`.
 *  Defined here (not imported from `widget-host.ts`) so this module
 *  declares its read-only contract explicitly and stays decoupled from
 *  widget-team file evolution. The dashboard wires the real
 *  `WidgetHost` instance at register time.
 *
 *  Bundle 7T (2026-04-20) added two optional methods that widget-team
 *  shipped in Bundle 5W (WR-2): `describeSurfaceFor` and
 *  `snapshotHashFor`. Optional because older host implementations
 *  without the WR-2 API keep returning `undefined` for the new detail
 *  fields · never breaks the LLM tool response shape. */
export interface SurfaceUIWidgetHost {
  get(id: string): { id: string; type: string; character: string; state: unknown } | null;
  defFor(id: string): { type: string; description: string; defaultCharacter?: string } | null;
  listInstanceIds(): string[];
  /** WR-2 · Bundle 5W. Host returns `null` when the widget has no
   *  `describeSurface` override + no fallback description. */
  describeSurfaceFor?(id: string): string | null;
  /** WR-2 · Bundle 5W. Host returns `null` when the instance is
   *  unknown. Stable same-state-same-hash contract. */
  snapshotHashFor?(id: string): string | null;
}

export interface SurfaceUIDeps {
  readonly registry?: SurfaceRegistry;
  readonly identity?: ModalIdentityRegistry;
  readonly widgetHost?: SurfaceUIWidgetHost;
  /** Bundle B-8-β · PaneVisualStateStore — DescribeSurface(pane) reports
   *  its 4-axis visualState when a store is wired. Optional so tests
   *  and legacy callers that never set focusPolicy still work — the
   *  response simply omits `detail.visualState` in that case. */
  readonly store?: PaneVisualStateStore;
  /** Used by ObserveSurface so tests can advance time deterministically. */
  readonly now?: () => number;
  /** Used by ObserveSurface to inject a custom timer (tests). */
  readonly setTimeout?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

// ── GetUIState ─────────────────────────────────────────────────

export interface GetUIStateOut {
  readonly surfaces: readonly UIStateSurface[];
}

export interface UIStateSurface {
  readonly addr: SurfaceAddress;
  readonly kindTag: string;
  readonly tier?: string;
  readonly title?: string;
  readonly visible: boolean;
  readonly z: number;
  readonly surfaceId?: string;
  readonly registeredAt: number;
}

export function buildGetUIStateTool(): LLMToolSpec {
  return {
    name: 'GetUIState',
    description:
      'Snapshot every visible surface (pane / modal / widget / popover / inline / bg) on screen. '
      + 'Returns a z-ordered list; the LLM uses this to know what is currently in front of the user '
      + 'before issuing any DescribeSurface / ObserveSurface / Screenshot follow-up. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', description: 'Filter by tier hint (e.g. "modal", "vw"). Optional.' },
        kind: { type: 'string', description: 'Filter by addr.kind: pane | modal | widget | popover | inline | bg.' },
        includeHidden: { type: 'boolean', description: 'Include surfaces with visible=false. Default false.' },
      },
    },
  };
}

export function dispatchGetUIState(
  raw: Record<string, unknown>,
  deps: SurfaceUIDeps = {},
): GetUIStateOut {
  const registry = deps.registry ?? getSurfaceRegistry();
  const args = parseGetUIStateArgs(raw);
  // IUL Bundle 5T Phase 3 — use Phase Z listVisibleZOrdered when we
  // want visible-only. includeHidden path keeps the old registry.list
  // + manual sort so hidden entries still get a consistent `z` (and
  // remain debuggable).
  const base = args.includeHidden
    ? [...registry.list()].sort((a, b) => {
        const aZ = a.zHint ?? 0;
        const bZ = b.zHint ?? 0;
        if (aZ !== bZ) return aZ - bZ;
        return a.registeredAt - b.registeredAt;
      })
    : [...registry.listVisibleZOrdered()];
  // Filter AFTER sort so z indices reflect the full z-stack when
  // caller filters by tier/kind (matches LLM intuition: "I asked
  // for modals, show me their z in the full stack").
  const filtered = base.filter(d => {
    if (args.tier && !normalizedTierMatch(d.tier, args.tier)) return false;
    if (args.kind && d.addr.kind !== args.kind) return false;
    return true;
  });
  const surfaces: UIStateSurface[] = filtered.map((d, i) => ({
    addr: d.addr,
    kindTag: d.kindTag,
    visible: d.visible,
    z: i,
    registeredAt: d.registeredAt,
    ...(d.tier !== undefined ? { tier: d.tier } : {}),
    ...(d.title !== undefined ? { title: d.title } : {}),
    ...(d.surfaceId !== undefined ? { surfaceId: d.surfaceId } : {}),
  }));
  return { surfaces };
}

function normalizedTierMatch(descriptorTier: string | undefined, queryTier: string): boolean {
  if (descriptorTier === queryTier) return true;
  // When the LLM queries by a ZTier band ('modal' / 'popover' / ...),
  // match any descriptor whose rich tier rolls up to that band. This
  // lets `{tier: 'modal'}` surface both 'dialog' and 'picker'
  // descriptors. Rich-label queries (e.g. 'dialog') require exact
  // match — two rich labels rolling up to the same band are NOT
  // treated as equivalent.
  if (isZTier(queryTier)) return coerceZTier(descriptorTier) === queryTier;
  return false;
}

interface GetUIStateArgs {
  readonly tier?: string;
  readonly kind?: SurfaceAddress['kind'];
  readonly includeHidden: boolean;
}

function parseGetUIStateArgs(raw: Record<string, unknown>): GetUIStateArgs {
  const tier = typeof raw.tier === 'string' && raw.tier !== '' ? raw.tier : undefined;
  const kindRaw = raw.kind;
  const kind = (typeof kindRaw === 'string'
    && (kindRaw === 'pane' || kindRaw === 'modal' || kindRaw === 'widget'
      || kindRaw === 'popover' || kindRaw === 'inline' || kindRaw === 'bg'
      || kindRaw === 'window'))
    ? (kindRaw as SurfaceAddress['kind'])
    : undefined;
  const includeHidden = raw.includeHidden === true;
  return {
    ...(tier !== undefined ? { tier } : {}),
    ...(kind !== undefined ? { kind } : {}),
    includeHidden,
  };
}

// ── DescribeSurface ────────────────────────────────────────────

export interface DescribeSurfaceOut {
  readonly found: boolean;
  readonly addr?: SurfaceAddress;
  readonly kindTag?: string;
  readonly tier?: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly note?: string;
  readonly detail?: Record<string, unknown>;
}

export function buildDescribeSurfaceTool(): LLMToolSpec {
  return {
    name: 'DescribeSurface',
    description:
      'Return a kind-agnostic detail block for a single surface (looked up by SurfaceAddress). '
      + 'Pane → pane.describe() (title / summary / kind / supportedTaps / chords / tools) '
      + 'plus visualState (focus / visibility / placement / focusPolicy) when a VisualStateStore '
      + 'is wired — same shape as InspectPane + DescribePane, so the LLM can pick one tool per call. '
      + 'Modal → ModalIdentity metadata (kind / promotedFrom). '
      + 'Widget → widget instance + def snapshot (type / description / character / state preview). '
      + 'Other kinds → registry passthrough. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        addr: {
          type: 'object',
          description: 'SurfaceAddress discriminated union.',
          properties: {
            kind: { type: 'string', enum: ['pane', 'modal', 'widget', 'popover', 'inline', 'bg', 'window'] },
            // Kind-specific fields
            modalId: { type: 'string' },
            widgetId: { type: 'string' },
            popoverId: { type: 'string' },
            inlineId: { type: 'string' },
            bgId: { type: 'string' },
            // B-13-α · window kind · VW numeric id (integer).
            windowId: { type: 'integer', description: 'Virtual Window numeric id (kind="window" only).' },
            ref: {
              type: 'object',
              properties: {
                windowId: { type: 'string', description: 'Pane-kind ref · string "win:N" form.' },
                paneId: { type: 'string' },
                runnerLabel: { type: 'string' },
              },
            },
          },
          required: ['kind'],
        },
      },
      required: ['addr'],
    },
  };
}

export function dispatchDescribeSurface(
  raw: Record<string, unknown>,
  deps: SurfaceUIDeps = {},
): DescribeSurfaceOut {
  const addr = parseSurfaceAddress(raw.addr);
  if (!addr) {
    return { found: false, note: 'DescribeSurface: addr missing or malformed' };
  }
  const registry = deps.registry ?? getSurfaceRegistry();
  const desc = registry.get(addr);

  switch (addr.kind) {
    case 'pane': {
      const paneDesc = describePane({
        windowId: addr.ref.windowId,
        paneId: addr.ref.paneId,
        ...(addr.ref.runnerLabel !== undefined ? { runnerLabel: addr.ref.runnerLabel } : {}),
      });
      if (!paneDesc) {
        return passthrough(addr, desc, 'pane not resolved through PaneFactory');
      }
      // Bundle B-8-β · structure-equivalent to InspectPane (capture-tools)
      // so a future B-9 shim can project this branch back as an
      // InspectPane response. `visualState` is included only when the
      // caller wires a store — otherwise the field is omitted so legacy
      // callers see the previous shape.
      const chords = paneDesc.chords.map((c) => ({
        chord: c.chord,
        label: c.label,
        ...(c.mirrorTool !== undefined ? { mirrorTool: c.mirrorTool } : {}),
      }));
      const tools = paneDesc.tools.map((t) => ({
        tool: t.tool,
        label: t.label,
        ...(t.mirrorChord !== undefined ? { mirrorChord: t.mirrorChord } : {}),
      }));
      const visualState = deps.store?.snapshot(addr.ref);
      return {
        found: true,
        addr,
        kindTag: paneDesc.kind.kind,
        title: paneDesc.title,
        visible: desc?.visible ?? true,
        ...(desc?.tier !== undefined ? { tier: desc.tier } : {}),
        detail: {
          summary: paneDesc.summary,
          paneKind: paneDesc.kind,
          supportedTaps: [...paneDesc.supportedTaps],
          chords,
          tools,
          chordCount: paneDesc.chords.length,
          toolCount: paneDesc.tools.length,
          ...(visualState !== undefined ? { visualState } : {}),
        },
      };
    }
    case 'modal': {
      const idReg = deps.identity ?? getModalIdentityRegistry();
      const ident = idReg.get(addr.modalId);
      if (!ident) {
        return passthrough(addr, desc, 'modal identity not in registry (expired?)');
      }
      return {
        found: true,
        addr,
        kindTag: ident.kind,
        visible: desc?.visible ?? true,
        ...(desc?.tier !== undefined ? { tier: desc.tier } : {}),
        ...(desc?.title !== undefined ? { title: desc.title } : {}),
        detail: {
          modalId: ident.modalId,
          createdAt: ident.createdAt,
          ...(ident.surfaceId !== undefined ? { surfaceId: ident.surfaceId } : {}),
          promotedFromId: ident.promotedFrom?.modalId ?? null,
          chainDepth: countPromoteChain(ident),
        },
      };
    }
    case 'widget': {
      if (!deps.widgetHost) {
        return passthrough(addr, desc, 'widget-host not wired into describe');
      }
      const inst = deps.widgetHost.get(addr.widgetId);
      const def = deps.widgetHost.defFor(addr.widgetId);
      if (!inst) {
        return passthrough(addr, desc, 'widget instance not found');
      }
      // Bundle 7T: consume WR-2 public APIs when available. Optional
      // chain preserves backward compat with older hosts that don't
      // implement describeSurfaceFor / snapshotHashFor.
      const surfaceDescription = deps.widgetHost.describeSurfaceFor?.(addr.widgetId) ?? null;
      const stateHash = deps.widgetHost.snapshotHashFor?.(addr.widgetId) ?? null;
      return {
        found: true,
        addr,
        kindTag: inst.type,
        visible: desc?.visible ?? true,
        ...(desc?.tier !== undefined ? { tier: desc.tier } : {}),
        title: desc?.title ?? `${inst.type}(${inst.id})`,
        detail: {
          instanceId: inst.id,
          type: inst.type,
          character: inst.character,
          ...(def ? { description: def.description } : {}),
          statePreview: previewWidgetState(inst.state),
          // Bundle 7T (WR-2 + Phase Z consumption · shape-preserving):
          surfaceDescription,                    // WR-2 widget override
          stateHash,                             // WR-2 fast-path hash
          zTier: desc?.tier ?? null,             // Phase Z band from SurfaceRegistry
          zIndex: desc?.zHint ?? null,
        },
      };
    }
    case 'popover':
    case 'inline':
    case 'bg':
      return passthrough(addr, desc);
    case 'window': {
      // B-13-α · Virtual Window as a surface. No per-kind
      // resolver like modal/widget because a VW is a layout container
      // rather than a single primitive. `detail` surfaces the
      // `windowId` + basic lifecycle metadata the SurfaceRegistry
      // already carries; consumers that need the actual pane tree
      // call SaveLayout / LoadLayout for the structured snapshot.
      if (!desc) {
        return {
          found: false,
          addr,
          note: 'window surface not in registry (wireWindowSurfaces not active?)',
        };
      }
      return {
        found: true,
        addr,
        kindTag: desc.kindTag,
        visible: desc.visible,
        ...(desc.tier !== undefined ? { tier: desc.tier } : {}),
        ...(desc.title !== undefined ? { title: desc.title } : {}),
        detail: {
          windowId: addr.windowId,
          surfaceId: desc.surfaceId ?? null,
          registeredAt: desc.registeredAt,
        },
      };
    }
    default:
      // E1 / TS2366 (2026-05-17) — exhaustive default. Unknown
      // SurfaceAddress kinds fall back to the passthrough envelope
      // shape (same as popover/inline/bg/window above).
      return passthrough(addr, desc);
  }
}

function passthrough(
  addr: SurfaceAddress,
  desc: SurfaceDescriptor | undefined,
  note?: string,
): DescribeSurfaceOut {
  if (!desc) {
    return {
      found: false,
      addr,
      ...(note !== undefined ? { note } : { note: 'surface not in registry' }),
    };
  }
  return {
    found: true,
    addr,
    kindTag: desc.kindTag,
    visible: desc.visible,
    ...(desc.tier !== undefined ? { tier: desc.tier } : {}),
    ...(desc.title !== undefined ? { title: desc.title } : {}),
    ...(note !== undefined ? { note } : {}),
    detail: {
      surfaceId: desc.surfaceId ?? null,
      registeredAt: desc.registeredAt,
      stateHash: desc.stateHash ?? null,
    },
  };
}

function countPromoteChain(id: { promotedFrom?: { promotedFrom?: unknown } }): number {
  let n = 0;
  let cur: { promotedFrom?: unknown } | undefined = id.promotedFrom as never;
  while (cur) {
    n += 1;
    cur = (cur as { promotedFrom?: { promotedFrom?: unknown } }).promotedFrom;
  }
  return n;
}

function previewWidgetState(state: unknown): unknown {
  if (state === null || state === undefined) return state;
  if (typeof state !== 'object') return state;
  // Truncate top-level only — full state may be huge (e.g. scratch).
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(state)) {
    if (i >= 8) { out['…'] = `+${Object.keys(state).length - 8} more`; break; }
    if (typeof v === 'string' && v.length > 80) out[k] = v.slice(0, 80) + '…';
    else if (Array.isArray(v)) out[k] = `[Array(${v.length})]`;
    else if (v && typeof v === 'object') out[k] = '[Object]';
    else out[k] = v;
    i += 1;
  }
  return out;
}

function parseSurfaceAddress(raw: unknown): SurfaceAddress | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  switch (obj.kind) {
    case 'pane': {
      const ref = obj.ref;
      if (!ref || typeof ref !== 'object') return undefined;
      const r = ref as Record<string, unknown>;
      if (typeof r.windowId !== 'string' || typeof r.paneId !== 'string') return undefined;
      return {
        kind: 'pane',
        ref: {
          windowId: r.windowId,
          paneId: r.paneId,
          ...(typeof r.runnerLabel === 'string' ? { runnerLabel: r.runnerLabel } : {}),
        },
      };
    }
    case 'modal':
      if (typeof obj.modalId !== 'string') return undefined;
      return { kind: 'modal', modalId: obj.modalId };
    case 'widget':
      if (typeof obj.widgetId !== 'string') return undefined;
      return { kind: 'widget', widgetId: obj.widgetId };
    case 'popover':
      if (typeof obj.popoverId !== 'string') return undefined;
      return { kind: 'popover', popoverId: obj.popoverId };
    case 'inline':
      if (typeof obj.inlineId !== 'string') return undefined;
      return { kind: 'inline', inlineId: obj.inlineId };
    case 'bg':
      if (typeof obj.bgId !== 'string') return undefined;
      return { kind: 'bg', bgId: obj.bgId };
    case 'window': {
      // B-13-α — accept number or numeric string (dashboard dispatch
      // sometimes coerces integers to strings over JSON).
      const raw = obj.windowId;
      const n = typeof raw === 'number' ? raw
        : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n <= 0) return undefined;
      return { kind: 'window', windowId: n };
    }
    default:
      return undefined;
  }
}

// ── ObserveSurface ─────────────────────────────────────────────

export interface ObserveSurfaceArgs {
  readonly addr?: SurfaceAddress;
  readonly kind?: SurfaceAddress['kind'];
  readonly durationMs: number;
  readonly maxEvents: number;
}

export interface ObserveSurfaceEventOut {
  readonly kind: SurfaceEvent['kind'];
  readonly addr: SurfaceAddress;
  readonly t: number;
  readonly visible?: boolean;
  readonly title?: string;
  readonly tier?: string;
}

export interface ObserveSurfaceOut {
  readonly events: readonly ObserveSurfaceEventOut[];
  readonly truncated: boolean;
  readonly windowMs: number;
}

const MAX_DURATION_MS = 60_000;
const DEFAULT_DURATION_MS = 5_000;
const DEFAULT_MAX_EVENTS = 200;

export function buildObserveSurfaceTool(): LLMToolSpec {
  return {
    name: 'ObserveSurface',
    description:
      'Subscribe to SurfaceRegistry events (register/unregister/update) for a time window. '
      + 'Filter by addr (single surface) OR by kind (all of a kind). Returns the event list '
      + 'so the LLM can detect "did anything appear / disappear / change while I was waiting". '
      + 'Read-only.',
    parameters: {
      type: 'object',
      properties: {
        addr: { type: 'object', description: 'SurfaceAddress to filter by (single surface).' },
        kind: { type: 'string', description: 'Surface kind filter (all surfaces of a kind).' },
        durationMs: { type: 'integer', description: 'Window length, ms. Default 5000, max 60000.' },
        maxEvents: { type: 'integer', description: 'Cap on returned events. Default 200.' },
      },
    },
  };
}

export function dispatchObserveSurface(
  raw: Record<string, unknown>,
  deps: SurfaceUIDeps = {},
): Promise<ObserveSurfaceOut> {
  const args = parseObserveArgs(raw);
  const registry = deps.registry ?? getSurfaceRegistry();
  const now = deps.now ?? (() => Date.now());
  const setTimer = (deps.setTimeout ?? globalThis.setTimeout) as (cb: () => void, ms: number) => unknown;
  const startedAt = now();

  return new Promise<ObserveSurfaceOut>((resolve) => {
    const events: ObserveSurfaceEventOut[] = [];
    let truncated = false;

    const matches = (event: SurfaceEvent): boolean => {
      if (args.addr) return registry === undefined ? true : surfaceAddrEquals(args.addr, event.addr);
      if (args.kind) return event.addr.kind === args.kind;
      return true;
    };

    const collect = (event: SurfaceEvent): void => {
      if (!matches(event)) return;
      if (events.length >= args.maxEvents) { truncated = true; return; }
      events.push({
        kind: event.kind,
        addr: event.addr,
        t: now() - startedAt,
        ...(event.descriptor?.visible !== undefined ? { visible: event.descriptor.visible } : {}),
        ...(event.descriptor?.title !== undefined ? { title: event.descriptor.title } : {}),
        ...(event.descriptor?.tier !== undefined ? { tier: event.descriptor.tier } : {}),
      });
    };

    const off1 = registry.on('register', collect);
    const off2 = registry.on('unregister', collect);
    const off3 = registry.on('update', collect);

    setTimer(() => {
      off1(); off2(); off3();
      resolve({ events, truncated, windowMs: args.durationMs });
    }, args.durationMs);
  });
}

function surfaceAddrEquals(a: SurfaceAddress, b: SurfaceAddress): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'pane':
      return b.kind === 'pane'
        && a.ref.windowId === b.ref.windowId
        && a.ref.paneId === b.ref.paneId
        && (a.ref.runnerLabel ?? '') === (b.ref.runnerLabel ?? '');
    case 'modal':   return b.kind === 'modal'   && a.modalId   === b.modalId;
    case 'widget':  return b.kind === 'widget'  && a.widgetId  === b.widgetId;
    case 'popover': return b.kind === 'popover' && a.popoverId === b.popoverId;
    case 'inline':  return b.kind === 'inline'  && a.inlineId  === b.inlineId;
    case 'bg':      return b.kind === 'bg'      && a.bgId      === b.bgId;
    case 'window':  return b.kind === 'window'  && a.windowId  === b.windowId;
    // E1 / TS2366 (2026-05-17) — exhaustive default. Unknown kinds
    // can't be compared safely so treat as not equal.
    default:        return false;
  }
}

function parseObserveArgs(raw: Record<string, unknown>): ObserveSurfaceArgs {
  const addr = parseSurfaceAddress(raw.addr);
  const kindRaw = raw.kind;
  const kind = (typeof kindRaw === 'string'
    && (kindRaw === 'pane' || kindRaw === 'modal' || kindRaw === 'widget'
      || kindRaw === 'popover' || kindRaw === 'inline' || kindRaw === 'bg'
      || kindRaw === 'window'))
    ? (kindRaw as SurfaceAddress['kind'])
    : undefined;
  const dRaw = typeof raw.durationMs === 'number' && raw.durationMs > 0
    ? raw.durationMs : DEFAULT_DURATION_MS;
  const durationMs = Math.min(MAX_DURATION_MS, Math.floor(dRaw));
  const mRaw = typeof raw.maxEvents === 'number' && raw.maxEvents > 0
    ? raw.maxEvents : DEFAULT_MAX_EVENTS;
  const maxEvents = Math.max(1, Math.floor(mRaw));
  return {
    durationMs,
    maxEvents,
    ...(addr !== undefined ? { addr } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
}
