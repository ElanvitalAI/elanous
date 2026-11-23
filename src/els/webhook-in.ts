// Inbound webhook: POST /els/v1/hook/<name> (ELS-EXTERNAL-SURFACES §3.2, §3.3).
// The hook is a transport shell: it proves the sender, renders one line, and hands it to the one door.
// X-Els-Signature: sha256=HMAC(secret, `${name}.${timestamp}.${nonce}.${body}`) · X-Els-Timestamp (unix seconds,
// ±5 min) · X-Els-Nonce (refused once seen inside the window). The hook's own name is inside the signed material
// (#38609 REVIEW must ⓒ): hooks may share a secret file, but a signature made for one never opens another.
// A graph-target hook (GRAPH-SCHEDULER §1-1 ④) renders nothing into a pane: the proven envelope becomes
// a graph event envelope through the one dispatch entrance, and a write/external-send risk class holds
// the first firing for a person (§1-3).
// Any failure is 401, audited, nothing typed.
// The secret lives in a file named by secretRef. It is never echoed, logged, or audited.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { audit, createControl, type ControlExecute, type ControlOutcome, type HitlAsk } from './control.js';
import type { GraphExternalTriggerDispatchResult, HookInGraphTriggerDanger, HookInGraphTriggerEnvelope } from '../graph-runner/graph-events.js';

export interface HookConfig {
  /** File holding the shared secret. Relative paths resolve against the state dir. */
  readonly secretRef: string;
  /** Template target: the workspace whose pane receives the rendered line. */
  readonly workspace?: string;
  readonly pane?: string;
  /** Ignored (#38453 REVIEW must ②): the server decides the pane kind via paneIsShell, a hook cannot opt out of the danger classifier. */
  readonly shell?: boolean;
  /** `{{field}}` takes a top-level string or number from the JSON body. Missing fields render empty. */
  readonly template?: string;
  /** GRAPH-SCHEDULER §1-1 ④ — graph target: the graph yaml this hook fires (its loop.trigger.events must declare hook.in). */
  readonly graph?: string;
  /** §1-3 risk class of the graph target: write/external-send hold the first firing for a person. */
  readonly danger?: HookInGraphTriggerDanger;
  /** Source addresses allowed to call. Absent or empty = any source that can reach the listener. */
  readonly sources?: readonly string[];
}

export interface HookDeps {
  /** `<state>/els` — hooks.json, control-allow.json, control-audit.jsonl. */
  readonly stateDir: string;
  readonly execute: ControlExecute;
  readonly hitl?: HitlAsk;
  /** The owner's ledger answer to «is this pane a shell?». Absent or unresolvable = shell (fail closed). */
  readonly paneIsShell?: (workspace: string, pane: string) => boolean;
  readonly now?: () => number;
  /** Seen nonces → first-seen ms. Shared for the life of the listener. */
  readonly nonces: Map<string, number>;
  /** GRAPH-SCHEDULER §1-3 — person gate for the first firing of a write/external-send graph hook.
   *  Absent = fail closed: the firing is held and never dispatched. */
  readonly askGraphFirstFiring?: (request: {
    readonly hookName: string;
    readonly graphPath: string;
    readonly danger: HookInGraphTriggerDanger;
    readonly nonce: string;
    readonly source: string;
  }) => Promise<'approve' | 'deny' | 'timeout'>;
  /** Injected for tests; the default dispatches through the graph trigger entrance (GRAPH-SCHEDULER §5). */
  readonly dispatchHookInGraphTrigger?: (envelope: HookInGraphTriggerEnvelope) => Promise<GraphExternalTriggerDispatchResult>;
}

export interface HookRequest {
  readonly name: string;
  readonly body: string;
  readonly signature?: string;
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly source?: string;
}

const WINDOW_MS = 5 * 60_000;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

const json = (status: number, body: unknown): { status: number; body: string } => ({ status, body: JSON.stringify(body) });

function parseHook(value: unknown): HookConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.secretRef !== 'string' || !row.secretRef) return undefined;
  if (row.shell !== undefined && typeof row.shell !== 'boolean') return undefined;
  if (row.sources !== undefined && (!Array.isArray(row.sources) || !row.sources.every((s) => typeof s === 'string'))) return undefined;
  // GRAPH-SCHEDULER §1-3 — a graph-target hook declares its graph and its risk class, and never a pane.
  const graph = typeof row.graph === 'string' ? row.graph : '';
  const danger = row.danger;
  if (row.graph !== undefined && !graph) return undefined;
  if (danger !== undefined && danger !== 'read' && danger !== 'write' && danger !== 'external-send') return undefined;
  if (graph) {
    if (danger === undefined) return undefined;
    if (row.workspace !== undefined || row.pane !== undefined || row.template !== undefined) return undefined;
    return {
      secretRef: row.secretRef, graph,
      ...(danger !== undefined ? { danger: danger as HookInGraphTriggerDanger } : {}),
      ...(row.sources !== undefined ? { sources: row.sources as string[] } : {}),
    };
  }
  // Template target: one rendered line into one pane, as before. A risk class without a graph is not a hook.
  if (danger !== undefined) return undefined;
  if (typeof row.workspace !== 'string' || !row.workspace || typeof row.pane !== 'string' || !row.pane) return undefined;
  if (typeof row.template !== 'string' || !row.template) return undefined;
  return {
    secretRef: row.secretRef, workspace: row.workspace, pane: row.pane, template: row.template,
    ...(row.shell !== undefined ? { shell: row.shell as boolean } : {}),
    ...(row.sources !== undefined ? { sources: row.sources as string[] } : {}),
  };
}

/** One hook by name, or undefined when hooks.json is missing, broken, or the row is not a hook. */
export function loadHook(stateDir: string, name: string): HookConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'hooks.json'), 'utf8')) as { hooks?: Record<string, unknown> };
    if (!parsed.hooks || typeof parsed.hooks !== 'object' || !Object.hasOwn(parsed.hooks, name)) return undefined;
    return parseHook(parsed.hooks[name]);
  } catch {
    return undefined;
  }
}

function readSecret(stateDir: string, ref: string): string | undefined {
  try {
    const secret = readFileSync(isAbsolute(ref) ? ref : join(stateDir, ref), 'utf8').trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

/** #38609 REVIEW must ⓒ — the hook name is part of the signed material: hooks that share one secret
 * file still verify only against the signature made for their own name. */
export function signHook(secret: string, name: string, timestamp: string, nonce: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${name}.${timestamp}.${nonce}.${body}`).digest('hex')}`;
}

function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function renderTemplate(template: string, body: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = Object.hasOwn(body, key) ? body[key] : undefined;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
}

// #38453 REVIEW must ③ (hook path) — fixed words only: the executor's message, whatever it put in
// it, never reaches the response. The PAT path answers the same way; the webhook path matches it.
const OUTCOME_ERROR: Readonly<Record<'denied' | 'held' | 'rejected' | 'timeout' | 'audit-failed' | 'executor-error', string>> = {
  denied: 'forbidden',
  held: 'held for a person',
  rejected: 'rejected by the person',
  timeout: 'not answered in time',
  'audit-failed': 'not sent',
  'executor-error': 'executor failed',
};

function outcomeToHttp(outcome: ControlOutcome): { status: number; body: string } {
  if (!outcome.ok) {
    const status = outcome.code === 'denied' ? 403 : 409;
    return json(status, { error: OUTCOME_ERROR[outcome.code], code: outcome.code });
  }
  return json(outcome.exitCode === 0 ? 200 : outcome.exitCode === 2 ? 400 : 409, {
    ok: true,
    exitCode: outcome.exitCode,
    danger: outcome.danger,
    ...(outcome.queued !== undefined ? { queued: outcome.queued } : {}),
  });
}

export async function routeElsHook(deps: HookDeps, req: HookRequest): Promise<{ status: number; body: string }> {
  const now = (deps.now ?? Date.now)();
  const source = (req.source ?? '').replace(/^::ffff:/, '') || 'unknown';
  const refuse = (reason: string): { status: number; body: string } => {
    audit(deps.stateDir, { principal: `hook:${req.name}`, kind: 'webhook', surface: 'webhook', action: 'do', result: 'unauthorized', reason, source, at: now });
    return json(401, { error: 'unauthorized' });
  };
  // #38609 REVIEW must ⓑ — a refusal after a valid signature is audited too: the door never rejects
  // silently. The reason is a fixed word; nothing from the body is quoted.
  const reject = (reason: string): { status: number; body: string } => {
    audit(deps.stateDir, { principal: `hook:${req.name}`, kind: 'webhook', surface: 'webhook', action: 'do', result: 'refused', reason, source, at: now });
    return json(400, { error: reason });
  };
  if (!NAME.test(req.name)) return json(404, { error: 'not found' });
  const hook = loadHook(deps.stateDir, req.name);
  if (!hook) return json(404, { error: 'not found' });
  if (hook.sources && hook.sources.length > 0 && !hook.sources.includes(source)) return refuse('source not allowed');
  const secret = readSecret(deps.stateDir, hook.secretRef);
  if (!secret) return refuse('secret unreadable');
  const timestamp = req.timestamp ?? '';
  if (!/^\d{1,12}$/.test(timestamp)) return refuse('missing timestamp');
  if (Math.abs(now - Number(timestamp) * 1000) > WINDOW_MS) return refuse('timestamp outside window');
  const nonce = req.nonce ?? '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return refuse('missing nonce');
  // #38609 REVIEW must ⓒ — the signature covers `${name}.${timestamp}.${nonce}.${body}`: a signature
  // captured for one hook does not verify for another, even when both share the secret file.
  if (!req.signature || !signatureMatches(signHook(secret, req.name, timestamp, nonce, req.body), req.signature)) return refuse('signature mismatch');
  for (const [seen, at] of deps.nonces) if (now - at > WINDOW_MS * 2) deps.nonces.delete(seen);
  const key = `${req.name}:${nonce}`;
  if (deps.nonces.has(key)) return refuse('nonce reused');
  deps.nonces.set(key, now);

  let body: Record<string, unknown> = {};
  if (req.body) {
    try {
      const parsed: unknown = JSON.parse(req.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject('body must be a JSON object');
      body = parsed as Record<string, unknown>;
    } catch { return reject('body must be JSON'); }
  }
  // GRAPH-SCHEDULER §1-1 ④ — a graph-target hook never types a pane: the proven envelope becomes a graph
  // event envelope through the one dispatch entrance (§5). Everything above already refused unsigned,
  // replayed or late firings (#39168): only a proven envelope reaches this branch.
  if (hook.graph !== undefined) {
    const envelope: HookInGraphTriggerEnvelope = {
      hookName: req.name, nonce, at: new Date(now).toISOString(), body,
      graphPath: hook.graph, danger: hook.danger ?? 'read',
    };
    const dispatch = deps.dispatchHookInGraphTrigger ?? (async (input) => {
      const { dispatchHookInGraphTrigger } = await import('../graph-runner/graph-events.js');
      return dispatchHookInGraphTrigger(input);
    });
    const firstFiringFile = join(deps.stateDir, 'hook-trigger-first-firing.json');
    const firstFiring = (): Record<string, unknown> => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(firstFiringFile, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch { return {}; }
    };
    // §1-3 — 쓰기/외부 발신 위험이면 첫 발화 HITL: a person approves the hook↔graph pairing once.
    // No person channel = fail closed: the firing is held, not dispatched.
    // #39687 — the approval key binds name·graphPath·danger as one: a record counts only when the stored
    // graph and risk class still match the hook's declared target. A repointed graph or a changed risk
    // class is a different pairing and asks the person again (a record that predates the danger field,
    // or any mismatch, fails closed).
    const approvedPairing = (record: Record<string, unknown>): boolean => {
      const row: unknown = record[req.name];
      if (row === undefined || row === null || typeof row !== 'object' || Array.isArray(row)) return false;
      const binding = row as { graphPath?: unknown; danger?: unknown };
      return binding.graphPath === hook.graph && binding.danger === envelope.danger;
    };
    if (envelope.danger !== 'read' && !approvedPairing(firstFiring())) {
      const answer = deps.askGraphFirstFiring !== undefined
        ? await deps.askGraphFirstFiring({ hookName: req.name, graphPath: hook.graph, danger: envelope.danger, nonce, source })
        : 'timeout';
      if (answer !== 'approve') {
        const reason = answer === 'deny' ? 'graph-first-firing-person-denied' : 'graph-first-firing-person-timeout';
        audit(deps.stateDir, { principal: `hook:${req.name}`, kind: 'webhook', surface: 'webhook', action: 'do', result: 'held', reason, source, at: now });
        return json(403, { error: OUTCOME_ERROR.held, code: 'graph-first-firing' });
      }
    }
    let result: GraphExternalTriggerDispatchResult;
    try { result = await dispatch(envelope); }
    catch {
      audit(deps.stateDir, { principal: `hook:${req.name}`, kind: 'webhook', surface: 'webhook', action: 'do', result: 'refused', reason: 'graph-dispatch-failed', source, at: now });
      return json(503, { error: OUTCOME_ERROR['executor-error'] });
    }
    if (result.disposition === 'ignored') {
      // The graph's own loop.trigger.events declaration decides (§5): a hook aimed at a graph that does
      // not declare hook.in is a configuration error, never a firing.
      audit(deps.stateDir, { principal: `hook:${req.name}`, kind: 'webhook', surface: 'webhook', action: 'do', result: 'refused', reason: 'graph-event-not-declared', source, at: now });
      return json(503, { error: 'invalid-graph-trigger' });
    }
    // §1-3 — the person's approval of this hook↔graph↔risk pairing is remembered: later firings of the
    // same pairing dispatch without asking. #39687 — a record for a different pairing is replaced by the
    // one the person just approved; graphPath and danger ride in the record so the check above can
    // compare them, not just the hook name.
    if (envelope.danger !== 'read') {
      const record = firstFiring();
      if (!approvedPairing(record))
        writeFileSync(firstFiringFile, `${JSON.stringify({ ...record, [req.name]: { graphPath: hook.graph, danger: envelope.danger, at: new Date(now).toISOString() } }, null, 2)}\n`);
    }
    audit(deps.stateDir, { principal: `hook:${req.name}`, kind: 'webhook', surface: 'webhook', action: 'do', result: 'executed', reason: `graph-${result.disposition}`, source, at: now });
    return json(202, { ok: true, disposition: result.disposition, graphId: result.graphId, runId: result.runId });
  }
  const workspace = hook.workspace;
  const pane = hook.pane;
  const template = hook.template;
  if (workspace === undefined || pane === undefined || template === undefined) return json(404, { error: 'not found' });
  const text = renderTemplate(template, body);
  if (!text.trim()) return reject('template rendered empty');
  const control = createControl({ stateDir: deps.stateDir, execute: deps.execute, ...(deps.now ? { now: deps.now } : {}), ...(deps.hitl ? { hitl: deps.hitl } : {}) });
  const outcome = await control.run({
    principal: { id: `hook:${req.name}`, kind: 'webhook' },
    action: 'do',
    // #38453 REVIEW must ② — hooks.json `shell` never decides: only the server's paneIsShell does (fail closed).
    target: { workspace, pane, shell: deps.paneIsShell ? deps.paneIsShell(workspace, pane) : true },
    text,
  });
  return outcomeToHttp(outcome);
}
