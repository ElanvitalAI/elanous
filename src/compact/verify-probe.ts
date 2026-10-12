// ── Wave 5 · verify probe (Gemini-style) ────────────────────────────
//
// After Layer 3 produces a summary, optionally re-call the
// summarizer with a meta-prompt: "Given this summary against the
// original transcript slice, identify any technical detail that
// was lost." When the probe returns "none" / empty, accept the
// summary; otherwise reject and let the pipeline fall through to
// truncateProportional (Wave 5 fallback chain).
//
// Off by default — enable via setVerifyProbeEnabled(true) (or via
// user-config in a future Wave 6 follow-up). Cost is one extra
// summary-tier call per compact.

import type { LLMMessage } from '../llm.js';
import { streamLLM } from '../llm.js';
import { debug } from '../debug/log.js';
import { resolveSummarizerModel } from './provider.js';
import { buildCompactTranscript, stripCompactScratchpad } from './summarize.js';

const VERIFY_SYSTEM_PROMPT = `
You are auditing a context summary against the original transcript.
Identify ONE specific technical detail that the summary lost — a
file path, exact value, decision rationale, or unfinished work
marker that the resuming agent will miss without it. Reply with
one of:

- "none" if the summary is faithful enough to resume work
- otherwise a single short paragraph describing the missed detail

No preamble, no markdown. Be ruthless — false negatives are worse
than false positives at this stage.
`.trim();

export interface VerifyProbeArgs {
  summary: string;
  originalSlice: readonly LLMMessage[];
  activeModelId?: string;
  summarizerModel?: string;
  timeoutMs?: number;
  /** Injectable stream call — default `streamLLM` (byte-identical
   *  behavior when omitted). Tests inject a stub so the probe can be
   *  exercised with zero real LLM calls. */
  stream?: typeof streamLLM;
}

export type VerifyProbeStatus = 'pass' | 'fail' | 'error';

export interface VerifyProbeResult {
  /** True when the probe judged the summary acceptable. */
  ok: boolean;
  /** Probe's response text (free form). Empty when probe failed. */
  notes: string;
  /** Outcome classification: 'pass' = probe accepted the summary,
   *  'fail' = probe found a lost detail (ok:false), 'error' = probe
   *  call failed/timed out (fail-open — ok stays true). */
  status: VerifyProbeStatus;
  /** The model the probe ran on (resolveSummarizerModel result);
   *  null when unresolved. */
  model: string | null;
}

export async function runVerifyProbe(
  args: VerifyProbeArgs,
): Promise<VerifyProbeResult> {
  const transcript = buildCompactTranscript(args.originalSlice);
  const model = resolveSummarizerModel(args.activeModelId, args.summarizerModel);
  const req: LLMMessage[] = [
    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Original transcript:\n\n${transcript}\n\n` +
        `Proposed summary:\n\n${args.summary}\n\n` +
        `Identify one missed detail, or reply "none".`,
    },
  ];
  const timeoutMs = args.timeoutMs ?? 30_000;
  const stream = args.stream ?? streamLLM;
  try {
    const text = await Promise.race([
      stream(req, () => { /* silent */ }, model ? { model } : {}),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('verify probe timeout')), timeoutMs),
      ),
    ]);
    const notes = stripCompactScratchpad(text).trim();
    const ok = /^none\b/i.test(notes) || notes.length === 0;
    const status: VerifyProbeStatus = ok ? 'pass' : 'fail';
    const result: VerifyProbeResult = { ok, notes, status, model: model ?? null };
    debug.log('compact.verify-probe', 'probe-result', { status, model });
    return result;
  } catch {
    // Probe failure is non-fatal — accept the summary by default.
    const result: VerifyProbeResult = { ok: true, notes: '', status: 'error', model: model ?? null };
    debug.log('compact.verify-probe', 'probe-result', { status: result.status, model: result.model });
    return result;
  }
}
