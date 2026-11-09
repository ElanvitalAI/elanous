import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { debugLogDir } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, summarizeChecklist } from '../release-loop/checklist.js';
import { readSweepCertificate } from '../../scripts/release-loop/sweep-cert.js';
import { CliUserError } from './cli-user-error.js';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const json = (text: string): Row | null => { try { return object(JSON.parse(text)); } catch { return null; } };
function selectReleaseRun(version: string, runs: readonly Row[]): Row | undefined {
  const matchingRuns = runs.filter((r) => object(r.input).version === version);
  const fullRuns = matchingRuns.filter((r) => Array.isArray(r.nodes) && r.nodes.some((n) => object(n).nodeId === 'version-release'));
  return [...fullRuns].sort((a, b) => {
    const aStarted = Date.parse(String(a.startedAt ?? ''));
    const bStarted = Date.parse(String(b.startedAt ?? ''));
    return (Number.isFinite(bStarted) ? bStarted : -Infinity) - (Number.isFinite(aStarted) ? aStarted : -Infinity);
  })[0];
}

function countValue(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function measuredCount(outputs: readonly Row[], ...keys: string[]): number | undefined {
  const values = outputs.flatMap((output) => keys.map((key) => output[key]));
  const lists = values.filter(Array.isArray) as unknown[][];
  if (lists.length) return new Set(lists.flat().filter((id): id is string => typeof id === 'string')).size;
  return values.map(countValue).filter((value): value is number => value !== undefined).at(-1);
}

function etaSummary(run: Row | undefined, outputs: readonly Row[], now: number): string {
  const source = [run, ...outputs].filter((row): row is Row => !!row);
  const minutes = source.map((row) => row.etaMinutes).find((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (typeof minutes === 'number') return `ETA ${Math.ceil(minutes)}m`;
  const etaAt = source.map((row) => row.etaAt ?? row.estimatedCompletionAt).find((value) => typeof value === 'string');
  const timestamp = typeof etaAt === 'string' ? Date.parse(etaAt) : NaN;
  return Number.isFinite(timestamp) ? `ETA ${Math.max(0, Math.ceil((timestamp - now) / 60_000))}m` : 'ETA 미측정';
}

export function renderReleaseRunStatus(version: string, runs: readonly Row[], progress: readonly Row[], checklist: { green: number; yellow: number; red: number; done: number; certificateMeasuredAt?: number | null }, now = Date.now()): string {
  const run = selectReleaseRun(version, runs);
  const nodes = Array.isArray(run?.nodes) ? run.nodes.map(object) : [];
  const active = nodes.find((n) => !n.endedAt && n.startedAt) ?? nodes.find((n) => !n.endedAt);
  const nodeStarts = nodes.map((n) => Date.parse(String(n.startedAt ?? ''))).filter(Number.isFinite);
  const nodeEnds = nodes.map((n) => Date.parse(String(n.endedAt ?? ''))).filter(Number.isFinite);
  const runStart = Date.parse(String(run?.startedAt ?? ''));
  const runFinish = Date.parse(String(run?.finishedAt ?? ''));
  const elapsedStart = nodeStarts.length ? Math.min(Number.isFinite(runStart) ? runStart : Infinity, ...nodeStarts) : runStart;
  const terminal = run?.status === 'done' || run?.status === 'failed';
  const elapsedEnd = terminal ? Math.max(Number.isFinite(runFinish) ? runFinish : -Infinity, ...nodeEnds) : now;
  const elapsed = Number.isFinite(elapsedStart) ? `${Math.max(0, Math.floor(((Number.isFinite(elapsedEnd) ? elapsedEnd : now) - elapsedStart) / 60_000))}m` : '?';
  const scopedProgress = run?.runId ? progress.filter((e) => e.scopedToRun === true ||
    (e.runId ?? object(e.data).runId) === run.runId && (!e.runId || e.runId === run.runId) && (!object(e.data).runId || object(e.data).runId === run.runId)) : [];
  const gateEvent = scopedProgress.filter((e) => Number.isFinite(Number(e.completed)) && Number.isFinite(Number(e.total))).at(-1);
  const recheckEvent = scopedProgress.filter((e) => e.event === 'isolated-recheck-progress').at(-1);
  const recheckData = object(recheckEvent?.data);
  const recheckDone = Number(recheckData.index);
  const recheckTotal = Number(recheckData.total);
  const nodeOutputs = nodes.map((node) => ({ nodeId: node.nodeId, output: json(String(node.output ?? '')) }))
    .filter((entry): entry is { nodeId: unknown; output: Row } => entry.output !== null);
  const outputs = nodeOutputs.map((entry) => entry.output);
  const failure = outputs.find((o) => o.failureClassification || o.terminalFailureClassification || o.classification || o.failureKind);
  const classification = failure?.failureClassification ?? failure?.terminalFailureClassification ?? failure?.classification ?? failure?.failureKind ?? '미측정';
  // ID lists are identity-level evidence and union across nodes; use the latest scalar count when no list was recorded.
  const introduced = measuredCount(outputs, 'introduced');
  const preexisting = measuredCount(outputs, 'preexisting');
  const undetermined = measuredCount(outputs, 'undetermined', 'unmeasured');
  const receiptAudit = nodeOutputs.filter((entry) => entry.nodeId === 'receipt-audit').map((entry) => object(entry.output.measurement)).filter((measurement) =>
    Number.isSafeInteger(measurement.totalFiles) && Number.isSafeInteger(measurement.coveredFiles)).at(-1);
  const totalFiles = receiptAudit ? Number(receiptAudit.totalFiles) : NaN;
  const coveredFiles = receiptAudit ? Number(receiptAudit.coveredFiles) : NaN;
  const uncoveredFiles = receiptAudit && Number.isSafeInteger(receiptAudit.unmeasuredFiles)
    ? Number(receiptAudit.unmeasuredFiles) : totalFiles - coveredFiles;
  const residualExecutions = run ? nodes.filter((node) => node.nodeId === 'residual-run' && !node.endedAt).length : null;
  const certificateMeasuredAt = checklist.certificateMeasuredAt ?? null;
  const certificateAge = Number.isFinite(certificateMeasuredAt) && certificateMeasuredAt! <= now
    ? `${Math.floor((now - certificateMeasuredAt!) / 60_000)}m` : '?';
  const explicitHitl = outputs.map((o) => o.nextHitl ?? o.nextHITL).find((value) => typeof value === 'string');
  const humanRequired = outputs.map((o) => o.humanRequired).find(Array.isArray) as unknown[] | undefined;
  const firstHumanFile = humanRequired?.map(object).map((entry) => entry.file).find((file) => typeof file === 'string');
  const hitlSummary = outputs.map((output) => String(output.summary ?? '')).map((summary) => /HITL needed for\s+([^\n]+)/i.exec(summary)?.[1]?.trim().replace(/[.;]+$/u, '')).find(Boolean);
  const nextHitl = explicitHitl ?? (humanRequired?.length ? `${humanRequired.length}건 · ${String(firstHumanFile ?? '상세 미상')}` : undefined)
    ?? hitlSummary ?? nodes.find((n) => /approve|hitl/i.test(String(n.nodeId)) && !n.endedAt)?.nodeId ?? '없음';
  const progressLine = gateEvent ? `shard ${gateEvent.completed}/${gateEvent.total}` : 'shard ?/?';
  const recheckLine = recheckEvent && Number.isFinite(recheckDone) && Number.isFinite(recheckTotal) ? ` · recheck ${recheckDone}/${recheckTotal}` : ' · recheck ?/?';
  return [
    `${version} · run ${run?.runId ?? '없음'} · ${String(run?.status ?? '미시작')} · node ${String(active?.nodeId ?? nodes.at(-1)?.nodeId ?? '없음')} · 경과 ${elapsed}`,
    `gate ${progressLine}${recheckLine} · 미덮임 ${Number.isFinite(uncoveredFiles) && Number.isFinite(totalFiles) ? `${uncoveredFiles}/${totalFiles}` : '?/?'} · residual 실행 ${residualExecutions ?? '?'} · sweep 증명서 나이 ${certificateAge} · ${etaSummary(run, outputs, now)}`,
    `실패 introduced ${introduced ?? '?'} / preexisting ${preexisting ?? '?'} / 미판정 ${undetermined ?? '?'} · 분류 ${String(classification)} · 다음 HITL ${String(nextHitl)}`,
    `체크리스트 🟢${checklist.green} 🟡${checklist.yellow} 🔴${checklist.red} ✅${checklist.done}`,
  ].join('\n');
}

export interface ReleaseRunStatusDependencies {
  ledgerRoot?: () => string;
  debugDir?: () => string;
  checklist?: (version: string) => { green: number; yellow: number; red: number; done: number };
  now?: () => number;
  sweepCertificateMeasuredAt?: (version: string, ledgerRoot: string) => number | null;
}

export function registerReleaseRunStatusCommand(release: Command, dependencies: ReleaseRunStatusDependencies = {}): void {
  release.command('status <version>').description('실행 원장·게이트 진행·체크리스트 한 화면 조회')
    .action((version: string) => {
      if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) throw new CliUserError(`릴리스 버전 형식이 아니다: ${version}`);
      const root = (dependencies.ledgerRoot ?? releaseLedgerRoot)();
      const runDir = join(root, 'graph-runs', 'release-loop');
      const runs = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith('.json') && !f.includes('.decision')).flatMap((f) => { const row = json(readFileSync(join(runDir, f), 'utf8')); return row ? [row] : []; }) : [];
      const run = selectReleaseRun(version, runs);
      const runId = run?.runId;
      const progressPath = runId ? join(runDir, `${runId}.json.contexts`, 'gate-progress.jsonl') : '';
      const progress = progressPath && existsSync(progressPath) ? readFileSync(progressPath, 'utf8').split(/\r?\n/u).flatMap((line) => { const row = json(line); return row ? [row] : []; }) : [];
      // Include the current process log when gate progress was emitted through debug.log rather than the run context.
      const logsDir = (dependencies.debugDir ?? debugLogDir)();
      const debugRows = runId && existsSync(logsDir) ? readdirSync(logsDir).filter((f) => /^debug-\d{14}\.log$/u.test(f)).flatMap((f) => readFileSync(join(logsDir, f), 'utf8').split(/\r?\n/u).flatMap((line) => {
        const row = json(line);
        const data = object(row?.data);
        const rowRunId = row?.runId ?? data.runId;
        return row?.category === 'release-loop.gate' && row?.event === 'isolated-recheck-progress'
          && rowRunId === runId ? [row] : [];
      })) : [];
      const summary = dependencies.checklist?.(version) ?? summarizeChecklist(listChecklist(version));
      const now = dependencies.now?.() ?? Date.now();
      const certificateMeasuredAt = dependencies.sweepCertificateMeasuredAt
        ? dependencies.sweepCertificateMeasuredAt(version, root)
        : readSweepCertificate(join(root, 'release', version, 'gate-logs', 'cut', 'receipts'))?.measuredAt ?? null;
      const progressView = progress.map((row) => ({ ...row, scopedToRun: true, event: row.event ?? 'gate-progress' }));
      const output = renderReleaseRunStatus(version, runs, [...progressView, ...debugRows], { ...summary, certificateMeasuredAt }, now);
      console.log(output);
    });
}
