import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── Phase C (Capture Fabric) — PTY recording LLM tools ──
//
// Companion to the existing `recording-runtimes.ts` (IUL Bundle 8T —
// widget timeline recorder). Where that exposes `StartRecording`/
// `StopRecording` for *widget state changes*, this module exposes
// `RecordPtyOutput`/`StopPtyRecording` for *raw terminal/PTY output*
// — the asciicast v2 case.
//
// Why separate from widget recording?
//   - Different recorder type (`Recorder` vs `WidgetRecorder`).
//   - Different source: widget host vs PTY tap.
//   - Different artifact (asciicast v2 vs v2.1 timeline).
//   - LLM intent matters: "record this widget" vs "record this shell".
//
// Host adapter still has to pipe PTY output bytes into the recorder via
// `entry.handle.write(bytes, 'o')`. This module is the *tool surface*;
// wiring shell-runner taps to recorders is a host responsibility.

import { createRecorder } from '../capture/recorder.js';
import type { CaptureDimensions } from '../capture/types.js';
import {
  getRecordingStore,
  type RecordingEncoder,
  type RecordingStore,
} from '../capture/recording-store.js';

import { registerToolRuntime } from './registry.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

type Args = Record<string, unknown>;
type Out = { output: string };

function stringifyOutput(obj: unknown): Out {
  return { output: JSON.stringify(obj) };
}

// ── Tool specs ────────────────────────────────────────────────────

export function buildRecordPtyOutputTool(): LLMToolSpec {
  return {
    name: 'RecordPtyOutput',
    description:
      'Begin recording a pane/shell\'s raw PTY output as asciicast v2. '
      + 'Returns a recordingId. Use StopPtyRecording with the same id to '
      + 'finalize. Companion to widget StartRecording — that one records '
      + 'widget state changes; this one records terminal output. Host '
      + 'adapter pipes the source\'s PTY tap into the recorder.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          properties: {
            windowId: { type: 'string' },
            paneId: { type: 'string' },
            surfaceLabel: { type: 'string' },
          },
        },
        encoder: {
          type: 'string',
          enum: ['asciicast', 'gif', 'mp4'],
          description: 'Output format. Default asciicast (lightweight, text-only).',
        },
        cols: { type: 'integer', description: 'Terminal width (cols). Default 80.' },
        rows: { type: 'integer', description: 'Terminal height (rows). Default 24.' },
        title: { type: 'string', description: 'Recording title (asciicast metadata).' },
      },
      required: [],
    },
  };
}

export function buildStopPtyRecordingTool(): LLMToolSpec {
  return {
    name: 'StopPtyRecording',
    description:
      'Finalize a PTY recording started with RecordPtyOutput. Returns '
      + 'metadata + asciicast text directly (gif/mp4 require host-side '
      + 'encoder pass via src/capture/encoders/).',
    parameters: {
      type: 'object',
      properties: {
        recordingId: { type: 'string' },
      },
      required: ['recordingId'],
    },
  };
}

// ── Dispatchers ───────────────────────────────────────────────────

export interface RecordPtyArgs {
  source?: { windowId?: string; paneId?: string; surfaceLabel?: string };
  encoder?: RecordingEncoder;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface RecordPtyOut {
  recordingId: string;
  encoder: RecordingEncoder;
  startedAt: number;
  source: NonNullable<RecordPtyArgs['source']>;
  note: string;
}

export function dispatchRecordPtyOutput(
  args: RecordPtyArgs,
  store: RecordingStore = getRecordingStore(),
): RecordPtyOut {
  const dims: CaptureDimensions = {
    cols: args.cols ?? 80,
    rows: args.rows ?? 24,
  };
  const handle = createRecorder({
    dims,
    ...(args.title !== undefined ? { title: args.title } : {}),
  });
  handle.start();
  const encoder = args.encoder ?? 'asciicast';
  const entry = store.start({
    handle,
    encoder,
    source: args.source ?? {},
  });
  return {
    recordingId: entry.id,
    encoder,
    startedAt: entry.startedAt,
    source: entry.source,
    note: 'PTY recording started. Host adapter pipes source PTY output via handle.write(bytes, "o"). Call StopPtyRecording to finalize.',
  };
}

export interface StopPtyArgs {
  recordingId: string;
}

export interface StopPtyOut {
  recordingId: string;
  encoder: RecordingEncoder;
  status: 'stopped' | 'not-found' | 'already-stopped';
  durationSec: number;
  frameCount: number;
  asciicast?: string;
  note?: string;
}

export function dispatchStopPtyRecording(
  args: StopPtyArgs,
  store: RecordingStore = getRecordingStore(),
): StopPtyOut {
  const entry = store.get(args.recordingId);
  if (!entry) {
    return {
      recordingId: args.recordingId,
      encoder: 'asciicast',
      status: 'not-found',
      durationSec: 0,
      frameCount: 0,
      note: 'Unknown recordingId. Either it was never started or already evicted.',
    };
  }
  if (entry.handle.status === 'stopped') {
    return {
      recordingId: entry.id,
      encoder: entry.encoder,
      status: 'already-stopped',
      durationSec: entry.handle.elapsedSec,
      frameCount: entry.handle.frameCount,
      asciicast: entry.encoder === 'asciicast' ? entry.handle.serialize() : undefined,
    };
  }
  entry.handle.stop();
  store.markStopped(entry.id);
  return {
    recordingId: entry.id,
    encoder: entry.encoder,
    status: 'stopped',
    durationSec: entry.handle.elapsedSec,
    frameCount: entry.handle.frameCount,
    asciicast: entry.encoder === 'asciicast' ? entry.handle.serialize() : undefined,
    ...(entry.encoder !== 'asciicast'
      ? { note: 'Host must run encoder for gif/mp4 (see src/capture/encoders/).' }
      : {}),
  };
}

// ── Runtimes ──────────────────────────────────────────────────────

export const recordPtyOutputRuntime: ToolRuntime<Args, Out> = {
  id: 'capture_record_pty_output',
  spec: buildRecordPtyOutputTool(),
  async run(req, _ctx: ToolRuntimeContext) {
    return stringifyOutput(dispatchRecordPtyOutput(req as RecordPtyArgs));
  },
};

export const stopPtyRecordingRuntime: ToolRuntime<Args, Out> = {
  id: 'capture_stop_pty_recording',
  spec: buildStopPtyRecordingTool(),
  async run(req, _ctx: ToolRuntimeContext) {
    return stringifyOutput(dispatchStopPtyRecording(req as unknown as StopPtyArgs));
  },
};

export const PTY_RECORDING_RUNTIMES = [recordPtyOutputRuntime, stopPtyRecordingRuntime];

let registered = false;

export function registerPtyRecordingRuntimes(): void {
  if (registered) return;
  for (const rt of PTY_RECORDING_RUNTIMES) registerToolRuntime(rt);
  registered = true;
}

export function __resetPtyRecordingRuntimesForTest(): void {
  registered = false;
}
