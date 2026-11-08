import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H6 P6 · LLM tools for capture source discovery + dispatch.
//
// Two tools on top of the `CaptureSourceRegistry`:
//   - ListCaptureSources — read-only enumeration, LLM uses this first
//     to find out which VW panes / agent sessions / browser CDP pages
//     are currently observable.
//   - SnapshotSource — dispatch to the right provider for a given
//     source id, return text/ansi/png/... payload.
//
// Both tools are T1 read-only (D7). Happy-path output contract matches
// the rest of the H6 family: `{output, metadata, isError?}`.


import type { InputSourceRef } from '../../input/input-source-kind.js';
import {
  defaultCaptureSourceRegistry,
  type CaptureSourceRegistry,
} from '../../capture/source-registry.js';
import type {
  CaptureSourceDescriptor,
  SnapshotOpts,
  SnapshotResult,
} from '../../capture/providers/types.js';
import type { CaptureFormat } from '../../capture/types.js';

const SUPPORTED_FORMATS: readonly CaptureFormat[] = [
  'text', 'ansi', 'png', 'svg', 'asciicast',
];

// ─── ListCaptureSources ──────────────────────────────────────────────

export interface ListCaptureSourcesMetadata {
  sources: CaptureSourceDescriptor[];
  countByType: Readonly<Record<string, number>>;
  registeredTypes: readonly string[];
}

export interface ListCaptureSourcesResult {
  output: string;
  metadata: ListCaptureSourcesMetadata;
  isError?: true;
}

export function buildListCaptureSourcesTool(): LLMToolSpec {
  return {
    name: 'ListCaptureSources',
    description:
      'Enumerate every capture source currently observable (VW panes, live embodied agent sessions, browser CDP pages). Use this FIRST to discover valid source ids before calling SnapshotSource. Returns a list of `{id, type, label, summary, formats}` descriptors. Read-only; safe to call repeatedly. When no sources are live (fresh boot, no VWs, no Chrome) the list is empty and `countByType` is all zeros.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export async function dispatchListCaptureSources(
  _rawArgs: Record<string, unknown>,
  registry: CaptureSourceRegistry = defaultCaptureSourceRegistry(),
): Promise<ListCaptureSourcesResult> {
  const sources = registry.list();
  const countByType = registry.countByType();
  const registeredTypes = registry.registeredTypes();
  const lines: string[] = [];
  if (sources.length === 0) {
    lines.push('ListCaptureSources: no live sources');
  } else {
    lines.push(`ListCaptureSources: ${sources.length} source(s)`);
    for (const s of sources) {
      const extra = s.summary ? ` · ${s.summary}` : '';
      lines.push(`  ${s.id} · ${s.type}${extra}`);
    }
  }
  return {
    output: lines.join('\n'),
    metadata: {
      sources: [...sources],
      countByType,
      registeredTypes,
    },
  };
}

// ─── SnapshotSource ──────────────────────────────────────────────────

export interface SnapshotSourceArgs {
  sourceId: string;
  format?: CaptureFormat;
  dims?: { cols: number; rows: number };
  title?: string;
}

export interface SnapshotSourceMetadata {
  sourceId: string;
  format: CaptureFormat;
  bytes: number;
  dims: { cols: number; rows: number };
  capturedAt: number;
  bodyBase64?: string;
  warnings: readonly string[];
  sourceSummary?: string;
  sourceRef?: InputSourceRef;
}

export interface SnapshotSourceResult {
  output: string;
  metadata: SnapshotSourceMetadata;
  isError?: true;
}

export function buildSnapshotSourceTool(): LLMToolSpec {
  return {
    name: 'SnapshotSource',
    description:
      'Capture a specific source as text/ansi/png/svg/asciicast. Call ListCaptureSources first to find a valid `sourceId` (format `<type>:<native>`). Returns `{format, bytes, dims, capturedAt, body|bodyBase64, warnings}`. `warnings` surfaces non-fatal degradations (`observer-missing` · `source-empty` · `historical-not-supported`). Read-only · supports parallel calls on different ids.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Opaque id in `<type>:<native>` form from ListCaptureSources.',
        },
        format: {
          type: 'string',
          enum: [...SUPPORTED_FORMATS],
          description: "Output format. Default = provider's primary ('text' for agent-session · 'png' for browser-cdp · 'text' for vw-pane).",
        },
        dims: {
          type: 'object',
          description: 'Optional cols/rows for sources that need explicit sizing (primarily vw-pane with png/svg).',
          properties: {
            cols: { type: 'number' },
            rows: { type: 'number' },
          },
          required: ['cols', 'rows'],
          additionalProperties: false,
        },
        title: { type: 'string' },
      },
      required: ['sourceId'],
      additionalProperties: false,
    },
  };
}

export async function dispatchSnapshotSource(
  rawArgs: Record<string, unknown>,
  registry: CaptureSourceRegistry = defaultCaptureSourceRegistry(),
): Promise<SnapshotSourceResult> {
  const sourceId = typeof rawArgs.sourceId === 'string' ? rawArgs.sourceId.trim() : '';
  if (!sourceId) {
    return errorResult('SnapshotSource: sourceId required', '', 'text');
  }
  const format = typeof rawArgs.format === 'string' && (SUPPORTED_FORMATS as string[]).includes(rawArgs.format)
    ? (rawArgs.format as CaptureFormat)
    : undefined;
  const dims = isValidDims(rawArgs.dims) ? rawArgs.dims : undefined;
  const title = typeof rawArgs.title === 'string' ? rawArgs.title : undefined;
  const opts: SnapshotOpts = {
    ...(format ? { format } : {}),
    ...(dims ? { dims } : {}),
    ...(title ? { title } : {}),
  };
  try {
    const snap = await registry.snapshot(sourceId, opts);
    return {
      output: formatSnapshotOutput(snap),
      metadata: buildSnapshotMetadata(snap),
    };
  } catch (err) {
    return errorResult(
      `SnapshotSource: ${err instanceof Error ? err.message : String(err)}`,
      sourceId,
      format ?? 'text',
    );
  }
}

function formatSnapshotOutput(snap: SnapshotResult): string {
  const header = `SnapshotSource: ${snap.sourceId} · ${snap.format} · ${snap.bytes}B`;
  const lines = [header];
  if (snap.warnings.length > 0) {
    lines.push(`  warnings: ${snap.warnings.join(', ')}`);
  }
  if (snap.format !== 'png' && snap.body.length > 0) {
    lines.push('');
    lines.push(snap.body);
  } else if (snap.format === 'png') {
    lines.push(`  (PNG ${snap.bytes}B · base64 in metadata.bodyBase64)`);
  }
  return lines.join('\n');
}

function buildSnapshotMetadata(snap: SnapshotResult): SnapshotSourceMetadata {
  const meta: SnapshotSourceMetadata = {
    sourceId: snap.sourceId,
    format: snap.format,
    bytes: snap.bytes,
    dims: { ...snap.dims },
    capturedAt: snap.capturedAt,
    warnings: [...snap.warnings],
  };
  if (snap.bodyBase64) meta.bodyBase64 = snap.bodyBase64;
  if (snap.sourceSummary) meta.sourceSummary = snap.sourceSummary;
  if (snap.sourceRef) meta.sourceRef = snap.sourceRef;
  return meta;
}

function errorResult(
  message: string,
  sourceId: string,
  format: CaptureFormat,
): SnapshotSourceResult {
  return {
    output: message,
    metadata: {
      sourceId,
      format,
      bytes: 0,
      dims: { cols: 0, rows: 0 },
      capturedAt: 0,
      warnings: [],
    },
    isError: true,
  };
}

function isValidDims(raw: unknown): raw is { cols: number; rows: number } {
  if (!raw || typeof raw !== 'object') return false;
  const d = raw as { cols?: unknown; rows?: unknown };
  return typeof d.cols === 'number' && Number.isFinite(d.cols)
    && typeof d.rows === 'number' && Number.isFinite(d.rows);
}

// ─── Bootstrap ───────────────────────────────────────────────────────

/** Bootstrap parity with other H6 tools — no-op by default. The
 *  registry is created + provider-registered in `dashboard.ts`
 *  bootstrap; this function exists so the init call reads uniformly
 *  alongside `initPolicyRouter` / `initAgentRoomTools`. */
export function initCaptureSourceTools(): void {
  // Eager-touch the default registry so it's alive before first
  // list/snapshot call. No provider registration here — that happens
  // in dashboard.ts with access to WindowRegistry, live sessions, and
  // the CDP client.
  defaultCaptureSourceRegistry();
}
