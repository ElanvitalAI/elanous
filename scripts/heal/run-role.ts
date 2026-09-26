#!/usr/bin/env bun
/** 힐 판 역할 하나 — ELANOUS_GRAPH_CONTEXT 를 읽고 마지막 줄에 {outcome, …} JSON 을 낸다. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import {
  fillMissingGateFacts,
  markDeletedUnverified,
  mergeHealSignatures,
  triageFailure,
  type HealCitation,
  type HealFailureSignature,
  type HealTriageHistory,
  type PathExists,
} from '../../src/self-implement/heal-triage.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../../src/self-implement/run-ledger.js';

interface GraphContext {
  graphId?: string;
  runId?: string;
  nodeId?: string;
  input?: unknown;
  outputs?: Record<string, unknown>;
}

function readContext(): GraphContext {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GraphContext;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function citationsOf(value: unknown): HealCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return typeof record?.title === 'string' && typeof record.url === 'string' && record.url.trim()
      && typeof record.snippet === 'string'
      ? [{ title: record.title, url: record.url, snippet: record.snippet }]
      : [];
  });
}

function failureOf(ctx: GraphContext): HealFailureSignature {
  const input = asRecord(ctx.input);
  const raw = asRecord(input?.failure) ?? input ?? {};
  const unverified = Array.isArray(raw.unverified) ? raw.unverified.filter((item): item is string => typeof item === 'string') : [];
  const citations = citationsOf(raw.citations);
  return {
    ...(typeof raw.failedTests === 'number' ? { failedTests: raw.failedTests } : {}),
    ...(typeof raw.introduced === 'number' ? { introduced: raw.introduced } : {}),
    ...(typeof raw.unknown === 'number' ? { unknown: raw.unknown } : {}),
    ...(typeof raw.timedOut === 'number' ? { timedOut: raw.timedOut } : {}),
    ...(unverified.length ? { unverified } : {}),
    ...(typeof raw.importerUnrunTests === 'number' ? { importerUnrunTests: raw.importerUnrunTests } : {}),
    ...(typeof raw.environmentClaim === 'string' ? { environmentClaim: raw.environmentClaim } : {}),
    ...(typeof raw.namedSource === 'string' ? { namedSource: raw.namedSource } : {}),
    ...(typeof raw.errorText === 'string' ? { errorText: raw.errorText } : {}),
    ...(citations.length ? { citations } : {}),
  };
}

function historyOf(ctx: GraphContext): HealTriageHistory {
  return { visited: Object.keys(ctx.outputs ?? {}) };
}

function accountCount(failure: Record<string, unknown>): number | undefined {
  const evidence = asRecord(failure.environmentEvidence);
  const count = evidence?.accountCount ?? failure.accountCount;
  return typeof count === 'number' ? count : undefined;
}

function exitCode(failure: Record<string, unknown>): number | undefined {
  const evidence = asRecord(failure.environmentEvidence);
  const code = evidence?.exitCode ?? failure.exitCode;
  return typeof code === 'number' ? code : undefined;
}

function credentialMissing(failure: Record<string, unknown>): boolean {
  const evidence = asRecord(failure.environmentEvidence);
  return evidence?.credentialFile === 'missing' || failure.credentialFile === 'missing';
}

function accountsFullOrExpired(failure: Record<string, unknown>): boolean {
  const evidence = asRecord(failure.environmentEvidence);
  return evidence?.accounts === 'full' || evidence?.accounts === 'expired'
    || failure.accounts === 'full' || failure.accounts === 'expired';
}

export interface HealRoleDeps {
  exists?: (path: string) => PathExists;
  loadLedger?: (runId: string) => RunLedgerEntry[] | null;
  ledgerDir?: string;
  search?: (query: string) => unknown;
}

function gitHeadExists(worktree: string, path: string): PathExists {
  const repo = spawnSync('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (repo.error || repo.status !== 0) return 'unknown';
  const child = spawnSync('git', ['-C', worktree, 'cat-file', '-e', `HEAD:${path}`], { encoding: 'utf8' });
  if (child.error || child.status === null) return 'unknown';
  return child.status === 0;
}

function defaultExists(worktree: string): (path: string) => PathExists {
  return (path) => gitHeadExists(worktree, path);
}

function signatureFromUnknown(value: unknown): HealFailureSignature | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const unverified = Array.isArray(raw.unverified) ? raw.unverified.filter((item): item is string => typeof item === 'string') : undefined;
  const citations = citationsOf(raw.citations);
  const signature: HealFailureSignature = {
    ...(typeof raw.failedTests === 'number' ? { failedTests: raw.failedTests } : {}),
    ...(typeof raw.introduced === 'number' ? { introduced: raw.introduced } : {}),
    ...(typeof raw.unknown === 'number' ? { unknown: raw.unknown } : {}),
    ...(typeof raw.timedOut === 'number' ? { timedOut: raw.timedOut } : {}),
    ...(unverified ? { unverified } : {}),
    ...(typeof raw.importerUnrunTests === 'number' ? { importerUnrunTests: raw.importerUnrunTests } : {}),
    ...(typeof raw.environmentClaim === 'string' ? { environmentClaim: raw.environmentClaim } : {}),
    ...(typeof raw.namedSource === 'string' ? { namedSource: raw.namedSource } : {}),
    ...(typeof raw.errorText === 'string' ? { errorText: raw.errorText } : {}),
    ...(citations.length ? { citations } : {}),
  };
  return Object.keys(signature).length ? signature : undefined;
}

function outputRecord(outputs: Record<string, unknown> | undefined, nodeId: string): Record<string, unknown> | undefined {
  const raw = outputs?.[nodeId];
  if (typeof raw === 'string') {
    const line = raw.split('\n').map((row) => row.trim()).filter(Boolean).at(-1);
    return line?.startsWith('{') ? asRecord(JSON.parse(line) as unknown) : undefined;
  }
  return asRecord(raw);
}

function collectSignature(outputs: Record<string, unknown> | undefined): HealFailureSignature | undefined {
  const record = outputRecord(outputs, 'collect');
  const entries = Array.isArray(record?.entries) ? record.entries : [];
  return signatureFromUnknown(entries[0]);
}

function deeperSignature(outputs: Record<string, unknown> | undefined): HealFailureSignature | undefined {
  const record = outputRecord(outputs, 'observe-deeper');
  return signatureFromUnknown(record?.signature);
}

function externalSignature(outputs: Record<string, unknown> | undefined): HealFailureSignature | undefined {
  const record = outputRecord(outputs, 'ground-external');
  return record?.outcome === 'ok' ? signatureFromUnknown(record) : undefined;
}

function withAddedFacts(result: Record<string, unknown>, addedFacts: readonly string[]): Record<string, unknown> {
  return { ...result, addedFacts: [...addedFacts] };
}

function mergedContextSignature(signature: HealFailureSignature, outputs: GraphContext['outputs']) {
  const collect = collectSignature(outputs);
  const deeper = deeperSignature(outputs);
  const external = externalSignature(outputs);
  return mergeHealSignatures(signature, [
    ...(collect ? [{ source: 'collect', signature: collect }] : []),
    ...(deeper ? [{ source: 'observe-deeper', signature: deeper }] : []),
    ...(external ? [{ source: 'ground-external', signature: external }] : []),
  ]);
}

function firstJsonObject(text: string): string | undefined {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== '{') return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

function defaultSearch(query: string): unknown {
  const script = join(homedir(), '.claude/skills/omni-crawl/scripts/main.ts');
  const child = spawnSync('npx', ['tsx', script, query, '--engine', 'fc-dev', '--json'], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) return [];
  const begin = '---BEGIN_OMNI_CRAWL_JSON---';
  const end = '---END_OMNI_CRAWL_JSON---';
  const start = child.stdout.indexOf(begin);
  if (start < 0) return [];
  const finish = child.stdout.indexOf(end, start + begin.length);
  try {
    const payload = child.stdout.slice(start + begin.length, finish < 0 ? undefined : finish);
    return JSON.parse(finish < 0 ? firstJsonObject(payload) ?? '' : payload.trim()) as unknown;
  } catch {
    return [];
  }
}

function searchCitations(value: unknown): HealCitation[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const raw = asRecord(item);
      const snippet = raw?.snippet ?? raw?.text;
      return typeof raw?.url === 'string' && raw.url.trim() && typeof raw.title === 'string' && typeof snippet === 'string'
        ? [{ title: raw.title, url: raw.url, snippet: snippet.slice(0, 200) }]
        : [];
    }).slice(0, 5);
  }
  const payload = asRecord(value);
  if (!Array.isArray(payload?.results)) return [];
  return searchCitations(payload.results.flatMap((result) => {
    const record = asRecord(result);
    return Array.isArray(record?.items) ? record.items : [result];
  }));
}

function groundQuery(signature: HealFailureSignature, failure: Record<string, unknown>): string {
  if (signature.errorText?.trim()) return signature.errorText;
  const names = failure.failedTestNames ?? failure.failingTests ?? failure.testNames;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string').slice(0, 3).join(' ') : '';
}

export function roleResult(role: string, ctx: GraphContext, deps: HealRoleDeps = {}): Record<string, unknown> {
  const input = asRecord(ctx.input) ?? {};
  const failure = asRecord(input.failure) ?? input;
  const signature = failureOf(ctx);
  switch (role) {
    case 'observe-ledger': {
      if (!asRecord(input.failure) && Object.keys(failure).length === 0) return withAddedFacts({ outcome: 'empty' }, []);
      const worktree = typeof input.worktree === 'string' ? input.worktree : '';
      const paths = signature.unverified ?? [];
      if (!worktree || paths.length === 0) return withAddedFacts({ outcome: 'ok', entries: [signature] }, []);
      const exists = deps.exists ?? defaultExists(worktree);
      const marked = markDeletedUnverified(paths, exists);
      const changed = marked.some((path, index) => path !== paths[index]);
      const entry: HealFailureSignature = { ...signature, unverified: marked };
      return withAddedFacts({ outcome: 'ok', entries: [entry] }, changed ? ['unverified'] : []);
    }
    case 'triage': {
      const merged = mergedContextSignature(signature, ctx.outputs);
      const judged = triageFailure(merged.signature, historyOf(ctx));
      return withAddedFacts(
        { outcome: judged.outcome === 'rework-with-citations' ? 'child-fixable' : judged.outcome, evidence: [...merged.evidence, ...judged.evidence] },
        merged.evidence.map((line) => line.split(' ← ')[0]!).filter((field, index, all) => all.indexOf(field) === index),
      );
    }
    case 'verify-classification-evidence': {
      const count = accountCount(failure);
      const code = exitCode(failure);
      if (count === 0) return { outcome: 'corrected', 'corrected-kind': 'no-account' };
      if (code === 127) return { outcome: 'corrected', 'corrected-kind': 'binary-missing' };
      if (credentialMissing(failure)) return { outcome: 'corrected', 'corrected-kind': 'credential-file-missing' };
      if ((count ?? 0) > 0 && accountsFullOrExpired(failure)) return { outcome: 'confirmed', next: 'defer' };
      return { outcome: 'corrected', 'corrected-kind': 'unexplained' };
    }
    case 'acknowledge-untestable':
      return withAddedFacts({ outcome: 'ok', next: 'review', acknowledged: [...(signature.unverified ?? [])] }, []);
    case 'rework-note': {
      const grounded = mergedContextSignature(signature, ctx.outputs).signature;
      const file = grounded.namedSource?.trim() || (grounded.unverified ?? []).find((path) => !path.endsWith('.md')) || 'unknown';
      const symbol = typeof failure.symbol === 'string' ? failure.symbol : file.split('/').pop();
      const citations = grounded.citations ?? [];
      const urls = citations.length ? `\n근거: ${citations.map((citation) => citation.url).join(' · ')}` : '';
      return withAddedFacts({ outcome: 'ok', next: 'implement', 'rework-note': `${file} 의 ${symbol} 을 고친다${urls}` }, []);
    }
    case 'verify':
    case 'revise-goal':
      return withAddedFacts({ outcome: 'fail', reason: 'not-wired' }, []);
    case 'observe-deeper': {
      const runId = typeof input.runId === 'string' ? input.runId : '';
      if (!runId) return withAddedFacts({ outcome: 'empty', reason: 'not-wired' }, []);
      const entries = deps.loadLedger
        ? deps.loadLedger(runId)
        : loadRunLedger(runId, deps.ledgerDir ?? (process.env.ELANOUS_STATE_DIR ? runLedgerDir(process.env.ELANOUS_STATE_DIR) : undefined));
      const filled = fillMissingGateFacts(signature, entries ?? []);
      if (filled.added.length === 0) return withAddedFacts({ outcome: 'empty', reason: 'no-new-facts' }, []);
      return withAddedFacts({ outcome: 'ok', signature: filled.signature }, filled.added);
    }
    case 'ground-external': {
      const collect = collectSignature(ctx.outputs);
      const deeper = deeperSignature(ctx.outputs);
      const grounded = mergeHealSignatures(signature, [
        ...(collect ? [{ source: 'collect', signature: collect }] : []),
        ...(deeper ? [{ source: 'observe-deeper', signature: deeper }] : []),
      ]).signature;
      const query = groundQuery(grounded, failure);
      const started = Date.now();
      let citations: HealCitation[] = [];
      if (query) {
        try { citations = searchCitations((deps.search ?? defaultSearch)(query)); }
        catch { /* A failed external search is an empty observation, not a failed heal role. */ }
      }
      const search = { query, count: citations.length, ms: Date.now() - started };
      debug.log('graph.heal', 'ground-external-search', search);
      return citations.length
        ? withAddedFacts({ outcome: 'ok', citations, ...search }, ['citations'])
        : withAddedFacts({ outcome: 'empty', reason: 'no-results', ...search }, []);
    }
    default:
      return withAddedFacts({ outcome: 'fail', reason: `unknown-role:${role}` }, []);
  }
}

if (import.meta.main) {
  const role = process.argv[2] ?? '';
  const ctx = readContext();
  const result = roleResult(role, ctx);
  debug.log('graph.heal', role || 'missing-role', { outcome: result.outcome, nodeId: ctx.nodeId, runId: ctx.runId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.outcome === 'fail' && result.reason !== 'not-wired') process.exitCode = 1;
}
