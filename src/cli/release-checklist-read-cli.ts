import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { CHECKLIST_EVIDENCE_RUN_EVENT, EVIDENCE_COMMIT_ABBREV, checklistEvidenceChain, checklistEvidenceCommand, checklistEvidenceRunLine, devVersion, isTestRunCommand, listChecklist, ownerMatches, parseOwner, parityGap, setItemIfSnapshot, summarizeChecklist, type ChecklistEvidenceStage, type ChecklistItem } from '../release-loop/checklist.js';
import { collectStaleMergedChecklistProposals, type StaleMergedChecklistScan } from '../release-loop/merged-pr-checklist.js';
import { userConfigPath } from '../user-config.js';
import { hqLocalHostName } from '../hq/hq.js';
import { hostNamesFor } from '../hq/promote.js';
import { readHostLedgerStrict } from '../nexus/host-registry/store.js';
import { CliUserError } from './cli-user-error.js';
import { readRemoteChecklist, requestChecklistClaim } from './release-checklist-remote.js';
import { writeStdoutJson } from './stdout-json.js';
import { mayWriteReleaseChecklist } from './release-checklist-write.js';
import { dispatchEvidenceRun, evidenceRunPlan, evidenceTestHosts, parseEvidenceRunCommand, registryHostName, runInIsolatedUniverse, type EvidenceDispatchOutcome, type EvidencePackageFs, type EvidenceRunReceipt, type EvidenceRunRequest, type RegistryHostEntry } from '../release-loop/checklist-evidence-run.js';
import { resolveGateRemoteSettings, type GateRemoteSettings } from '../self-implement/gate-remote.js';
import { getUserConfig } from '../user-config/reader.js';

export { evidenceRunEnv, parseEvidenceRunCommand, runInIsolatedUniverse, type EvidenceSpawn } from '../release-loop/checklist-evidence-run.js';

const SEMVER = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
export function isReleaseVersion(version: string): boolean { return SEMVER.test(version); }

export function checklistCodenames(): Record<string, string> {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { release?: { codenames?: Record<string, string> } };
  return raw.release?.codenames ?? {};
}

export function checklistVersion(input: string | undefined, codenames: Record<string, string>): string {
  const v = input ?? devVersion().replace(/-dev\.\d+$/, '');
  const resolved = isReleaseVersion(v) ? v : Object.entries(codenames).find(([, name]) => name === v)?.[0] ?? v;
  if (!isReleaseVersion(resolved)) throw new CliUserError(`체크리스트 판 또는 별칭이 아니다: ${v}`);
  return resolved;
}

export function readChecklistContext(cmd: Command): { version: string; codenames: Record<string, string>; json?: boolean } {
  const opts = { ...(cmd.parent?.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.opts() as { version?: string; json?: boolean }) };
  const codenames = checklistCodenames();
  return { version: checklistVersion(opts.version, codenames), codenames, json: opts.json };
}

export async function checklistOutput(v: string, codenames: Record<string, string>, mode: 'list' | 'status', json?: boolean, owner?: string): Promise<void> {
  if (owner !== undefined) parseOwner(owner);
  const snapshot = await readRemoteChecklist(v) ?? listChecklist(v);
  const data = owner === undefined ? snapshot : { ...snapshot, items: snapshot.items.filter((item) => ownerMatches(item.owner, owner)) };
  const summary = summarizeChecklist(data);
  const parity = data.items.flatMap((item) => {
    const why = item.kind === 'screen' ? parityGap(item.evidence) : null;
    return why ? [{ id: item.id, why }] : [];
  });
  const result = { ...data, codename: codenames[v] ?? '', ...summary, parity };
  for (const { id, why } of parity) debug.log('release.checklist', 'parity-warning', { version: v, id, why });
  if (json) { await writeStdoutJson(`${JSON.stringify(result)}\n`); return; }
  console.log(`⚠ 짝 경고 ${parity.length}: ${parity.map(({ id }) => id).join(', ') || '없음'}`);
  console.log(`${v}${result.codename ? ` (${result.codename})` : ''} · 공개 ${data.released || '없음'} · 개발 ${data.dev}`);
  if (mode === 'list') {
    for (const item of data.items) console.log(`${({ green: '🟢', yellow: '🟡', red: '🔴', done: '✅' } as const)[item.status]} ${item.id} ${item.title}${item.owner ? ` · ${item.owner}` : ''}${item.ceoMinutes !== undefined ? ` · 대표 손 ${item.ceoMinutes}분${item.ceoDate ? ` (${item.ceoDate})` : ''}` : ''}`);
  } else {
    console.log(`🟢 ${summary.green} · 🟡 ${summary.yellow} · 🔴 ${summary.red} · ✅ ${summary.done}`);
    console.log(`🔴 칸: ${summary.blocked.join(', ') || '없음'}`);
    console.log(`담당별: ${Object.entries(summary.byOwner).map(([owner, count]) => `${owner} ${count}`).join(' · ') || '없음'}`);
  }
}

/** `version` scopes the item lookup; the default collector only needs that resolved item. */
export type ChecklistEvidenceReader = (item: ReturnType<typeof listChecklist>['items'][number], version: string) => readonly ChecklistEvidenceStage[];

const defaultChecklistEvidenceReader: ChecklistEvidenceReader = (item) => collectChecklistEvidenceStages(item);

export type ChecklistEvidenceCommandRunner = (command: string, args: string[], timeout?: number) => { status: number | null; stdout: string; stderr: string; error?: string };
const evidenceCommand: ChecklistEvidenceCommandRunner = (command, args, timeout = 20_000) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
}

function evidenceJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try { return JSON.parse(line.slice(start)) as Record<string, unknown>; } catch { /* try another complete JSON line */ }
  }
  return null;
}

// CHECKLIST-E4-RUN-RECEIPT(2026-11-20 실측 node-b): `eln logs --all --include-test --json` 은 시험 스토어 일부를 못 열면 종료 2 로 끝나지만 stdout 행은 쓸 수 있다.
// 출처: src/cli/logs-cli.ts runLogsCli 비-follow 조회 `return unreadableInstances.length > 0 ? 2 : 0` 와 그 --json 머리 행 _meta.type 'log-query-unreadable-instances'.
// 2 는 같은 함수의 커서 오류에도 쓰이므로 그 _meta 행이 함께 있을 때만 «부분 조회» 로 본다 — 그 밖의 비-0 종료는 조회 실패 그대로.
export const ELN_LOGS_PARTIAL_READ_EXIT = 2;
const ELN_LOGS_UNREADABLE_META_TYPE = 'log-query-unreadable-instances';

/** Usable `eln logs --json` rows: rc 0, or the documented partial rc with its unreadable-instances meta line; null = query failed. */
export function elnLogsJsonRows(logs: { status: number | null; stdout: string }): { rows: Record<string, unknown>[]; unreadable: string[] | null } | null {
  if (logs.status !== 0 && logs.status !== ELN_LOGS_PARTIAL_READ_EXIT) return null;
  const rows = logs.stdout.split(/\r?\n/u).flatMap((line) => { try { const row = JSON.parse(line) as unknown; return row && typeof row === 'object' ? [row as Record<string, unknown>] : []; } catch { return []; } });
  if (logs.status === 0) return { rows, unreadable: null };
  const meta = rows.map((row) => row._meta as { type?: unknown; unreadableInstances?: unknown } | undefined).find((m) => m && typeof m === 'object' && m.type === ELN_LOGS_UNREADABLE_META_TYPE);
  if (!meta) return null;
  const names = Array.isArray(meta.unreadableInstances) ? meta.unreadableInstances.filter((name): name is string => typeof name === 'string') : [];
  return { rows, unreadable: names };
}

// E4 reads only the exact event near the evidence timestamp; absent timestamps fail closed.
const E4_LOG_WINDOW_MS = 30 * 60_000;
// REL addendum(OP #113009 · JUD #113005): 실행 호스트의 단일 prod 인스턴스를 먼저 읽고, 거기서 결속 행을 못 찾을 때만 --all --include-test 연합으로 넓힌다.
// 출처: src/cli/logs-cli.ts prodTarget() 의 name 'prod'(~/.elanous/logs/logs.db) · `--instance <name>` 옵션 — evidence run 영수 사건은 그 인스턴스에 착지한다.
const ELN_LOGS_PROD_INSTANCE = 'prod';
const EVIDENCE_LOG_SCOPES: readonly (readonly string[])[] = [['--instance', ELN_LOGS_PROD_INSTANCE], ['--all', '--include-test']];

type EvidenceLogRead = { logs: ReturnType<ChecklistEvidenceCommandRunner>; read: ReturnType<typeof elnLogsJsonRows>; scope: string };
/** Reads one event window from the prod instance first, widening to the --all/--include-test federation only when prod has no bound row. */
function readEvidenceLogs(run: ChecklistEvidenceCommandRunner, remote: string | null, window: { event: string; since: string; until: string }, bound: (row: Record<string, unknown>) => boolean): EvidenceLogRead {
  let last: EvidenceLogRead | null = null;
  for (const scopeArgs of EVIDENCE_LOG_SCOPES) {
    const logArgs = ['logs', '--event', window.event, '--since', window.since, '--until', window.until, ...scopeArgs, '--limit', '1000', '--json'];
    const logs = remote
      ? run('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${REMOTE_SSH_CONNECT_TIMEOUT_SECONDS}`, remote, `bash -lc ${shellQuote(['eln', ...logArgs].map(shellQuote).join(' '))}`], 30_000)
      : run('eln', logArgs, 30_000);
    last = { logs, read: elnLogsJsonRows(logs), scope: scopeArgs.join(' ') };
    if (last.read?.rows.some(bound)) return last;
  }
  return last!;
}

const EVIDENCE_ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu;

function evidenceTimestampNearIdentity(evidence: string, identity: string): number | null {
  const identityAt = evidence.indexOf(identity);
  if (identityAt < 0) return null;
  const lineStart = evidence.lastIndexOf('\n', identityAt) + 1;
  const lineEnd = evidence.indexOf('\n', identityAt);
  const identityLine = evidence.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  let nearest: { distance: number; timestamp: number } | null = null;
  for (const match of identityLine.matchAll(EVIDENCE_ISO_TIMESTAMP)) {
    const timestamp = Date.parse(match[0]);
    if (!Number.isFinite(timestamp)) continue;
    const distance = Math.abs((match.index ?? 0) - (identityAt - lineStart));
    if (!nearest || distance < nearest.distance) nearest = { distance, timestamp };
  }
  return nearest?.timestamp ?? null;
}

// CHECKLIST-E4-RUN-RECEIPT(OP #112072): the executing host's logs.db is canonical — a line naming another host is read there over ssh.
// ConnectTimeout 출처: src/hq/lease.ts · src/hq/seats.ts 의 같은 BatchMode ssh 호출(8초).
const REMOTE_SSH_CONNECT_TIMEOUT_SECONDS = 8;
const EVIDENCE_HOST_PATTERN = /(?:^|[\s·])host(?:\s*[:=]\s*|\s+)([A-Za-z0-9][A-Za-z0-9._-]*)/u;
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function sameChecklistHost(a: string, b: string): boolean {
  return a === b || hostNamesFor(a).includes(b) || hostNamesFor(b).includes(a);
}

/** OP #112499: the nexus host registry (#39165) is the only trust source for remote E4 reads; an unreadable ledger trusts nobody. */
export function nexusRegisteredHost(host: string, readLedger: typeof readHostLedgerStrict = readHostLedgerStrict): boolean {
  try {
    const hosts = readLedger()?.hosts;
    if (!hosts) return false;
    // 등록 이름(키)·그 기록의 host·등록 별칭(aliases) 어느 것이든 — 별칭은 원장 자신의 자료다(OP #112782).
    return hostNamesFor(host).some((name) => Object.prototype.hasOwnProperty.call(hosts, name))
      || Object.values(hosts).some((record) => record.host === host || (record.aliases ?? []).includes(host));
  } catch { return false; }
}

export interface ChecklistEvidenceHosts { localHost: () => string; isRegisteredHost: (host: string) => boolean }
const defaultEvidenceHosts: ChecklistEvidenceHosts = { localHost: () => hqLocalHostName(), isRegisteredHost: (host) => nexusRegisteredHost(host) };

/** E1's PR parser: the PR numbers a cell's evidence cites (narrowed to merge-sha-bound lines when several), and the sha-bound subset. */
export function checklistEvidencePrRefs(evidence: string): { prRefs: string[]; shaBoundPrRefs: string[] } {
  // OP #105708 파서 수리: E1 PR 인용은 명시적 꼴만 — «PR #N» · «pull/N» · 착지 커밋 «(#N)». 맨 «#N» 토큰(좌석 우편 번호 등)은 PR이 아니다.
  const prRefPatterns = [/\bPR\s*#(\d{1,8})\b/giu, /\bpull\/(\d{1,8})\b/gu, /(?:^|\s)\(#(\d{1,8})\)/gu];
  const explicitPrRefs = [...new Set(prRefPatterns.flatMap((pattern) => [...evidence.matchAll(pattern)].map((match) => match[1]!)))];
  // OP #99234 파서 수리(보존): 명시 PR 인용이 여럿이면 «40자 merge sha 가 같은 줄에 결속된 PR» 로만 좁힌다 — 수리 PR 의 12자 단축 sha 만 있는 줄은 후보가 아니다.
  const prRefLinePatternEarly = (prRef: string) => new RegExp(`(?:\\bPR\\s*#${prRef}\\b|\\bpull\\/${prRef}\\b|(?:^|[^0-9])\\(#${prRef}\\))`, 'iu');
  const shaBoundPrRefs = explicitPrRefs.filter((ref) => evidence.split(/\r?\n/u).some((line) => prRefLinePatternEarly(ref).test(line) && /\b[a-f0-9]{40}\b/u.test(line)));
  const prRefs = explicitPrRefs.length > 1 && shaBoundPrRefs.length >= 1 ? shaBoundPrRefs : explicitPrRefs;
  return { prRefs, shaBoundPrRefs };
}

export function collectChecklistEvidenceStages(item: ReturnType<typeof listChecklist>['items'][number], run: ChecklistEvidenceCommandRunner = evidenceCommand, hosts: ChecklistEvidenceHosts = defaultEvidenceHosts): ChecklistEvidenceStage[] {
  const measuredAt = new Date().toISOString();
  const evidence = item.evidence ?? '';
  const { prRefs, shaBoundPrRefs } = checklistEvidencePrRefs(evidence);
  // CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES(2026-11-20): 40자 merge sha 결속 PR 줄이 여럿이면 칸 완료에 기여한 PR 여럿으로 보고 하나하나 모두 검증한다(하나라도 틀리면 missing).
  const multiPr = prRefs.length > 1 && prRefs.every((ref) => shaBoundPrRefs.includes(ref));
  const pr = prRefs.length === 1 ? prRefs[0] : undefined;
  // 후속 수리(2026-11-20, SIM-WORLD 사례): 착지 전 «진행: PR #N» 줄이 첫 PR 인용 줄이어도 merge SHA와 결속된 줄을 찾아 판정한다(첫 줄만 보지 않는다).
  const prRefLinePattern = (prRef: string) => new RegExp(`(?:\\bPR\\s*#${prRef}\\b|\\bpull\\/${prRef}\\b|(?:^|[^0-9])\\(#${prRef}\\))`, 'iu');
  const verifyPr = (prRef: string): { state: ChecklistEvidenceStage['state']; reason: string; source: string | null; sha: string | null } => {
    const prLines = evidence.split(/\r?\n/u).filter((line) => prRefLinePattern(prRef).test(line));
    const view = run('eln', ['gh', 'pr', 'view', prRef, '--json', 'state,mergeCommit']);
    const record = view.status === 0 ? evidenceJson(view.stdout) : null;
    if (!record) return { state: 'unmeasurable', reason: `PR #${prRef} 조회 실패${view.error ? `: ${view.error}` : ''}`, source: null, sha: null };
    if (record.state !== 'MERGED') return { state: 'missing', reason: `PR #${prRef} 상태가 MERGED가 아니다`, source: null, sha: null };
    const commit = record.mergeCommit && typeof record.mergeCommit === 'object' ? (record.mergeCommit as { oid?: unknown }).oid : null;
    const sha = typeof commit === 'string' && /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
    if (!sha) return { state: 'unmeasurable', reason: `PR #${prRef} 조회에 유효한 merge SHA가 없다`, source: null, sha: null };
    const source = `eln gh pr view #${prRef} → ${sha}`;
    if (!prLines.some((line) => new RegExp(`\\b${sha}\\b`, 'i').test(line))) return { state: 'missing', reason: `병합 PR #${prRef}와 merge SHA가 같은 근거 줄에서 결속되지 않았다`, source, sha };
    return { state: 'observed', reason: `PR #${prRef} MERGED 및 merge SHA가 근거와 일치한다`, source, sha };
  };
  const e1: ChecklistEvidenceStage = { id: 'E1', state: 'missing', source: 'checklist evidence + eln gh pr view', measuredAt,
    reason: prRefs.length > 1 ? '근거에서 교차할 PR이 하나로 좁혀지지 않는다' : '근거에 병합 PR 번호가 없다' };
  let mergeShas: string[] = [];
  if (pr) {
    const verdict = verifyPr(pr);
    e1.state = verdict.state; e1.reason = verdict.reason;
    if (verdict.source) e1.source = verdict.source;
    if (verdict.sha) mergeShas = [verdict.sha];
  } else if (multiPr) {
    const verdicts = prRefs.map((ref) => verifyPr(ref));
    const failed = verdicts.find((verdict) => verdict.state === 'missing') ?? verdicts.find((verdict) => verdict.state !== 'observed');
    const sources = verdicts.flatMap((verdict) => verdict.source ? [verdict.source] : []);
    if (sources.length) e1.source = sources.join('; ');
    if (failed) { e1.state = failed.state; e1.reason = `다중 병합 PR ${prRefs.map((ref) => `#${ref}`).join('·')} 중 ${failed.reason}`; }
    else { e1.state = 'observed'; e1.reason = `다중 병합 PR ${prRefs.map((ref) => `#${ref}`).join('·')} 모두 MERGED 및 merge SHA가 근거와 일치한다`; }
    // E3 은 모든 PR 의 merge SHA 가 있어야 «모두 조상» 을 검사할 수 있다 — 하나라도 없으면 조상 검사를 하지 않는다.
    if (verdicts.every((verdict) => verdict.sha)) mergeShas = verdicts.map((verdict) => verdict.sha!);
  }

  const e3: ChecklistEvidenceStage = { id: 'E3', state: 'unmeasurable', source: null, measuredAt, reason: mergeShas.length ? '설치본 pin을 조회하지 못했다' : 'E1 merge SHA가 없어 조상 관계를 검사할 수 없다' };
  if (mergeShas.length) {
    const pin = run('eln', ['--version']);
    const pinSha = pin.stdout.match(/\b[a-f0-9]{40}\b/i)?.[0];
    if (!pinSha) e3.reason = `eln --version에서 설치본 SHA를 읽지 못했다${pin.error ? `: ${pin.error}` : ''}`;
    else {
      const repoRoot = run('git', ['rev-parse', '--show-toplevel']);
      const origin = run('git', ['remote', 'get-url', 'origin']);
      const pinObject = run('git', ['cat-file', '-e', `${pinSha}^{commit}`]);
      const repoUrl = origin.stdout.trim().replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '').replace(/\/$/u, '').toLowerCase();
      const expectedRepos = new Set([
        'https://github.com/elanvitalai/elanous',
        'https://github.com/ElanvitalAI/elanous',
      ]);
      if (repoRoot.status !== 0 || !repoRoot.stdout.trim() || origin.status !== 0 || !expectedRepos.has(repoUrl) || pinObject.status !== 0) {
        e3.reason = '현재 git 저장소가 elanous 원본이 아니거나 설치본 pin 객체가 없어 조상 관계를 판정할 수 없다';
      } else {
        // 모든 merge SHA 가 설치본 pin 의 조상이어야 observed — 하나라도 아니면 missing(그 SHA 를 이유에 적는다).
        const ancestries = mergeShas.map((sha) => ({ sha, result: run('git', ['merge-base', '--is-ancestor', sha, pinSha]) }));
        e3.source = `eln --version ${pinSha}; ${ancestries.map(({ sha }) => `git -C ${repoRoot.stdout.trim()} merge-base --is-ancestor ${sha} ${pinSha}`).join('; ')}`;
        const single = mergeShas.length === 1;
        const notDescendant = ancestries.find(({ result }) => result.status === 1);
        const unknown = ancestries.find(({ result }) => result.status !== 0 && result.status !== 1);
        if (notDescendant) { e3.state = 'missing'; e3.reason = single ? '설치본 pin이 merge SHA의 후손이 아니다' : `설치본 pin이 merge SHA ${notDescendant.sha}의 후손이 아니다`; }
        else if (unknown) { e3.reason = `설치본 저장소에서 조상 관계를 검사할 수 없다${single ? '' : ` (${unknown.sha})`}${unknown.result.error ? `: ${unknown.result.error}` : ''}`; }
        else { e3.state = 'observed'; e3.reason = single ? '설치본 pin이 merge SHA의 후손이다' : `설치본 pin이 merge SHA ${mergeShas.length}개 모두의 후손이다`; }
      }
    }
  }

  const identityToken = '(?:run-[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-z0-9][a-z0-9._:-]{2,})';
  const labelledIdentityPattern = new RegExp(`\\b(runId|missionId|taskId)\\s*[:=]?\\s*(${identityToken})\\b`, 'i');
  const bareIdentityPattern = /\b(run-[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i;
  const eventPattern = /(?:event|이벤트)\s*[:=]\s*([A-Za-z0-9_.:-]+)/iu;
  const identityFieldOf = (label: string | undefined): 'runId' | 'missionId' | 'taskId' => label === 'missionid' ? 'missionId' : label === 'taskid' ? 'taskId' : 'runId';
  const labelledIdentity = labelledIdentityPattern.exec(evidence);
  const runId = labelledIdentity?.[2] ?? bareIdentityPattern.exec(evidence)?.[1];
  const identityField = identityFieldOf(labelledIdentity?.[1]?.toLowerCase());
  const event = eventPattern.exec(evidence)?.[1];
  // 정본 = 실행 파서가 쓰는 checklistEvidenceCommand(제목의 «완료 경계 증거 명령:» 중 마지막 — 제목은 append-only 라 정정 줄이 뒤에 붙는다). 제목에 없을 때만 기존 근거 줄 추출(호환 fallback).
  const verificationCommand = checklistEvidenceCommand(item.title)
    ?? /(?:완료 경계 증거 명령|증거 명령|verification command)\s*[:=]\s*([^\r\n]+)/iu.exec(`${item.title}\n${evidence}`)?.[1]?.trim() ?? null;
  const e4: ChecklistEvidenceStage = { id: 'E4', state: 'missing', source: null, measuredAt, verificationCommand, reason: '근거에 runId·missionId·taskId 중 하나와 event·원문 검증 명령이 모두 필요하다' };
  if (runId && event && verificationCommand) {
    // CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES(2026-11-20): 근거 줄마다 (식별자·event·그 줄의 ISO 시각) 짝을 만들고, 어느 짝이든 로그에서 실물이 잡히면 인정한다.
    // 줄에 event 가 없으면 근거 전체의 첫 event 를 쓴다(기존 판정의 상위 집합). 시각 없는 줄은 건너뛴다 — 시각 있는 짝이 하나도 없으면 기존처럼 unmeasurable.
    const pairs: { id: string; field: 'runId' | 'missionId' | 'taskId'; event: string; at: number; host: string | null }[] = [];
    for (const line of evidence.split(/\r?\n/u)) {
      const labelled = labelledIdentityPattern.exec(line);
      const id = labelled?.[2] ?? bareIdentityPattern.exec(line)?.[1];
      if (!id) continue;
      const at = evidenceTimestampNearIdentity(line, id);
      if (at === null) continue;
      const pair = { id, field: identityFieldOf(labelled?.[1]?.toLowerCase()), event: eventPattern.exec(line)?.[1] ?? event, at, host: EVIDENCE_HOST_PATTERN.exec(line)?.[1] ?? null };
      if (!pairs.some((seen) => seen.id === pair.id && seen.field === pair.field && seen.event === pair.event && seen.at === pair.at && seen.host === pair.host)) pairs.push(pair);
    }
    if (!pairs.length) {
      e4.state = 'unmeasurable';
      e4.reason = `근거의 ${identityField}=${runId} 주변에 시간대가 명시된 ISO 시각이 없어 로그 조회 창을 만들 수 없다`;
    } else {
      let failure: string | null = null;
      let truncatedAny = false;
      let partial: string | null = null;
      let firstSource: string | null = null;
      let firstAbsent: string | null = null;
      let local: string | null = null;
      for (const pair of pairs) {
        const since = new Date(pair.at - E4_LOG_WINDOW_MS).toISOString();
        const until = new Date(pair.at + E4_LOG_WINDOW_MS).toISOString();
        // 근거 줄이 다른 호스트를 지목하면 그 호스트의 logs.db 를 ssh 로 읽는다 — 닿지 않으면 unmeasurable(관측 아님).
        const remote = pair.host !== null && !sameChecklistHost(pair.host, local ??= hosts.localHost()) ? pair.host : null;
        // JUD #39237 ⓒ2 · OP #112499: 원장 텍스트의 host 로 아무 곳에나 ssh 하지 않는다 — 넥서스 호스트 원장(#39165) 등록 호스트만 묻고, 그 밖은 측정 불가(ssh 0).
        if (remote && !hosts.isRegisteredHost(remote)) { failure ??= `근거 줄의 host ${remote} 는 넥서스 호스트 원장 등록 호스트가 아니다 — 원격 로그를 묻지 않는다`; continue; }
        const binding: { elsewhere: string | null } = { elsewhere: null };
        const bound = (row: Record<string, unknown>): boolean => {
          if (row.event !== pair.event || typeof row.data !== 'string') return false;
          try {
            const data = JSON.parse(row.data) as { runId?: unknown; missionId?: unknown; taskId?: unknown; cellId?: unknown };
            if (data[pair.field] !== pair.id) return false;
            // CHECKLIST-E4-RUN-RECEIPT: evidence run 영수증은 기록된 칸 id 에 결속된다 — 남의 칸 runId 인용은 관측이 아니다.
            if (pair.event === CHECKLIST_EVIDENCE_RUN_EVENT && data.cellId !== item.id) { binding.elsewhere = String(data.cellId); return false; }
            return true;
          } catch { return false; }
        };
        const { logs, read, scope } = readEvidenceLogs(run, remote, { event: pair.event, since, until }, bound);
        if (!read) { failure ??= remote ? `원격 호스트 ${remote} 로그 조회 실패(닿지 않음)${logs.error ? `: ${logs.error}` : ''}` : `runId 로그 조회 실패${logs.error ? `: ${logs.error}` : ''}`; continue; }
        const { rows, unreadable } = read;
        const truncated = rows.length >= 1000 || rows.some((row) => row._meta && typeof row._meta === 'object' && (row._meta as { limitReached?: unknown }).limitReached === true);
        binding.elsewhere = null;
        const observed = rows.some(bound);
        const source = `${remote ? `ssh ${remote} ` : ''}eln logs --event ${pair.event} --since ${since} --until ${until} ${scope} --limit 1000 --json (${pair.field}=${pair.id})`;
        firstSource ??= source;
        if (observed) { e4.state = 'observed'; e4.source = source; e4.reason = `같은 ${pair.field}의 ${pair.event} 실물 이벤트를 찾았다${remote ? ` (호스트 ${remote})` : ''}`; break; }
        // 부분 조회(못 읽은 스토어가 있음)에서 못 찾았으면 부재가 아니다 — 그 스토어에 있을 수 있어 측정 불가.
        //   단 같은 식별자가 남의 칸에 결속된 행이 읽혔으면 그 자체가 판정이다(missing).
        if (binding.elsewhere !== null) firstAbsent ??= `${pair.field}=${pair.id} 의 ${pair.event} 는 칸 ${binding.elsewhere} 에 결속돼 있다 — 칸 ${item.id} 근거가 아니다`;
        else if (unreadable) partial ??= `${remote ? `원격 호스트 ${remote} ` : ''}로그 부분 조회 — 못 읽은 스토어 ${unreadable.length ? unreadable.join(', ') : '(이름 미상)'} 때문에 ${pair.field}=${pair.id} 의 ${pair.event} 부재를 판정할 수 없다`;
        else if (truncated) truncatedAny = true;
        else firstAbsent ??= `같은 ${pair.field}의 ${pair.event} 이벤트가 없다`;
      }
      if (e4.state !== 'observed') {
        e4.source = firstSource;
        if (failure) { e4.state = 'unmeasurable'; e4.reason = failure; }
        else if (truncatedAny) { e4.state = 'unmeasurable'; e4.reason = '로그 결과가 잘려 사건 부재를 판정할 수 없다'; }
        else if (partial) { e4.state = 'unmeasurable'; e4.reason = partial; }
        else { e4.reason = firstAbsent ?? e4.reason; }
      }
    }
  }

  // CHECKLIST-JUDGE-MULTI-PR-AND-E4-LINES(2026-11-20): «완료 경계 실물:» 은 줄 머리뿐 아니라 줄 중간(공백·« · »·« - » 뒤)도 인정한다.
  // 문구는 다음 «완료 경계 <이름>:» 구분(« · 완료 경계 증거:» · « - 완료 경계 증거 명령:» 등) 또는 줄 끝까지 — «완료 경계 실물:» 처럼 인용부호에 붙은 언급은 표지가 아니다. 근거와는 정확 부분 문자열 비교.
  const acceptance = /(?:^|[\s·])(?:[-*]\s*)?완료 경계 실물\s*:\s*(.+?)(?=\s+[-*·]?\s*완료 경계 [^\s:]+(?: [^\s:]+)?\s*:|\s*$)/mu.exec(item.title)?.[1]?.trim();
  const e5Observed = Boolean(acceptance && evidence.includes(acceptance));
  const e5: ChecklistEvidenceStage = { id: 'E5', state: e5Observed ? 'observed' : 'missing', source: 'checklist title/evidence exact acceptance-text comparison', measuredAt,
    reason: e5Observed ? '완료 경계 실물 문구가 기록된 근거와 일치한다' : '완료 경계 실물 문구와 일치하는 근거가 없다' };
  return [
    e1, e3, e4, e5,
  ];
}

// ── CHECKLIST-E4-RUN-RECEIPT — `release checklist evidence run <칸>` ─────────────────────────────
// 원장(근거 한 줄)은 HQ 임대 보유 호스트에서만 쓴다 — 다른 호스트는 임대 거부(본부에서 돌려라).
// HQ 가 좌석 호스트(시험 거부)면 시험은 넥서스 호스트 원장의 등록 시험 호스트로 ssh 로 보낸다(OP #112782):
// HQ 와 같은 커밋 · 셸 없는 argv · 허용 env · 격리 우주. checklist.evidence.run 은 그 시험 호스트의 logs.db 에 남고,
// HQ 는 rc·출력 꼬리·그 사건을 되읽어 rc 0 이고 사건이 보일 때만 근거 한 줄(host = 등록 이름)을 HQ 원장에 덧붙인다.
const SEAT_HOST = 'mshq';
const RUNNING_TREE_ROOT = resolve(import.meta.dir, '..', '..');
/** HQ-side observation of a dispatch (the receipt event itself lives on the test host). */
export const CHECKLIST_EVIDENCE_DISPATCH_EVENT = 'checklist.evidence.dispatch';

export interface ChecklistEvidenceRunResult {
  runId: string; cellId: string; version: string; command: string; rc: number; durationMs: number; host: string; layer: 'test'; at: string; evidenceLine: string | null;
  /** Repo-relative workspace package directory the test ran from (absent = repo root). */
  cwd?: string;
  /** Set when the HQ host dispatched the test: the registry test host it ran on, the HQ commit, the output tail and whether the receipt event was read back. */
  dispatch?: { executedOn: string; ledgerHost: string; commit: string; outputTail: string; eventObserved: boolean; skipped: { host: string; reason: string }[] };
}
export interface ChecklistEvidenceRunDeps {
  /** The HQ lease gate for ledger writes; false = this host is not the lease holder. */
  hqWriteAllowed: () => boolean;
  readItem: (version: string, id: string) => ChecklistItem | undefined;
  localHost: () => string;
  /** Executes the allow-listed argv (no shell) in an isolated test universe; returns the exit code (null/signal → non-zero by the caller). */
  execute: (argv: readonly string[], cwd: string) => { status: number | null; error?: string };
  log: (data: Record<string, unknown>) => void;
  appendEvidence: (version: string, item: ChecklistItem, line: string) => void;
  now: () => Date;
  runId: () => string;
  cwd: string;
  /** Nexus host registry entries in registry order ([] when the registry is missing or unreadable). */
  registryHosts: () => readonly RegistryHostEntry[];
  /** The HQ tree's HEAD commit (40-hex) or null. */
  headSha: () => string | null;
  /** Runs the request on a test host (gate-remote runOnRemote) — unreachable/busy/setup failure → try the next host. */
  dispatch: (request: EvidenceRunRequest) => EvidenceDispatchOutcome;
  /** HQ log of the dispatch (not the E4 receipt event). */
  logDispatch: (data: Record<string, unknown>) => void;
  /** Reads the receipt event back from the test host's logs.db (same ssh read E4 uses). */
  remoteEventObserved: (host: string, receipt: EvidenceRunReceipt) => boolean;
  /** Filesystem view for the package-directory decision (default: node fs). */
  packageFs?: EvidencePackageFs;
}

/** Non-HQ invocation: the ledger lives on the HQ lease holder. */
export class EvidenceRunLeaseRefused extends CliUserError {}

export const remoteEvidenceEventObserved = (host: string, receipt: EvidenceRunReceipt, run: ChecklistEvidenceCommandRunner = evidenceCommand): boolean => {
  const at = Date.parse(receipt.at);
  if (!Number.isFinite(at)) return false;
  const bound = (row: Record<string, unknown>): boolean => {
    if (row.event !== CHECKLIST_EVIDENCE_RUN_EVENT || typeof row.data !== 'string') return false;
    try {
      const data = JSON.parse(row.data) as { runId?: unknown; cellId?: unknown };
      return data.runId === receipt.runId && data.cellId === receipt.cellId;
    } catch { return false; }
  };
  // prod 인스턴스 먼저 · 못 찾으면 연합. 부분 조회(못 읽은 시험 스토어 · 종료 2 + _meta)도 행은 쓴다 — 결속(event·runId·cellId) 일치 행이 있어야 관측.
  const { read } = readEvidenceLogs(run, host, { event: CHECKLIST_EVIDENCE_RUN_EVENT, since: new Date(at - E4_LOG_WINDOW_MS).toISOString(), until: new Date(at + E4_LOG_WINDOW_MS).toISOString() }, bound);
  return read?.rows.some(bound) ?? false;
};

function readRegistryHosts(): readonly RegistryHostEntry[] {
  try {
    return Object.entries(readHostLedgerStrict()?.hosts ?? {}).map(([key, record]) => ({ key, host: record.host, ...(record.aliases ? { aliases: record.aliases } : {}) }));
  } catch { return []; }
}

function gitHeadSha(cwd: string): string | null {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, encoding: 'utf8' });
  const sha = head.status === 0 ? head.stdout.trim() : '';
  return /^[a-f0-9]{40}$/u.test(sha) ? sha : null;
}

export function defaultChecklistEvidenceRunDeps(by: string, hqWriteAllowed: () => boolean): ChecklistEvidenceRunDeps {
  return {
    hqWriteAllowed,
    readItem: (version, id) => listChecklist(version).items.find((row) => row.id === id),
    localHost: () => hqLocalHostName(),
    execute: (argv, cwd) => runInIsolatedUniverse(argv, cwd),
    log: (data) => debug.log('release.checklist', CHECKLIST_EVIDENCE_RUN_EVENT, data),
    appendEvidence: (version, item, line) => {
      setItemIfSnapshot(version, item.id, { evidence: item.evidence ? `${item.evidence}\n${line}` : line }, by,
        { title: item.title, status: item.status, evidence: item.evidence });
    },
    now: () => new Date(),
    runId: () => randomUUID(),
    cwd: RUNNING_TREE_ROOT,
    registryHosts: readRegistryHosts,
    headSha: () => gitHeadSha(RUNNING_TREE_ROOT),
    dispatch: (request) => {
      let settings: GateRemoteSettings;
      try { settings = resolveGateRemoteSettings(getUserConfig().gateRemote); } catch { settings = resolveGateRemoteSettings(undefined); }
      return dispatchEvidenceRun(request, RUNNING_TREE_ROOT, { settings });
    },
    logDispatch: (data) => debug.log('release.checklist', CHECKLIST_EVIDENCE_DISPATCH_EVENT, data),
    remoteEventObserved: (host, receipt) => remoteEvidenceEventObserved(host, receipt),
  };
}

export function runChecklistEvidence(version: string, id: string, deps: ChecklistEvidenceRunDeps): ChecklistEvidenceRunResult {
  if (!deps.hqWriteAllowed())
    throw new EvidenceRunLeaseRefused('evidence run 은 본부(HQ 임대 보유) 호스트에서 실행한다 — 이 호스트는 원장에 쓸 수 없다 · 실행·기록·근거 0',
      '본부 호스트에서 다시 실행한다 — 시험은 본부가 넥서스 호스트 원장의 등록 시험 호스트로 보낸다');
  const item = deps.readItem(version, id);
  if (!item) throw new CliUserError(`없는 칸: ${id}`);
  const command = checklistEvidenceCommand(item.title);
  if (!command) throw new CliUserError(`칸 ${id} 제목에 «완료 경계 증거 명령: <명령>» 이 없다 — 실행·기록·근거 0`, 'release checklist list --json 으로 제목을 확인한다');
  const parsed = parseEvidenceRunCommand(command);
  if ('refused' in parsed) throw new CliUserError(`칸 ${id} 증거 명령을 실행하지 않는다 — ${parsed.refused}: ${command}`, '제목의 «완료 경계 증거 명령: bun test <저장소 안 상대 경로…>» 로 고친다');
  // 한 워크스페이스 패키지 아래의 시험은 그 패키지 디렉터리에서 돈다(구조 판정: 가장 가까운 package.json) — 패키지가 섞이면 거부.
  const plan = evidenceRunPlan(deps.cwd, parsed.argv, deps.packageFs);
  if ('refused' in plan) throw new CliUserError(`칸 ${id} 증거 명령을 실행하지 않는다 — ${plan.refused}: ${command}`, '제목의 증거 명령을 패키지(또는 루트)별 한 명령으로 나눈다');
  const cwd = plan.packageDir ?? undefined;
  const local = deps.localHost();
  const registry = deps.registryHosts();
  if (sameChecklistHost(local, SEAT_HOST) && isTestRunCommand(command)) return dispatchChecklistEvidence({ version, id, item, command, argv: parsed.argv, local, registry, cwd }, deps);
  // 시험을 거부하지 않는 HQ 호스트: 여기서 돈다. host = 등록 이름(별칭 매핑), 미등록이면 자기 이름.
  const host = registryHostName(local, registry) ?? local;
  const runId = deps.runId();
  const started = deps.now();
  const outcome = deps.execute(plan.argv, cwd ? join(deps.cwd, cwd) : deps.cwd);
  const durationMs = deps.now().getTime() - started.getTime();
  const rc = outcome.status ?? 1;
  const at = started.toISOString();
  deps.log({ runId, cellId: id, version, command, rc, durationMs, layer: 'test', synthetic: true, host, ...(cwd ? { cwd, argv: plan.argv } : {}), ...(outcome.error ? { error: outcome.error } : {}) });
  let evidenceLine: string | null = null;
  if (rc === 0) {
    evidenceLine = checklistEvidenceRunLine({ runId, at, cellId: id, command, host, cwd });
    // 실행 중 다른 손이 근거를 바꿨을 수 있다 — 실행 뒤 다시 읽은 칸에 덧붙인다(스냅샷 일치 쓰기).
    deps.appendEvidence(version, deps.readItem(version, id) ?? item, evidenceLine);
  }
  return { runId, cellId: id, version, command, rc, durationMs, host, layer: 'test', at, evidenceLine, ...(cwd ? { cwd } : {}) };
}

function dispatchChecklistEvidence(input: { version: string; id: string; item: ChecklistItem; command: string; argv: string[]; local: string; registry: readonly RegistryHostEntry[]; cwd: string | undefined }, deps: ChecklistEvidenceRunDeps): ChecklistEvidenceRunResult {
  const { version, id, item, command, argv, local, registry, cwd } = input;
  const ledgerHost = registryHostName(local, registry) ?? local;
  const hosts = evidenceTestHosts(registry, [local, SEAT_HOST]);
  if (!hosts.length)
    throw new CliUserError(`좌석 호스트 ${local} 는 시험을 돌리지 않고, 넥서스 호스트 원장에 등록된 시험 호스트가 없다 — 실행·기록·근거 0: ${command}`, '넥서스 호스트 원장(host-registry.json)에 시험 호스트를 등록한다');
  const commit = deps.headSha();
  if (!commit) throw new CliUserError(`본부 트리의 HEAD 커밋을 읽지 못했다 — 같은 커밋으로 보낼 수 없어 실행·기록·근거 0: ${command}`);
  const runId = deps.runId();
  const started = deps.now();
  const skipped: { host: string; reason: string }[] = [];
  for (const host of hosts) {
    const outcome = deps.dispatch({ runId, cellId: id, version, host, ledgerHost, commit, argv });
    if (outcome.kind === 'unreachable') { skipped.push({ host, reason: outcome.reason }); continue; }
    const receipt = outcome.receipt;
    // 시험 호스트가 같은 커밋에서 같은 패키지 디렉터리를 골랐어야 영수다(cwd 불일치 = 다른 실행).
    const valid = receipt !== null && receipt.runId === runId && receipt.cellId === id && receipt.rc === outcome.rc && receipt.cwd === cwd;
    const eventObserved = valid && deps.remoteEventObserved(host, receipt);
    const at = valid ? receipt.at : started.toISOString();
    const durationMs = valid ? receipt.durationMs : deps.now().getTime() - started.getTime();
    deps.logDispatch({ runId, cellId: id, version, command, rc: outcome.rc, executedOn: host, ledgerHost, commit, layer: 'test', receipt: valid, eventObserved, skipped, ...(cwd ? { cwd } : {}),
      ...(valid ? { selfReportedHost: receipt.selfReportedHost, selfReportedRegistryName: registryHostName(receipt.selfReportedHost, registry) } : {}) });
    let evidenceLine: string | null = null;
    if (outcome.rc === 0 && eventObserved) {
      evidenceLine = checklistEvidenceRunLine({ runId, at, cellId: id, command, host, ledgerHost, commit, cwd });
      deps.appendEvidence(version, deps.readItem(version, id) ?? item, evidenceLine);
    }
    return { runId, cellId: id, version, command, rc: outcome.rc, durationMs, host, layer: 'test', at, evidenceLine, ...(cwd ? { cwd } : {}),
      dispatch: { executedOn: host, ledgerHost, commit, outputTail: outcome.outputTail, eventObserved, skipped } };
  }
  throw new CliUserError(`등록 시험 호스트 어디에도 닿지 않았다 — 실행·기록·근거 0: ${skipped.map((row) => `${row.host}(${row.reason})`).join(' · ')}`, '시험 호스트의 ssh·미러(~/mirror/elanous-agent.git)를 확인한다');
}

/** Register the same read commands on the full and lightweight release roots. */
export type StaleChecklistSweep = (version: string, cwd: string) => StaleMergedChecklistScan;

export function registerChecklistReadCommands(
  checklist: Command,
  evidenceReader: ChecklistEvidenceReader = defaultChecklistEvidenceReader,
  staleSweep: StaleChecklistSweep = collectStaleMergedChecklistProposals,
  evidenceRunDeps?: ChecklistEvidenceRunDeps,
): void {
  const withContext = (cmd: Command) => cmd.option('--version <v>', '판 또는 별칭').option('--json', '결과 JSON').option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  withContext(checklist.command('list').description('모든 칸')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = readChecklistContext(cmd);
    await checklistOutput(version, codenames, 'list', json, opts.owner);
  });
  withContext(checklist.command('status').description('상태 요약 (원격: ELANOUS_NEXUS_URL + 0600 ELANOUS_NEXUS_TOKEN_FILE)')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = readChecklistContext(cmd);
    await checklistOutput(version, codenames, 'status', json, opts.owner);
  });
  withContext(checklist.command('green-triage').description('🟡 칸 세 갈래(결정적 · 무 LLM · 무 네트워크): 병합+영수증=지금 판정 · 병합만=증거 생산 · 병합 PR 없음=공급'))
    .action(async (_opts: unknown, cmd: Command) => {
      const { version, json } = readChecklistContext(cmd);
      const { readGreenTriageSources, renderGreenTriage, triageGreen } = await import('../release-loop/green-triage.js');
      const snapshot = await readRemoteChecklist(version) ?? listChecklist(version);
      const result = triageGreen(version, snapshot.items, readGreenTriageSources());
      debug.log('release.checklist', 'green-triage', { version, ...result.counts });
      if (json) { await writeStdoutJson(`${JSON.stringify(result)}\n`); return; }
      console.log(renderGreenTriage(result));
    });
  withContext(checklist.command('load').description('자리별 작업 부하와 읽기 전용 배분 제안'))
    .action(async (_opts: unknown, cmd: Command) => {
      const { version, json } = readChecklistContext(cmd);
      const { buildChecklistLoad, observeLoadPanes, renderChecklistLoad } = await import('../release-loop/checklist-load.js');
      const snapshot = await readRemoteChecklist(version) ?? listChecklist(version);
      const board = buildChecklistLoad(snapshot, await observeLoadPanes());
      if (json) await writeStdoutJson(`${JSON.stringify(board)}\n`);
      else console.log(renderChecklistLoad(board));
    });
  withContext(checklist.command('stale-sweep').description('병합·열린 PR 경로로 노란 칸 상태를 읽기 전용 대조'))
    .action(async (_opts: unknown, cmd: Command) => {
      const { version, json } = readChecklistContext(cmd);
      const scan = staleSweep(version, process.cwd());
      if (json) { await writeStdoutJson(`${JSON.stringify({ version, ...scan })}\n`); return; }
      const incomplete = scan.incompletePrNumbers.length ? ` · 파일 목록 절단 PR: ${scan.incompletePrNumbers.map((number) => `#${number}`).join(', ')}` : '';
      console.log(`${version} · 병합 PR ${scan.scannedMergedMainPrs}건 · 열린 PR ${scan.scannedOpenPrs}건 조사${scan.complete ? '' : ` · ⚠ 불완전 조사${incomplete}`}`);
      if (!scan.proposals.length && !scan.openPathMatches.length) { console.log('제안·열린 PR 경로 일치 없음'); return; }
      for (const proposal of scan.proposals) {
        console.log(`${proposal.id} · ${proposal.proposalKind} · 제안 상태: proposed(사람 검토 필요) · 현재 ${proposal.currentStatus} · 대상 경로: ${proposal.targetPaths.join(', ')}`);
        for (const pr of proposal.prs) {
          const idEvidence = pr.cellIdMentioned ? '셀 ID 언급' : '경로 일치만 · 셀 ID 미언급';
          const sharedPath = pr.ambiguousWith.length ? ` · 공유 대상: ${pr.ambiguousWith.join(', ')}` : '';
          console.log(`  #${pr.number} · ${idEvidence}${sharedPath} · 일치 경로: ${pr.matchedPaths.join(', ') || '없음'} · 변경 경로: ${pr.changedPaths.join(', ')}`);
        }
      }
      for (const row of scan.openPathMatches) {
        const refs = row.prs.map((pr) => `#${pr.number}@${pr.author} (${pr.baseRefName}) [${pr.matchedPaths.join(', ')}]`).join('; ');
        console.log(`${row.id} · 현재 yellow · 열린 PR 경로 일치(중복 작업 확인): ${refs}`);
      }
    });
  withContext(checklist.command('claim-request <id>').description('비어 있는 노란 칸을 OP 에게 우편으로 선점 요청'))
    .requiredOption('--by <seat>', '요청 자리')
    .action(async (id: string, opts: { by: string }, cmd: Command) => {
      const { version } = readChecklistContext(cmd);
      const snapshot = await readRemoteChecklist(version) ?? listChecklist(version);
      requestChecklistClaim(snapshot, id, opts.by);
      console.log(`OP 에 ${version} ${id} 선점 요청을 보냈다 (원장 소유권은 OP 확인 뒤 변경)`);
    });
  const evidence = withContext(checklist.command('evidence [id]').description('칸의 단계별 실물 근거 사슬 조회·PR 참조 추가'))
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      const { version, json } = readChecklistContext(cmd);
      if (!id) throw new CliUserError('조회할 칸 id를 지정하라');
      if (!json) throw new CliUserError('evidence 조회는 --json 이 필요하다');
      const item = listChecklist(version).items.find((row) => row.id === id);
      if (!item) throw new CliUserError(`없는 칸: ${id}`);
      const result = checklistEvidenceChain({ item, version, stages: evidenceReader(item, version) });
      await writeStdoutJson(`${JSON.stringify(result)}\n`);
    });
  withContext(evidence.command('run <id>').description('칸 제목의 «완료 경계 증거 명령» 을 격리 test 우주에서 1회 실행 → logs.db 영수(checklist.evidence.run) → rc 0 이면 근거 한 줄'))
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const { version, json } = readChecklistContext(cmd);
      const deps = evidenceRunDeps ?? defaultChecklistEvidenceRunDeps(process.env.ELANOUS_TRACK || 'cli', () => mayWriteReleaseChecklist(cmd));
      // 한 번 도는 CLI 는 logs.db 싱크를 스스로 붙인다(standalone-log-sink 선례) — 영수가 실행 호스트의 logs.db 에 닿아야 E4 가 읽는다.
      if (!evidenceRunDeps) try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('release-checklist'); } catch { /* fail-open */ }
      let result: ChecklistEvidenceRunResult;
      try { result = runChecklistEvidence(version, id, deps); } catch (error) {
        // 임대 거부는 원장 쓰기 거부와 같은 종료 코드(4)로 끝낸다 — 실행·기록·근거 0.
        if (error instanceof EvidenceRunLeaseRefused) { console.error(`${error.message}\n  → ${error.hint}`); process.exitCode = 4; return; }
        throw error;
      }
      if (result.rc !== 0 || !result.evidenceLine) process.exitCode = 1;
      if (json) { await writeStdoutJson(`${JSON.stringify(result)}\n`); return; }
      if (result.dispatch?.outputTail) console.error(result.dispatch.outputTail);
      const where = `${result.dispatch ? `실행 ${result.dispatch.executedOn} @${result.dispatch.commit.slice(0, EVIDENCE_COMMIT_ABBREV)} · 원장 ${result.dispatch.ledgerHost}` : `host ${result.host}`}${result.cwd ? ` · cwd ${result.cwd}` : ''}`;
      console.log(result.evidenceLine
        ? `✅ ${id} 증거 실행 rc 0 · runId ${result.runId} · ${where} · 근거 한 줄 덧붙임`
        : result.rc === 0
          ? `❌ ${id} 증거 실행 rc 0 · runId ${result.runId} · ${where} · 시험 호스트 logs.db 에서 영수 사건을 되읽지 못해 근거 0`
          : `❌ ${id} 증거 실행 rc ${result.rc} · runId ${result.runId} · ${where} · 근거 0 (영수만 기록)`);
    });
}

/** The light router enters only list/status, so no publishing modules are loaded. */
export function registerReleaseChecklistReadCommands(program: Command, evidenceReader: ChecklistEvidenceReader = defaultChecklistEvidenceReader): void {
  const release = program.command('release').description('공개 배포 한 판 — prepare(로컬) → publish(--yes) → verify (docs/manual/MANUAL-versioning-and-release-2026-09-25.md)');
  const checklist = release.command('checklist').description('판별 확인표 조회·갱신')
    .option('--version <v>', '판 또는 별칭(기본: package.json 의 개발판에서 -dev.N 제거)')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  registerChecklistReadCommands(checklist, evidenceReader);
}
