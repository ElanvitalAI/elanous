import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { checklistEvidenceChain, devVersion, listChecklist, ownerMatches, parseOwner, parityGap, summarizeChecklist, type ChecklistEvidenceStage } from '../release-loop/checklist.js';
import { userConfigPath } from '../user-config.js';
import { CliUserError } from './cli-user-error.js';
import { writeStdoutJson } from './stdout-json.js';

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
  const snapshot = listChecklist(v);
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

// E4 reads only the exact event near the evidence timestamp; absent timestamps fail closed.
const E4_LOG_WINDOW_MS = 30 * 60_000;
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

export function collectChecklistEvidenceStages(item: ReturnType<typeof listChecklist>['items'][number], run: ChecklistEvidenceCommandRunner = evidenceCommand): ChecklistEvidenceStage[] {
  const measuredAt = new Date().toISOString();
  const evidence = item.evidence ?? '';
  const prRefs = [...new Set([...evidence.matchAll(/(?:^|\s)#(\d{1,8})\b/gu)].map((match) => match[1]!))];
  const pr = prRefs.length === 1 ? prRefs[0] : undefined;
  const prLine = pr ? evidence.split(/\r?\n/u).find((line) => new RegExp(`(?:^|\\s)#${pr}\\b`).test(line)) : undefined;
  const e1: ChecklistEvidenceStage = { id: 'E1', state: 'missing', source: 'checklist evidence + eln gh pr view', measuredAt,
    reason: prRefs.length > 1 ? '근거에서 교차할 PR이 하나로 좁혀지지 않는다' : '근거에 병합 PR 번호가 없다' };
  let mergeSha: string | null = null;
  if (pr) {
    const view = run('eln', ['gh', 'pr', 'view', pr, '--json', 'state,mergeCommit']);
    const record = view.status === 0 ? evidenceJson(view.stdout) : null;
    if (!record) { e1.state = 'unmeasurable'; e1.reason = `PR #${pr} 조회 실패${view.error ? `: ${view.error}` : ''}`; }
    else if (record.state !== 'MERGED') { e1.reason = `PR #${pr} 상태가 MERGED가 아니다`; }
    else {
      const commit = record.mergeCommit && typeof record.mergeCommit === 'object' ? (record.mergeCommit as { oid?: unknown }).oid : null;
      mergeSha = typeof commit === 'string' && /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
      if (!mergeSha) { e1.state = 'unmeasurable'; e1.reason = `PR #${pr} 조회에 유효한 merge SHA가 없다`; }
      else if (!prLine || !new RegExp(`\\b${mergeSha}\\b`, 'i').test(prLine)) { e1.reason = `병합 PR #${pr}와 merge SHA가 같은 근거 줄에서 결속되지 않았다`; e1.source = `eln gh pr view #${pr} → ${mergeSha}`; }
      else { e1.state = 'observed'; e1.reason = `PR #${pr} MERGED 및 merge SHA가 근거와 일치한다`; e1.source = `eln gh pr view #${pr} → ${mergeSha}`; }
    }
  }

  const e3: ChecklistEvidenceStage = { id: 'E3', state: 'unmeasurable', source: null, measuredAt, reason: mergeSha ? '설치본 pin을 조회하지 못했다' : 'E1 merge SHA가 없어 조상 관계를 검사할 수 없다' };
  if (mergeSha) {
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
      const ancestry = run('git', ['merge-base', '--is-ancestor', mergeSha, pinSha]);
      e3.source = `eln --version ${pinSha}; git -C ${repoRoot.stdout.trim()} merge-base --is-ancestor ${mergeSha} ${pinSha}`;
      if (ancestry.status === 0) { e3.state = 'observed'; e3.reason = '설치본 pin이 merge SHA의 후손이다'; }
      else if (ancestry.status === 1) { e3.state = 'missing'; e3.reason = '설치본 pin이 merge SHA의 후손이 아니다'; }
      else { e3.reason = `설치본 저장소에서 조상 관계를 검사할 수 없다${ancestry.error ? `: ${ancestry.error}` : ''}`; }
      }
    }
  }

  const identityToken = '(?:run-[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-z0-9][a-z0-9._:-]{2,})';
  const labelledIdentity = new RegExp(`\\b(runId|missionId|taskId)\\s*[:=]?\\s*(${identityToken})\\b`, 'i').exec(evidence);
  const runId = labelledIdentity?.[2]
    ?? /\b(run-[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i.exec(evidence)?.[1];
  const identityLabel = labelledIdentity?.[1]?.toLowerCase();
  const identityField = identityLabel === 'missionid' ? 'missionId' : identityLabel === 'taskid' ? 'taskId' : 'runId';
  const event = /(?:event|이벤트)\s*[:=]\s*([A-Za-z0-9_.:-]+)/iu.exec(evidence)?.[1];
  const verificationCommand = /(?:완료 경계 증거 명령|증거 명령|verification command)\s*[:=]\s*([^\r\n]+)/iu.exec(`${item.title}\n${evidence}`)?.[1]?.trim() ?? null;
  const e4: ChecklistEvidenceStage = { id: 'E4', state: 'missing', source: null, measuredAt, verificationCommand, reason: '근거에 runId·missionId·taskId 중 하나와 event·원문 검증 명령이 모두 필요하다' };
  if (runId && event && verificationCommand) {
    const identityAt = evidenceTimestampNearIdentity(evidence, runId);
    if (identityAt === null) {
      e4.state = 'unmeasurable';
      e4.reason = `근거의 ${identityField}=${runId} 주변에 시간대가 명시된 ISO 시각이 없어 로그 조회 창을 만들 수 없다`;
    } else {
      const since = new Date(identityAt - E4_LOG_WINDOW_MS).toISOString();
      const until = new Date(identityAt + E4_LOG_WINDOW_MS).toISOString();
      const logs = run('eln', ['logs', '--event', event, '--since', since, '--until', until, '--all', '--include-test', '--limit', '1000', '--json'], 30_000);
      if (logs.status !== 0) { e4.state = 'unmeasurable'; e4.reason = `runId 로그 조회 실패${logs.error ? `: ${logs.error}` : ''}`; }
      else {
        const rows = logs.stdout.split(/\r?\n/u).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
        const truncated = rows.length >= 1000 || rows.some((row) => row._meta && typeof row._meta === 'object' && (row._meta as { limitReached?: unknown }).limitReached === true);
        const observed = rows.some((row) => {
          if (row.event !== event || typeof row.data !== 'string') return false;
          try {
            const data = JSON.parse(row.data) as { runId?: unknown; missionId?: unknown; taskId?: unknown };
            return data[identityField] === runId;
          } catch { return false; }
        });
        e4.source = `eln logs --event ${event} --since ${since} --until ${until} --all --include-test --limit 1000 --json (${identityField}=${runId})`;
        if (observed) { e4.state = 'observed'; e4.reason = `같은 ${identityField}의 ${event} 실물 이벤트를 찾았다`; }
        else if (truncated) { e4.state = 'unmeasurable'; e4.reason = '로그 결과가 잘려 사건 부재를 판정할 수 없다'; }
        else { e4.reason = `같은 ${identityField}의 ${event} 이벤트가 없다`; }
      }
    }
  }

  const acceptance = /^\s*(?:[-*]\s*)?완료 경계 실물\s*:\s*([^\r\n]+)/mu.exec(item.title)?.[1]?.trim();
  const e5Observed = Boolean(acceptance && evidence.includes(acceptance));
  const e5: ChecklistEvidenceStage = { id: 'E5', state: e5Observed ? 'observed' : 'missing', source: 'checklist title/evidence exact acceptance-text comparison', measuredAt,
    reason: e5Observed ? '완료 경계 실물 문구가 기록된 근거와 일치한다' : '완료 경계 실물 문구와 일치하는 근거가 없다' };
  return [
    e1, e3, e4, e5,
  ];
}

/** Register the same read commands on the full and lightweight release roots. */
export function registerChecklistReadCommands(checklist: Command, evidenceReader: ChecklistEvidenceReader = defaultChecklistEvidenceReader): void {
  const withContext = (cmd: Command) => cmd.option('--version <v>', '판 또는 별칭').option('--json', '결과 JSON').option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  withContext(checklist.command('list').description('모든 칸')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = readChecklistContext(cmd);
    await checklistOutput(version, codenames, 'list', json, opts.owner);
  });
  withContext(checklist.command('status').description('상태 요약')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = readChecklistContext(cmd);
    await checklistOutput(version, codenames, 'status', json, opts.owner);
  });
  withContext(checklist.command('evidence [id]').description('칸의 단계별 실물 근거 사슬 조회·PR 참조 추가'))
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      const { version, json } = readChecklistContext(cmd);
      if (!id) throw new CliUserError('조회할 칸 id를 지정하라');
      if (!json) throw new CliUserError('evidence 조회는 --json 이 필요하다');
      const item = listChecklist(version).items.find((row) => row.id === id);
      if (!item) throw new CliUserError(`없는 칸: ${id}`);
      const result = checklistEvidenceChain({ item, version, stages: evidenceReader(item, version) });
      await writeStdoutJson(`${JSON.stringify(result)}\n`);
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
