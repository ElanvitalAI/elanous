// ── User Intent Event — universal schema v1 (cascade-zyu W1 U0) ──
//
// PLAN: 내부 문서 `PLAN-user-intent-logging-2026-05-12` §2
// MANUAL: 내부 문서 `MANUAL-user-intent-logging-2026-05-12`
//
// Single shape for every user-intent signal across the 8 surfaces
// (tui · ask · pwa · ios · watch · airpods · discord · telegram) and 7
// layers (utterance · gesture · selection · navigation · ambient ·
// device_state · system). Patcher (Y3) consumes the JSONL stream as
// raw input; KGS card conversion happens in the Patcher, not here.
//
// The schema is intentionally permissive: `intent.value` and most
// nested fields are optional. `redaction.ts` pre-redacts before sink
// fan-out so callers can pass raw user input without a leak vector.
//
// `bm25_text` / `vector_embedding` / `extracted_entities` are
// populated by the Patcher post-conversion (U5 phase) — keep them on
// the wire so the storage layer doesn't need a migration when search
// lights up.

export type UserIntentSurface =
  | 'unknown'
  | 'tui'
  | 'ask'
  | 'pwa'
  | 'ios'
  | 'watch'
  | 'airpods'
  | 'discord'
  | 'telegram';

export const USER_INTENT_SURFACES: readonly UserIntentSurface[] = [
  'unknown', 'tui', 'ask', 'pwa', 'ios', 'watch', 'airpods', 'discord', 'telegram',
];

export type UserIntentLayer =
  | 'utterance'
  | 'gesture'
  | 'selection'
  | 'navigation'
  | 'ambient'
  | 'device_state'
  | 'system';

export const USER_INTENT_LAYERS: readonly UserIntentLayer[] = [
  'utterance', 'gesture', 'selection',
  'navigation', 'ambient', 'device_state', 'system',
];

export type UserIntentTargetKind =
  | 'task'
  | 'mission'
  | 'workflow'
  | 'message'
  | 'button'
  | 'chip'
  | 'toggle'
  | 'lane'
  | 'skill'
  | 'tool'
  | 'file'
  | 'region'
  | 'device';

export interface UserIntentTarget {
  kind: UserIntentTargetKind;
  id?: string;
  label?: string;
}

export type UserIntentMotionKind =
  | 'wrist_flip'
  | 'wrist_raise'
  | 'pinch'
  | 'crown_click'
  | 'head_nod'
  | 'head_shake'
  | 'head_tilt'
  | 'iphone_raise'
  | 'iphone_flip'
  | 'iphone_shake'
  | 'back_tap'
  | 'walking'
  | 'running'
  | 'driving'
  | 'stationary'
  | 'region_enter'
  | 'region_exit'
  | 'beacon_detect';

export interface UserIntentMotion {
  kind: UserIntentMotionKind;
  magnitude?: number;
  duration_ms?: number;
  /** Only populated when caller opts in (debug). Sink-level redaction
   *  strips this for cloud sinks by default. */
  raw_signal?: unknown;
}

export type UserIntentBiometricKind =
  | 'sleep_started'
  | 'sleep_stage_change'
  | 'sleep_ended'
  | 'hrv_threshold_cross'
  | 'workout_start'
  | 'workout_end'
  | 'activity_ring_complete';

export interface UserIntentBiometric {
  kind: UserIntentBiometricKind;
  /** No raw HR / HRV numbers — threshold cross signal only. */
}

export interface UserIntentLocation {
  /** User-named region label ("office" · "home" · "cafe-1").
   *  Raw GPS is never persisted. */
  region_label?: string;
}

export interface UserIntentDetail {
  layer: UserIntentLayer;
  /** `<surface>.<layer>.<verb>[.<sub>]` — see PLAN §8. */
  kind: string;
  target?: UserIntentTarget;
  /** Raw user input. Subject to redaction (utterance defaults to
   *  content hash; key blocklist always applied). */
  value?: unknown;
  motion?: UserIntentMotion;
  biometric?: UserIntentBiometric;
  location?: UserIntentLocation;
}

export interface UserIntentSurfaceState {
  /** PWA route / TUI viewMode. */
  route?: string;
  active_modal?: string;
  active_panel?: string;
  focus?: string;
}

export interface UserIntentContext {
  active_mission_id?: string;
  active_task_id?: string;
  active_workflow_run_id?: string;
  active_showroom_session_id?: string;
  /** OMF mission template id. */
  active_template_id?: string;
  active_skill?: string;
}

export interface UserIntentOutcome {
  next_event_id?: string;
  duration_ms?: number;
  success?: boolean;
  error_kind?: string;
}

/** Universal event shape — every surface adapter emits this. The
 *  logger fills MSS / identity fields; the caller only owns
 *  `surface` + `intent` + (optionally) `context`/`surface_state`. */
export interface UserIntentEvent {
  schema_version: 1;
  event_id: string;
  /** ISO 8601 UTC. */
  ts: string;
  /** Hashed user identifier. Default empty string until U-auth lands. */
  user_id: string;
  /** Elanous session id when available. */
  session_id: string;
  /** Apple device family · or hostname. */
  device_id: string;
  /** MSS M2.1 elanous_id. */
  elanous_id: string;

  trace_id?: string;
  span_id?: string;
  /** Chain back to the prior intent event (e.g. region_enter → tap). */
  parent_event_id?: string;

  surface: UserIntentSurface;
  surface_state?: UserIntentSurfaceState;

  intent: UserIntentDetail;
  context?: UserIntentContext;
  outcome?: UserIntentOutcome;

  // Patcher (Y3) populates the three search-ready fields below
  // post-conversion. They land on the schema upfront so storage
  // doesn't need a migration when search goes live (U5).
  bm25_text?: string;
  vector_embedding?: number[];
  extracted_entities?: string[];
}

/** Caller input — what the emit() consumer is expected to provide.
 *  Logger fills `event_id` / `ts` / `user_id` / `session_id` /
 *  `device_id` / `elanous_id` / `schema_version`. */
export interface UserIntentEventInput {
  surface: UserIntentSurface;
  intent: UserIntentDetail;
  surface_state?: UserIntentSurfaceState;
  context?: UserIntentContext;
  outcome?: UserIntentOutcome;
  parent_event_id?: string;
  /** Override session/user/device — useful when a surface forwards
   *  events on behalf of another (PWA bridge for iOS native). */
  session_id?: string;
  user_id?: string;
  device_id?: string;
  /** Override the timestamp — used by replay tools / tests. */
  ts?: string;
}

export function isUserIntentSurface(v: unknown): v is UserIntentSurface {
  return typeof v === 'string'
    && (USER_INTENT_SURFACES as readonly string[]).includes(v);
}

export function isUserIntentLayer(v: unknown): v is UserIntentLayer {
  return typeof v === 'string'
    && (USER_INTENT_LAYERS as readonly string[]).includes(v);
}

/** Lightweight validator — verifies `surface` / `intent.layer` /
 *  `intent.kind` are present and well-formed. Used by the HTTP
 *  endpoint to reject malformed PWA / iOS payloads. */
export function isUserIntentEventInput(v: unknown): v is UserIntentEventInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!isUserIntentSurface(o.surface)) return false;
  const intent = o.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent !== 'object') return false;
  if (!isUserIntentLayer(intent.layer)) return false;
  if (typeof intent.kind !== 'string' || intent.kind.length === 0) return false;
  return true;
}
