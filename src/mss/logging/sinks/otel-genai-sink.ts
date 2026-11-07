// ── OtelGenAISink (MSS M2 / PLAN §4.6 · Arc 2.2) ──
//
// Opt-in sink that exports `llm.*` LogRecords as OTLP/HTTP spans
// using the OpenTelemetry GenAI semantic conventions. The collector
// then renders elanous turns alongside spans from other GenAI tools
// (LangSmith, Langfuse, Datadog APM) without requiring elanous's TUI.
//
// Activation: `MSS_OTEL_ENDPOINT=http://localhost:4318/v1/traces` env
// at boot. When unset, the factory returns null and the sink is
// never registered — zero cost when not configured.
//
// Design constraints:
//   • emit() never throws — silent drop on every error path so a
//     down collector cannot stall an instrumented site.
//   • HTTP delivery is injectable (`send` option) so tests stay
//     hermetic without standing up a real OTLP listener.
//   • Buffered + batched. Records accumulate until batchSize OR
//     batchIntervalMs is exceeded; flush() drains synchronously.
//   • Category filter (default `llm.*`) keeps non-LLM records out
//     of the GenAI pipeline. Operators can broaden via the
//     `includeCategoryPrefixes` option.
//
// MSS sink-level redaction (`src/mss/logging/redaction.ts`) runs
// upstream of every sink including this one — secrets in payloads
// never reach the OTLP envelope.

import type { LogRecord } from '../record.js';
import type { LogSink } from '../sink.js';
import { logDiagnostic } from '../diagnostic-sink.js';

const DEFAULT_SERVICE_NAME = 'monad-agent';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_INTERVAL_MS = 5000;
const DEFAULT_INCLUDE_PREFIXES = ['llm.'];
const DEFAULT_TIMEOUT_MS = 5000;

export interface OtelGenAISinkOptions {
  /** OTLP/HTTP traces endpoint — typically
   *  `http://collector:4318/v1/traces`. Required. */
  endpoint: string;
  /** `service.name` resource attribute (OTel semconv). */
  serviceName?: string;
  /** Records flushed when buffer reaches this many. Default 50. */
  batchSize?: number;
  /** Records flushed when this many ms elapsed since last flush.
   *  Default 5000. */
  batchIntervalMs?: number;
  /** Dotted category prefixes that opt into export. Default `['llm.']`. */
  includeCategoryPrefixes?: string[];
  /** HTTP delivery override — tests inject a mock. Default uses
   *  `globalThis.fetch` with the OTLP/HTTP JSON content type. */
  send?: (endpoint: string, body: string) => Promise<void>;
  /** Service / runtime version stamped on the resource attributes. */
  serviceVersion?: string;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}

const SPAN_KIND_INTERNAL = 1;

function unixNanoFromIso(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return String(Date.now() * 1_000_000);
  return String(ms * 1_000_000);
}

function ensureTraceId(value: string | undefined): string {
  // OTLP wants 32-char hex. Pad / truncate ULIDs / UUIDs to fit.
  if (!value) return '0'.repeat(32);
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length >= 32) return hex.slice(0, 32);
  return hex.padStart(32, '0');
}

function ensureSpanId(value: string | undefined): string {
  if (!value) {
    // Synth a 16-char hex span id from time + random when missing.
    const r = (Math.random() * 0xffffffff) >>> 0;
    return (Date.now().toString(16) + r.toString(16)).padStart(16, '0').slice(-16);
  }
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length >= 16) return hex.slice(0, 16);
  return hex.padStart(16, '0');
}

function attr(key: string, value: unknown): OtlpAttribute | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  // Anything else — stringify defensively.
  try { return { key, value: { stringValue: JSON.stringify(value) } }; } catch { return null; }
}

/** Build the OTel GenAI semconv attributes from a `llm.*` record's
 *  `data` payload. Best-effort — unknown shapes degrade to a single
 *  `elanous.payload` JSON attribute so the span is never empty. */
function genAiAttributes(rec: LogRecord): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  const push = (a: OtlpAttribute | null) => { if (a) out.push(a); };
  const data = (rec.data && typeof rec.data === 'object') ? rec.data as Record<string, unknown> : {};
  push(attr('gen_ai.operation.name', rec.event));
  push(attr('gen_ai.system', typeof data.provider === 'string' ? data.provider : undefined));
  push(attr('gen_ai.request.model', typeof data.model === 'string' ? data.model : undefined));
  push(attr('gen_ai.response.model', typeof data.modelFamily === 'string' ? data.modelFamily : undefined));
  push(attr('gen_ai.request.max_tokens', typeof data.maxTokens === 'number' ? data.maxTokens : undefined));
  // Token usage fields appear under various names — accept any.
  const usage = (data.usage && typeof data.usage === 'object') ? data.usage as Record<string, unknown> : {};
  push(attr('gen_ai.usage.input_tokens',
    typeof usage.input_tokens === 'number' ? usage.input_tokens
      : (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined)));
  push(attr('gen_ai.usage.output_tokens',
    typeof usage.output_tokens === 'number' ? usage.output_tokens
      : (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined)));
  push(attr('elanous.category', rec.category));
  if (rec.elanous_id) push(attr('elanous.id', rec.elanous_id));
  return out;
}

export class OtelGenAISink implements LogSink {
  readonly name = 'otel-genai';
  private endpoint: string;
  private serviceName: string;
  private serviceVersion: string;
  private batchSize: number;
  private batchIntervalMs: number;
  private includePrefixes: string[];
  private send: (endpoint: string, body: string) => Promise<void>;
  private buffer: OtlpSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private dropped = 0;

  constructor(opts: OtelGenAISinkOptions) {
    this.endpoint = opts.endpoint;
    this.serviceName = opts.serviceName ?? DEFAULT_SERVICE_NAME;
    this.serviceVersion = opts.serviceVersion ?? '0.0.0';
    this.batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    this.batchIntervalMs = Math.max(50, opts.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS);
    this.includePrefixes = (opts.includeCategoryPrefixes && opts.includeCategoryPrefixes.length > 0)
      ? [...opts.includeCategoryPrefixes]
      : [...DEFAULT_INCLUDE_PREFIXES];
    this.send = opts.send ?? defaultSend;
  }

  emit(rec: LogRecord): void {
    if (!this.matches(rec.category)) return;
    let span: OtlpSpan;
    try {
      const ts = unixNanoFromIso(rec.ts);
      span = {
        traceId: ensureTraceId(rec.trace_id),
        spanId: ensureSpanId(rec.span_id),
        ...(rec.parent_span_id ? { parentSpanId: ensureSpanId(rec.parent_span_id) } : {}),
        name: `${rec.category}:${rec.event}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: ts,
        endTimeUnixNano: ts,
        attributes: genAiAttributes(rec),
      };
    } catch {
      this.dropped++;
      return;
    }
    this.buffer.push(span);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const spans = this.buffer.splice(0, this.buffer.length);
    const body = JSON.stringify({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: this.serviceName } },
            { key: 'service.version', value: { stringValue: this.serviceVersion } },
          ],
        },
        scopeSpans: [{
          scope: { name: 'elanous.gen_ai', version: this.serviceVersion },
          spans,
        }],
      }],
    });
    this.inflight = this.send(this.endpoint, body)
      .catch((err) => {
        this.dropped += spans.length;
        try {
          logDiagnostic('otel.genai-sink', 'send-fail', {
            endpoint: this.endpoint,
            spans: spans.length,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch { /* never throw out of a sink */ }
      })
      .then(() => { this.inflight = null; });
  }

  /** Awaitable hook for tests + graceful shutdown. */
  async drain(): Promise<void> {
    this.flush();
    while (this.inflight) {
      await this.inflight;
    }
  }

  /** Diagnostic counter — total spans dropped due to send failures. */
  droppedSpans(): number { return this.dropped; }

  /** Test seam — reports current buffered span count. */
  bufferedCount(): number { return this.buffer.length; }

  private matches(category: string): boolean {
    for (const prefix of this.includePrefixes) {
      if (category === prefix.replace(/\.$/, '') || category.startsWith(prefix)) return true;
    }
    return false;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batchIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }
}

async function defaultSend(endpoint: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`OTLP HTTP ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Construct an OtelGenAISink from environment / flag snapshot.
 *  Returns null when the endpoint flag is unset so the boot path
 *  does not register a no-op sink. */
export function createOtelGenAISinkFromFlags(
  flags: {
    otelEndpoint: string | undefined;
    otelServiceName?: string;
    otelBatchSize?: number;
    otelBatchIntervalMs?: number;
    otelServiceVersion?: string;
  },
): OtelGenAISink | null {
  if (!flags.otelEndpoint || flags.otelEndpoint.trim().length === 0) return null;
  return new OtelGenAISink({
    endpoint: flags.otelEndpoint,
    ...(flags.otelServiceName ? { serviceName: flags.otelServiceName } : {}),
    ...(flags.otelBatchSize !== undefined ? { batchSize: flags.otelBatchSize } : {}),
    ...(flags.otelBatchIntervalMs !== undefined ? { batchIntervalMs: flags.otelBatchIntervalMs } : {}),
    ...(flags.otelServiceVersion ? { serviceVersion: flags.otelServiceVersion } : {}),
  });
}
