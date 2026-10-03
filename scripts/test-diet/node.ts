#!/usr/bin/env bun
// TD2 graph nodes: pick → measure → record. Shadow only — measures alone on a remote host and drafts a card.
//   bun scripts/test-diet/node.ts pick|measure|audit|record (test-diet or nightly-audit graph)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { CardStore } from '../../src/task-cards/card-store.js';
import { GATE_NIGHTLY_AUDITS } from '../release-loop/gate-node.js';
import { appendLedger, costTable, judge, lastLedgerLine, ledgerPath, nightlyAuditLedgerPath, pickRange, propose, td1Dispositions, writeCardDraft, type LedgerLine, type Measurement, type Td1Disposition } from './lib.js';

type Context = { graphId?: string; input: Record<string, unknown>; outputs: Record<string, Record<string, unknown> | null> };
function context(): Context {
  const at = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!at) throw new Error('ELANOUS_GRAPH_CONTEXT required');
  const raw = JSON.parse(at.trimStart().startsWith('{') ? at : readFileSync(at, 'utf8')) as Partial<Context>;
  return { graphId: raw.graphId, input: raw.input ?? {}, outputs: raw.outputs ?? {} };
}
function emit(result: Record<string, unknown> & { outcome: 'ok' | 'fail' | 'error'; summary: string }): number {
  console.log(JSON.stringify({ verdict: result.outcome === 'ok' ? 'pass' : 'fail', ...result }));
  return result.outcome === 'ok' ? 0 : result.outcome === 'fail' ? 1 : 2;
}
const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';

function pick(ctx: Context): number {
  const budgetSecs = typeof ctx.input.budgetSecs === 'number' && ctx.input.budgetSecs > 0 ? ctx.input.budgetSecs : 1800;
  const files = git(['ls-files', '*.test.ts']).split('\n').filter(Boolean).sort();
  const costs = costTable(readFileSync(join(process.cwd(), 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv'), 'utf8'));
  const last = lastLedgerLine(effectiveInstanceRoot());
  for (const r of last?.results ?? []) costs.set(r.file, r.secs);
  // `start` re-looks a slice on purpose; otherwise continue from the ledger cursor.
  const startAt = typeof ctx.input.start === 'number' && ctx.input.start >= 0 ? ctx.input.start : last?.next ?? 0;
  const range = pickRange(files, startAt, costs, budgetSecs);
  return emit({ outcome: 'ok', summary: `test-diet pick #${range.start}~#${range.end} of ${files.length} (≈${Math.round(range.estimatedSecs)}s)`, ...range, total: files.length, budgetSecs });
}

/** One remote run: shallow clone of the mirror, one install, each file alone with its peak memory. */
function measure(ctx: Context, audit = false): number {
  const picked = audit ? [...GATE_NIGHTLY_AUDITS] : ctx.outputs.pick?.files;
  if (!Array.isArray(picked) || picked.length === 0) return emit({ outcome: 'fail', summary: 'nothing picked' });
  const host = typeof ctx.input.remote === 'string' ? ctx.input.remote : 'node-b';
  const mirror = typeof ctx.input.mirror === 'string' ? ctx.input.mirror : '~/mirror/elanous-agent.git';
  const script = [
    'set -u', 'export PATH="$HOME/.bun/bin:$PATH"',
    'T=$(mktemp -d)', 'trap \'rm -rf "$T"\' EXIT',
    `git clone -q --depth 1 "file://$(eval echo ${mirror})" "$T/repo" || exit 3`,
    // Same installs as the gate: root and apps/pwa (PWA tests import its own dependencies).
    'cd "$T/repo" && bun install --frozen-lockfile >/dev/null 2>&1 || exit 4',
    '(cd apps/pwa && bun install --frozen-lockfile >/dev/null 2>&1) || echo "WARN pwa-install-failed"',
    'echo "COMMIT $(git rev-parse HEAD)"',
    'TO=$(command -v timeout || command -v gtimeout || true)',
    'while IFS= read -r f; do',
    '  [ -n "$f" ] || continue',
    '  s=$(date +%s)',
    '  if [ -n "$TO" ]; then /usr/bin/time -l "$TO" -k 10 300 bun run scripts/test-deterministic.ts "./$f" > "$T/out" 2> "$T/err"; else /usr/bin/time -l bun run scripts/test-deterministic.ts "./$f" > "$T/out" 2> "$T/err"; fi',
    '  rc=$?; e=$(( $(date +%s) - s ))',
    '  rss=$(awk \'/maximum resident set size/ {printf "%d", $1/1048576}\' "$T/err")',
    // bun test prints its summary on stderr — read both streams.
    '  pass=$(cat "$T/out" "$T/err" | grep -E -o "^ *[0-9]+ pass" | grep -E -o "[0-9]+" | tail -1); fail=$(cat "$T/out" "$T/err" | grep -E -o "^ *[0-9]+ fail" | grep -E -o "[0-9]+" | tail -1)',
    // A failing file names its first error, so an environment gap (e.g. no Java on the host) is not read as a test defect.
    '  why=""; [ "$rc" -ne 0 ] && why=$(grep -v -E "^\\s*$|^bun test|^ *[0-9]+ \\||^error: *$" "$T/err" | grep -m1 -E "Unable to|Cannot find|not found|ENOENT|EACCES|rror" | tr "\\t" " " | cut -c1-160)',
    '  printf "M\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$f" "$e" "${rss:-}" "$rc" "${pass:-}" "${fail:-}" "$why"',
    "done <<'TEST_DIET_FILES'", ...picked, 'TEST_DIET_FILES',
  ].join('\n');
  const run = spawnSync('ssh', ['-o', 'BatchMode=yes', host, 'bash', '-s'], { input: `${script}\n`, encoding: 'utf8', timeout: 4 * 3600_000, maxBuffer: 16 * 1024 * 1024 });
  const remoteError = run.status !== 0 ? `remote measure failed (rc=${run.status ?? 'no exit'}): ${String(run.error ?? run.stderr ?? '').trim().slice(0, 200)}` : undefined;
  if (!audit && remoteError && !String(run.stdout).includes('\nM\t')) return emit({ outcome: 'error', summary: remoteError });
  const commit = /^COMMIT (\w+)/m.exec(String(run.stdout))?.[1] ?? '?';
  const measurements: Measurement[] = String(run.stdout).split('\n').filter((l) => l.startsWith('M\t')).map((l) => {
    const [, file, secs, rss, rc, pass, fail, why] = l.split('\t');
    const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
    return { file: file!, secs: Number(secs), rssMb: num(rss), rc: num(rc), pass: num(pass), fail: num(fail), ...(why ? { reason: why } : {}) };
  });
  const complete = measurements.length === picked.length && picked.every((file) => measurements.some((m) => m.file === file));
  const summary = remoteError ?? `measured ${measurements.length}/${picked.length} on ${host} at ${commit.slice(0, 9)}`;
  return emit({ outcome: audit ? complete && !remoteError ? 'ok' : 'error' : measurements.length ? 'ok' : 'error',
    summary, host, commit, measurements, ...(remoteError ? { remoteError } : {}) });
}

function recordNightlyAudit(ctx: Context): number {
  const m = ctx.outputs.audit;
  const raw = Array.isArray(m?.measurements) ? m.measurements : [];
  const measured = new Map<string, Measurement>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !('file' in item) || typeof item.file !== 'string' || !GATE_NIGHTLY_AUDITS.includes(item.file)) continue;
    const x = item as Partial<Measurement>;
    if (measured.has(item.file) || typeof x.secs !== 'number' || !Number.isFinite(x.secs)
      || (x.rssMb !== null && (typeof x.rssMb !== 'number' || !Number.isFinite(x.rssMb)))
      || (x.rc !== null && (typeof x.rc !== 'number' || !Number.isInteger(x.rc)))
      || (x.pass !== null && (typeof x.pass !== 'number' || !Number.isInteger(x.pass)))
      || (x.fail !== null && (typeof x.fail !== 'number' || !Number.isInteger(x.fail)))) continue;
    measured.set(item.file, x as Measurement);
  }
  const error = typeof m?.remoteError === 'string' ? m.remoteError
    : m?.outcome === 'error' || m?.outcome === 'fail' || !m
      ? typeof m?.summary === 'string' ? m.summary : 'audit execution produced no result' : undefined;
  const results = GATE_NIGHTLY_AUDITS.map((file, index) => {
    const found = measured.get(file);
    const measurement: Measurement = found ?? { file, secs: 0, rssMb: null, rc: null, pass: null, fail: null,
      reason: `not measured: ${typeof m?.summary === 'string' ? m.summary : error ?? 'audit result missing'}` };
    // Even a complete set of file outputs cannot prove a clean audit when the remote process failed afterward.
    return judge(error && measured.size === GATE_NIGHTLY_AUDITS.length && index === 0 && found
      ? { ...found, rc: found.rc === 0 ? null : found.rc, reason: `${error}${found.reason ? `; ${found.reason}` : ''}` } : measurement, 1);
  });
  const line = { at: new Date().toISOString(), range: 'nightly-audit', start: 0, end: results.length - 1,
    next: 0, total: results.length, commit: String(m?.commit ?? '?'), budgetSecs: 0, ...(error ? { error } : {}), results };
  const root = effectiveInstanceRoot();
  const path = nightlyAuditLedgerPath(root);
  mkdirSync(join(root, 'test-diet'), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  const card = writeCardDraft(root, line);
  const failing = results.filter((r) => r.verdict === 'failing').length;
  debug.log('test-diet', 'nightly-audit-recorded', { files: results.length, failing, card: card !== null });
  return emit({ outcome: failing ? 'fail' : 'ok', summary: `nightly audit ${results.length} · failing ${failing}${card ? ' · card draft' : ''}`, failing, ledger: path, ...(card ? { card } : {}) });
}

export function record(ctx: Context, deps: { createStore?: (root: string) => Pick<CardStore, 'createCard' | 'appendSection' | 'close'>; td1?: ReadonlyMap<string, Td1Disposition> } = {}): number {
  const p = ctx.outputs.pick;
  const m = ctx.outputs.measure;
  const measurements = (m?.measurements ?? []) as Measurement[];
  if (!p || measurements.length === 0) return emit({ outcome: 'fail', summary: 'nothing measured' });
  const td1 = deps.td1 ?? td1Dispositions(readFileSync(join(process.cwd(), 'docs/measurements/td1-top200-content-review-2026-10-01.tsv'), 'utf8'));
  const results = measurements.map((x) => propose(judge(x, git(['log', '--since=90.days', '--format=%s', '--', x.file]).split('\n').filter((s) => /^fix\b/i.test(s)).length), td1));
  const line = {
    at: new Date().toISOString(), range: `#${p.start}~#${p.end}`, start: Number(p.start), end: Number(p.end), next: Number(p.next), total: Number(p.total),
    commit: String(m?.commit ?? '?'), budgetSecs: Number(p.budgetSecs), results,
  };
  const root = effectiveInstanceRoot();
  appendLedger(root, line);
  const card = writeCardDraft(root, line);
  const proposals: Record<string, number> = {};
  for (const result of results) {
    if (!result.proposal) continue;
    proposals[result.proposal] = (proposals[result.proposal] ?? 0) + 1;
    let store: Pick<CardStore, 'createCard' | 'appendSection' | 'close'> | undefined;
    try {
      store = deps.createStore?.(root) ?? new CardStore(root);
      const task = store.createCard({ goalId: `test-diet:${result.file}:${result.proposal}`, title: `시험 다이어트 제안 — ${result.file} · ${result.proposal}` });
      const observation = { proposal: result.proposal, basis: result.basis, guards: td1.get(result.file)?.guards ?? '',
        secs: result.secs, rssMb: result.rssMb, caught90: result.caught90, range: line.range };
      const fingerprint = createHash('sha256').update(JSON.stringify(observation)).digest('hex');
      const key = `test-diet:${line.commit}:${fingerprint}`;
      if (!task.sections.some((section) => section.key === key)) store.appendSection(task.id, {
        key, owner: 'test-diet', content: JSON.stringify({ ...observation, at: line.at }),
      });
    } catch (error) {
      console.warn(`test-diet card failed: ${result.file}: ${String(error)}`);
      debug.log('test-diet', 'card-failed', { file: result.file });
    } finally {
      try { store?.close(); } catch (error) {
        console.warn(`test-diet card close failed: ${result.file}: ${String(error)}`);
        debug.log('test-diet', 'card-failed', { file: result.file });
      }
    }
  }
  debug.log('test-diet', 'proposed', { range: line.range, proposals });
  const counts = { keep: results.filter((r) => r.verdict === 'keep').length, review: results.filter((r) => r.verdict === 'review').length, failing: results.filter((r) => r.verdict === 'failing').length };
  debug.log('test-diet', 'recorded', { range: line.range, ...counts, card: card !== null });
  return emit({ outcome: 'ok', summary: `test-diet ${line.range} · keep ${counts.keep} · review ${counts.review} · failing ${counts.failing}${card ? ' · card draft' : ''}`, range: line.range, ...counts, ...(card ? { card } : {}) });
}

function status(root: string, options: { json?: boolean; days?: number } = {}): number {
  const path = ledgerPath(root);
  const ledger = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!ledger.trim()) {
    if (options.json) console.log(JSON.stringify({ error: '원장 없음 — 한 번도 안 돌았다' }));
    else console.log('원장 없음 — 한 번도 안 돌았다');
    return 1;
  }
  const latest = new Map<string, LedgerLine>();
  for (const raw of ledger.split('\n').filter(Boolean)) {
    const line = JSON.parse(raw) as LedgerLine;
    const date = new Date(new Date(line.at).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    if (!latest.has(date) || latest.get(date)!.at <= line.at) latest.set(date, line);
  }
  const days = options.days ?? 3;
  const dates = [...latest.keys()].sort().reverse().slice(0, days);
  let consecutive = 0;
  for (const date of [...latest.keys()].sort().reverse()) {
    const expected = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - consecutive * 86_400_000).toISOString().slice(0, 10);
    if (date !== expected) break;
    consecutive++;
  }
  const rows = dates.map((date) => {
    const line = latest.get(date)!;
    return { date, range: line.range, measured: line.results.length, total: line.total,
      keep: line.results.filter((r) => r.verdict === 'keep').length,
      review: line.results.filter((r) => r.verdict === 'review').length,
      failing: line.results.filter((r) => r.verdict === 'failing').length,
      proposals: line.results.filter((r) => r.proposal != null).length };
  });
  if (options.json) console.log(JSON.stringify({ rows, consecutive, days }));
  else {
    for (const row of rows) console.log(`${row.date} · ${row.range} · ${row.measured}/${row.total} · keep ${row.keep}/review ${row.review}/failing ${row.failing} · 제안 ${row.proposals}`);
    console.log(`연속 산출: ${consecutive}일 (기준 ${days})`);
  }
  return 0;
}

if (import.meta.main) {
  const step = process.argv[2];
  try {
    if (step === 'status') {
      const args = process.argv.slice(3);
      const daysAt = args.indexOf('--days');
      const days = daysAt < 0 ? 3 : Number(args[daysAt + 1]);
      if (!Number.isSafeInteger(days) || days < 1) throw new Error('--days needs a positive integer');
      process.exitCode = status(effectiveInstanceRoot(), { json: args.includes('--json'), days });
    } else {
      const ctx = context();
      process.exitCode = step === 'pick' ? pick(ctx) : step === 'measure' ? measure(ctx) : step === 'audit' ? measure(ctx, true)
        : step === 'record' ? (ctx.graphId === 'nightly-audit' || Object.hasOwn(ctx.outputs, 'audit') ? recordNightlyAudit(ctx) : record(ctx)) : emit({ outcome: 'error', summary: `unknown step: ${step}` });
    }
  } catch (error) {
    process.exitCode = emit({ outcome: 'error', summary: error instanceof Error ? error.message : String(error) });
  }
}
