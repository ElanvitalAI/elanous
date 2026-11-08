import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { debugLogDir } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, summarizeChecklist } from '../release-loop/checklist.js';
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

export function renderReleaseRunStatus(version: string, runs: readonly Row[], progress: readonly Row[], checklist: { green: number; yellow: number; red: number; done: number }, now = Date.now()): string {
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
  const outputs = nodes.map((n) => json(String(n.output ?? ''))).filter((o): o is Row => o !== null);
  const failure = outputs.find((o) => o.failureClassification || o.terminalFailureClassification || o.classification || o.failureKind);
  const classification = failure?.failureClassification ?? failure?.terminalFailureClassification ?? failure?.classification ?? failure?.failureKind ?? '없음';
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
    `gate ${progressLine}${recheckLine} · 실패 분류 ${String(classification)} · 다음 HITL ${String(nextHitl)}`,
    `체크리스트 🟢${checklist.green} 🟡${checklist.yellow} 🔴${checklist.red} ✅${checklist.done}`,
  ].join('\n');
}

export interface ReleaseRunStatusDependencies {
  ledgerRoot?: () => string;
  debugDir?: () => string;
  checklist?: (version: string) => { green: number; yellow: number; red: number; done: number };
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
      const progressView = progress.map((row) => ({ ...row, scopedToRun: true, event: row.event ?? 'gate-progress' }));
      const output = renderReleaseRunStatus(version, runs, [...progressView, ...debugRows], summary);
      console.log(output);
    });
}
