import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── IUL Bundle 8T — StartRecording / StopRecording LLM tools ──
//
// Wrap the Bundle 7T `widget-recorder` (src/capture/widget-recorder.ts)
// in a pair of LLM-facing ToolRuntimes so an agent can request "record
// this widget for 5 seconds" / "stop and save" via natural language.
//
// Cross-track ownership (PLAN-iul-closure-roadmap.md §0.5): terminal
// team only. Reads widget-team's WidgetRecorderHost surface (subset of
// WidgetHost) — no widget-team file edits. `src/dashboard.ts` gets the
// shared 1+1 pattern (import + try/catch call).
//
// Dispatch returns JSON via the `ToolRuntime` `{ output: string }`
// shape. Persist defaults to `true` — timelines land in
// `~/.elanous/timelines/<recorderId>.cast` so the widget-team
// StateTimelineViewer (Bundle 8W) can `view <path>` them.
//
// Multiple concurrent recorders are supported — the active-recorder
// Map is keyed by `recorderId` so an LLM can start / stop independent
// streams interleaved. `__resetRecordingRuntimesForTest` clears the
// Map + deps ref for hermetic test runs.

import * as nodeFs from 'node:fs';
import path from 'node:path';

import {
  createWidgetRecorder,
  type WidgetRecorderHandle,
  type WidgetRecorderHost,
  type WidgetRecorderOpts,
  type WidgetTimelineFrame,
} from '../capture/widget-recorder.js';
import type { WidgetStateChangeEvent } from '../widgets/host.js';

import { registerToolRuntime } from './registry.js';
import type { ToolRuntime } from './types.js';
import {
  defaultTimelineBaseDir,
  timelinePathFor,
} from './recording-runtimes-paths.js';
import type { ArtifactStore } from '../artifact/index.js';

// ── Types ────────────────────────────────────────────────────────

/** Minimal fs contract — swap in-memory in tests so persistence works
 *  without hitting the real `~/.elanous/timelines/` directory. Matches
 *  `node:fs` sync shape for the two methods we call. */
export interface RecordingFs {
  mkdirSync(p: string, opts: { recursive: boolean }): void;
  writeFileSync(p: string, body: string): void;
}

export interface RecordingRuntimeDeps {
  /** Read-only widget-host subset. Dashboard wires the real
   *  `WidgetHost`; tests can supply a fake shape matching
   *  `WidgetRecorderHost`. */
  widgetHost: WidgetRecorderHost;
  /** Override timestamp source so tests can advance time
   *  deterministically. Passes through to the underlying recorder's
   *  `now` opt too. */
  now?: () => number;
  /** Bundle B-3 (P6-2) · unified artifact persistence. When present,
   *  `persist=true` timeline saves go through `ArtifactStore.put(
   *  'timeline', body, {origin: recorderId, producer: 'bundle-8t'})`
   *  and land under `~/.elanous/artifacts/timeline/`. Takes precedence
   *  over legacy `baseDir` / `fs`. */
  artifactStore?: ArtifactStore;
  /** @deprecated Legacy fallback · `~/.elanous/timelines/` direct write.
   *  Used only when `artifactStore` is absent (e.g. hermetic tests
   *  without store DI). */
  baseDir?: string;
  /** @deprecated Legacy fallback · `artifactStore` 없을 때 만 사용. */
  fs?: RecordingFs;
}

interface ActiveRecorder {
  readonly handle: WidgetRecorderHandle;
  readonly startedAtSec: number;
  readonly baseDir: string;
  readonly widgetIds: readonly string[] | null;
}

type Args = Record<string, unknown>;
type Out = { output: string };

// ── Tool specs ───────────────────────────────────────────────────

export function buildStartRecordingTool(): LLMToolSpec {
  return {
    name: 'StartRecording',
    description:
      'Start recording a widget state timeline. Subscribes to the '
      + 'widget host and captures every setState as an asciicast v2.1 '
      + 'frame. Pass `widgetIds` to restrict to a subset; omit to '
      + 'record all widgets. Returns a `recorderId` for `StopRecording`.',
    parameters: {
      type: 'object',
      properties: {
        widgetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allow-list of widget instance ids. '
            + 'Omit (or empty) to record every widget.',
        },
        dims: {
          type: 'object',
          properties: {
            cols: { type: 'integer', description: 'Terminal cols (header).' },
            rows: { type: 'integer', description: 'Terminal rows (header).' },
          },
          description: 'Optional dims for the asciicast header. Default 80×24.',
        },
        title: { type: 'string', description: 'Optional human title for the header.' },
        skipUnchanged: {
          type: 'boolean',
          description: 'Skip events whose snapshotHash matches the last one for '
            + 'the same widget (WR-2 fast-path). Default true.',
        },
      },
    },
  };
}

export function buildStopRecordingTool(): LLMToolSpec {
  return {
    name: 'StopRecording',
    description:
      'Stop a recorder started via `StartRecording`. By default the '
      + 'asciicast v2.1 timeline is persisted to `~/.elanous/timelines/'
      + '<recorderId>.cast` and the path is returned. Set `persist=false` '
      + 'to get the serialized body inline instead. `format="summary"` '
      + 'returns frame counts per widget rather than the full timeline.',
    parameters: {
      type: 'object',
      properties: {
        recorderId: { type: 'string', description: 'Recorder id from StartRecording.' },
        persist: {
          type: 'boolean',
          description: 'Write the timeline to disk. Default true; '
            + 'ignored for format="summary".',
        },
        format: {
          type: 'string',
          enum: ['timeline', 'summary'],
          description: '"timeline" (default) returns asciicast body/path. '
            + '"summary" returns {widgetIds, tPerId} counts.',
        },
      },
      required: ['recorderId'],
    },
  };
}

// ── Module state ─────────────────────────────────────────────────

const active = new Map<string, ActiveRecorder>();
let _depsRef: RecordingRuntimeDeps | null = null;
let registered = false;

function currentDeps(): RecordingRuntimeDeps {
  if (!_depsRef) {
    throw new Error(
      'recording-runtimes: no deps registered — call registerRecordingRuntimes() first',
    );
  }
  return _depsRef;
}

// ── Dispatch ─────────────────────────────────────────────────────

export interface StartRecordingOut {
  readonly recorderId: string;
  readonly startedAt: number;
  readonly status: 'recording';
}

export function dispatchStartRecording(
  rawArgs: Args,
  deps: RecordingRuntimeDeps,
): StartRecordingOut {
  const args = parseStartArgs(rawArgs);
  const nowFn = deps.now ?? (() => Date.now());
  const recorderId = `rec-${randomSuffix()}`;
  const startedAtSec = Math.floor(nowFn() / 1000);

  const filter = args.widgetIds && args.widgetIds.length > 0
    ? makeIdFilter(args.widgetIds)
    : undefined;

  const opts: WidgetRecorderOpts = {
    widgetHost: deps.widgetHost,
    dims: args.dims,
    skipUnchanged: args.skipUnchanged,
    now: nowFn,
    startedAtSec,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(filter !== undefined ? { filter } : {}),
  };
  const handle = createWidgetRecorder(opts);
  handle.start();

  active.set(recorderId, {
    handle,
    startedAtSec,
    baseDir: deps.baseDir ?? defaultTimelineBaseDir(),
    widgetIds: args.widgetIds && args.widgetIds.length > 0 ? args.widgetIds : null,
  });

  return { recorderId, startedAt: startedAtSec, status: 'recording' };
}

export interface StopRecordingOut {
  readonly recorderId: string;
  readonly status: 'stopped';
  readonly frameCount: number;
  readonly elapsedSec: number;
  readonly path?: string;
  readonly body?: string;
  readonly summary?: {
    readonly widgetIds: readonly string[];
    readonly tPerId: Record<string, number>;
  };
  readonly note?: string;
}

export function dispatchStopRecording(
  rawArgs: Args,
  deps: RecordingRuntimeDeps,
): StopRecordingOut {
  const args = parseStopArgs(rawArgs);
  const entry = active.get(args.recorderId);
  if (!entry) {
    return {
      recorderId: args.recorderId,
      status: 'stopped',
      frameCount: 0,
      elapsedSec: 0,
      note: `recorder not found: ${args.recorderId}`,
    };
  }

  const { handle, baseDir } = entry;
  handle.stop();
  const frameCount = handle.frameCount;
  const elapsedSec = handle.elapsedSec;
  active.delete(args.recorderId);

  if (args.format === 'summary') {
    return {
      recorderId: args.recorderId,
      status: 'stopped',
      frameCount,
      elapsedSec,
      summary: summarizeFrames(handle.frames()),
    };
  }

  // format === 'timeline'
  const body = handle.serialize();
  if (!args.persist) {
    return {
      recorderId: args.recorderId,
      status: 'stopped',
      frameCount,
      elapsedSec,
      body,
    };
  }
  // Bundle B-3 · unified artifact store path (preferred).
  if (deps.artifactStore) {
    const tags = entry.widgetIds
      ? ['widget-timeline', ...entry.widgetIds]
      : ['widget-timeline'];
    const handleOut = deps.artifactStore.put('timeline', body, {
      origin: args.recorderId,
      producer: 'bundle-8t',
      description: `Widget state timeline · ${frameCount} frames · ${elapsedSec.toFixed(2)}s`,
      tags,
    });
    return {
      recorderId: args.recorderId,
      status: 'stopped',
      frameCount,
      elapsedSec,
      path: handleOut.path,
    };
  }
  // Legacy fallback (hermetic tests · dashboards without artifactStore).
  const fs = deps.fs ?? (nodeFs as unknown as RecordingFs);
  const filePath = timelinePathFor(baseDir, args.recorderId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return {
    recorderId: args.recorderId,
    status: 'stopped',
    frameCount,
    elapsedSec,
    path: filePath,
  };
}

// ── Parse helpers ────────────────────────────────────────────────

interface StartArgs {
  readonly widgetIds?: readonly string[];
  readonly dims: { readonly cols: number; readonly rows: number };
  readonly title?: string;
  readonly skipUnchanged: boolean;
}

function parseStartArgs(raw: Args): StartArgs {
  const widgetIdsRaw = raw.widgetIds;
  const widgetIds = Array.isArray(widgetIdsRaw)
    ? widgetIdsRaw.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : undefined;

  const dimsRaw = raw.dims as { cols?: unknown; rows?: unknown } | undefined;
  const cols = typeof dimsRaw?.cols === 'number' && dimsRaw.cols > 0
    ? Math.floor(dimsRaw.cols) : 80;
  const rows = typeof dimsRaw?.rows === 'number' && dimsRaw.rows > 0
    ? Math.floor(dimsRaw.rows) : 24;

  const title = typeof raw.title === 'string' && raw.title.length > 0
    ? raw.title : undefined;
  const skipUnchanged = raw.skipUnchanged === undefined
    ? true
    : Boolean(raw.skipUnchanged);

  return {
    dims: { cols, rows },
    skipUnchanged,
    ...(widgetIds && widgetIds.length > 0 ? { widgetIds } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

interface StopArgs {
  readonly recorderId: string;
  readonly persist: boolean;
  readonly format: 'timeline' | 'summary';
}

function parseStopArgs(raw: Args): StopArgs {
  const recorderId = typeof raw.recorderId === 'string' ? raw.recorderId : '';
  const persist = raw.persist === undefined ? true : Boolean(raw.persist);
  const formatRaw = raw.format;
  const format: 'timeline' | 'summary' = formatRaw === 'summary' ? 'summary' : 'timeline';
  return { recorderId, persist, format };
}

function makeIdFilter(ids: readonly string[]): (e: WidgetStateChangeEvent) => boolean {
  const set = new Set(ids);
  return (e) => set.has(e.instanceId);
}

function summarizeFrames(
  frames: readonly WidgetTimelineFrame[],
): { widgetIds: readonly string[]; tPerId: Record<string, number> } {
  const tPerId: Record<string, number> = {};
  for (const f of frames) {
    tPerId[f.widgetId] = (tPerId[f.widgetId] ?? 0) + 1;
  }
  return { widgetIds: Object.keys(tPerId), tPerId };
}

function randomSuffix(): string {
  // 8 hex chars from a v4 UUID — short enough for a filename, long
  // enough to be collision-resistant within a session.
  try {
    return (globalThis.crypto?.randomUUID?.() ?? '').replace(/-/g, '').slice(0, 8)
      || fallbackSuffix();
  } catch {
    return fallbackSuffix();
  }
}

function fallbackSuffix(): string {
  // Non-crypto path for environments without Web Crypto (older tests).
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

// ── ToolRuntime factories ────────────────────────────────────────

export function createStartRecordingRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'iul_start_recording',
    spec: buildStartRecordingTool(),
    async run(req) {
      const result = dispatchStartRecording(req, currentDeps());
      return { output: JSON.stringify(result) };
    },
  };
}

export function createStopRecordingRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'iul_stop_recording',
    spec: buildStopRecordingTool(),
    async run(req) {
      const result = dispatchStopRecording(req, currentDeps());
      return { output: JSON.stringify(result) };
    },
  };
}

// ── Registration ─────────────────────────────────────────────────

/** Idempotent registration — dashboard calls once after widgetHost is
 *  available. Re-calling updates `_depsRef` (so in-flight tests can
 *  swap `now` / `fs`) without duplicating the registry entries. */
export function registerRecordingRuntimes(deps: RecordingRuntimeDeps): void {
  _depsRef = deps;
  if (registered) return;
  registerToolRuntime(createStartRecordingRuntime());
  registerToolRuntime(createStopRecordingRuntime());
  registered = true;
}

/** Test-only — wipe Map + deps + registered flag. Paired with the
 *  central `_resetToolRuntimeRegistryForTest` when the test also wants
 *  a clean registry. */
export function __resetRecordingRuntimesForTest(): void {
  for (const entry of active.values()) {
    try { entry.handle.stop(); } catch { /* isolate */ }
  }
  active.clear();
  _depsRef = null;
  registered = false;
}

/** Test-only — peek at the active recorder count. */
export function __activeRecorderCountForTest(): number {
  return active.size;
}
