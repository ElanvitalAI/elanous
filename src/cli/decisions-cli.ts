import { Option, type Command } from 'commander';
import { hqCliWriteAllowed, type HqDeps } from '../hq/hq.js';
import { fileLeaseStore } from '../hq/lease.js';
import { isIsolatedLedgerWriteRoot } from '../hq/ledger-write-target.js';
import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { join } from 'node:path';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig } from '../user-config.js';
import { projectDecisionsToLinear } from '../decisions/decision-linear-projection.js';
import { DecisionLedger, importDecisionMarkdown, type DecisionCategory, type DecisionLedgerOptions, type DecisionOption, type DecisionTrack, type DecisionEntry, type Seat, type SeatDecisionRecord } from '../decisions/decision-ledger.js';
import { formatProactMeter, readProactMeter } from '../decisions/proact-meter.js';

const repeat = (value: string, values: string[]) => [...values, value];
function date(raw?: string): string | undefined {
  if (!raw) return undefined;
  const days = /^(\d+)d$/.exec(raw);
  const parsed = days ? new Date(Date.now() - Number(days[1]) * 86400000) : new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid since: ${raw}`);
  return parsed.toISOString();
}
/** `+6h` → now + 6 hours; otherwise a UTC ISO timestamp (validated by the ledger). */
function dueAt(raw: string): string {
  const hours = /^\+(\d+(?:\.\d+)?)h$/.exec(raw.trim());
  if (hours) return new Date(Date.now() + Number(hours[1]) * 3600000).toISOString();
  return raw.trim();
}
const kst = (at: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(at)) + ' KST';
const version = (e: DecisionEntry['version']) => e ? `released=${e.released ?? '-'} · dev=${e.dev ?? '-'}${e.codename ? ` «${e.codename}»` : ''}` : '판 미상';
function agent(o?: string): string {
  const value = o?.trim() || process.env.AI_AGENT?.trim();
  if (!value) throw new Error('agent unknown: provide --agent or AI_AGENT');
  return value;
}
function parseOption(raw: string): DecisionOption {
  const m = /^([a-z])=(.+?):(.+)$/.exec(raw);
  if (!m) throw new Error(`invalid --option: ${raw} (expected a=label:consequence)`);
  return { key: m[1]!, label: m[2]!, consequence: m[3]! };
}
export function formatDecisionRow(e: DecisionEntry): string {
  const recommendation = 'skipped' in e.recommendation ? '권고 생략' : `${e.recommendation.option} (${e.recommendation.why})`;
  return `${e.id} · ${e.category} · ${e.title} · ${recommendation} · ${e.raisedAt ? kst(e.raisedAt) : '올린 시각 미상'} · ${version(e.version)}`;
}
export function formatDecisionDetail(e: DecisionEntry): string {
  return [formatDecisionRow(e), `상태: ${e.status}`, `S: ${e.scqa.s}`, `C: ${e.scqa.c}`, `Q: ${e.scqa.q ?? '(비움)'}`, `A: ${e.scqa.a ?? '(비움)'}`,
    '선택지 | 결과', ...(e.options.length ? e.options.map(o => `${o.key}: ${o.label} | ${o.consequence}`) : ['원문에 선택지 없음 · 확인 필요']),
    'skipped' in e.recommendation ? `권고 생략: ${e.recommendation.reason}` : `권고: ${e.recommendation.option} — ${e.recommendation.why}`,
    `올림: ${e.raisedAt ? kst(e.raisedAt) : '시각 미상'} · ${e.raisedBy.agent} · ${version(e.version)}`,
    ...(e.dueAt ? [`기한: ${kst(e.dueAt)}`] : []),
    ...(e.importedAt ? [`가져옴: ${kst(e.importedAt)}`] : []),
    ...(e.status === 'decided' ? [`결정: ${e.decidedAt ? kst(e.decidedAt) : '시각 미상'} · ${e.decidedBy?.kind === 'auto' ? `AUTO ${e.decidedBy.agent} (${e.decidedBy.delegation})` : e.decidedBy?.kind === 'human' ? 'human' : '주체 미상'} · ${e.choice ?? '선택 키 미상'} · ${e.versionAtDecision ? version(e.versionAtDecision) : '결정 당시 판 미상'}`,
      ...(e.note ? [`메모: ${e.note}`] : [])] : []),
    ...(e.withdrawnAt ? [`철회: ${kst(e.withdrawnAt)} · ${e.withdrawReason}`] : []),
    '이력:', ...e.history.map(h => `  ${h.type} · ${h.at ? kst(h.at) : '시각 미상'} · ${h.by}${h.choice ? ` · ${h.choice}` : ''}${h.reason ? ` · ${h.reason}` : ''} · ${h.version ? version(h.version) : '판 미상'}`),
    ...(e.refs?.length ? [`참조: ${e.refs.join(' · ')}`] : [])].join('\n');
}

export function formatSeatDecisionRow(e: SeatDecisionRecord): string {
  return `${e.id} · 결정: ${e.decidedAt ? kst(e.decidedAt) : '시각 미상'} · 기록: ${e.recordedAt ? kst(e.recordedAt) : '시각 미상'} · ${e.seat} 결정 · 사후 보고 · ${e.title} → ${e.decision} · 위임: ${e.delegation}${e.refs?.length ? ` · 참조: ${e.refs.join(' · ')}` : ''}`;
}

export function registerDecisionsCommands(program: Command, config: DecisionLedgerOptions = {}, out: Pick<Console, 'log'> = console, hqDeps: HqDeps = {}): void {
  const noXcheck = new Option('--no-xcheck <이유>', '교차 확인 생략 이유');
  // This flag takes a reason, not Commander's negated boolean default.
  noXcheck.negate = false;
  const root = program.command('decisions').description('대표 결정 원장 · 로컬 전용').option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  const mayWrite = (command: string, override?: boolean) => {
    const ledgerRoot = config.stateDir ?? elanousStateRoot();
    if (command !== 'linear-sync' && isIsolatedLedgerWriteRoot(ledgerRoot)) {
      try { debug.log('hq.fence', 'skipped-isolated', { root: ledgerRoot, command: `decisions ${command}` }); } catch { /* observation is fail-soft */ }
      return true;
    }
    return hqCliWriteAllowed(`decisions ${command}`, Boolean(override || root.opts().hqOverride),
      (getElanousConfigDirOverride() || config.stateDir) && !hqDeps.store && !getUserConfig().hq?.arbiter ? { ...hqDeps, store: fileLeaseStore(join(config.stateDir ?? effectiveInstanceRoot(), 'hq', 'lease.json')), seenPath: join(config.stateDir ?? effectiveInstanceRoot(), 'hq', 'seen-generation'), localPath: join(config.stateDir ?? effectiveInstanceRoot(), 'hq', 'local.json') } : hqDeps);
  };
  const emit = (value: unknown, json?: boolean, text?: string) => out.log(json ? JSON.stringify(value) : text ?? JSON.stringify(value));
  const fail = (action: () => void) => { try { action(); } catch (e) { throw new Error(`decisions: ${e instanceof Error ? e.message : String(e)}`); } };
  root.command('linear-sync').description('열린 결정을 COO Linear 프로젝트에 투영하고 닫힌 결정을 동기화한다')
    .option('--dry-run').option('--json').option('--hq-override')
    .action(async (o: { dryRun?: boolean; json?: boolean; hqOverride?: boolean }) => {
      if (!o.dryRun && !mayWrite('linear-sync', o.hqOverride)) return;
      const result = await projectDecisionsToLinear({ stateDir: config.stateDir, dryRun: o.dryRun });
      emit(result, o.json, result.reason ?? `생성 ${result.created} · 닫음 ${result.closed} · 건너뜀 ${result.skipped} · 실패 ${result.failed}${result.plan?.length ? `\n${result.plan.map(p => `${p.action} ${p.decisionId}${p.issue ? ` ${p.issue}` : ''}`).join('\n')}` : ''}`);
    });
  root.command('raise').description('SCQA·선택지와 권고로 결정 항목을 올린다')
    .requiredOption('--title <text>').requiredOption('--category <category>')
    .requiredOption('--s <text>').requiredOption('--c <text>').option('--q <text>').option('--a <text>')
    .requiredOption('--option <key=label:consequence>', '선택지 (두 번 이상)', repeat, [] as string[])
    .option('--recommend <key>').option('--why <text>').option('--skip-recommend <reason>')
    .option('--xcheck <SEAT:메모>', '교차 확인 (반복)', repeat, [] as string[])
    .addOption(noXcheck)
    .option('--alternative <key>').option('--dissent <text>')
    .option('--track <track>').option('--agent <agent>').option('--session <id>')
    .option('--resume-question <qid>').option('--run <runId>')
    .option('--ref <url>', '참조 (반복)', repeat, [] as string[])
    .option('--due <when>', '기한 — UTC ISO(2026-10-04T09:00:00Z) 또는 +Nh(지금부터 N시간) · 기한 2시간 전 텔레그램·디스코드로 다시 알린다')
    .option('--json').option('--hq-override')
    .action((o: { due?: string; title: string; category: DecisionCategory; s: string; c: string; q?: string; a?: string; option: string[]; recommend?: string; why?: string; skipRecommend?: string; xcheck: string[]; noXcheck?: string; alternative?: string; dissent?: string; track?: DecisionTrack; agent?: string; session?: string; resumeQuestion?: string; run?: string; ref: string[]; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (o.run !== undefined && o.resumeQuestion === undefined) throw new Error('--run requires --resume-question');
      if (o.skipRecommend !== undefined && (o.recommend !== undefined || o.why !== undefined)) throw new Error('choose recommendation or skip, not both');
      if (o.skipRecommend === undefined && (!o.recommend || !o.why)) throw new Error('--recommend and --why required, or --skip-recommend <reason>');
      const options: DecisionOption[] = o.option.map(parseOption);
      if (o.xcheck.length && o.noXcheck !== undefined) throw new Error('choose --xcheck or --no-xcheck, not both');
      const crossCheck = o.xcheck.map(raw => {
        const match = /^([^:\s]+):(.+)$/.exec(raw);
        if (!match || !match[2]!.trim()) throw new Error(`invalid --xcheck: ${raw} (expected SEAT:메모)`);
        return { seat: match[1]!, at: new Date().toISOString(), note: match[2]!.trim() };
      });
      if (!crossCheck.length && o.noXcheck === undefined && getUserConfig().decisions?.requireCrossCheck) throw new Error('교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유');
      const who = agent(o.agent);
      if (!mayWrite('raise', o.hqOverride)) return;
      const entry = new DecisionLedger(config).raise({ title: o.title, category: o.category, scqa: { s: o.s, c: o.c, ...(o.q ? { q: o.q } : {}), ...(o.a ? { a: o.a } : {}) }, options,
        ...(crossCheck.length ? { crossCheck } : { crossCheckSkipped: o.noXcheck ?? 'missing' }),
        ...(o.alternative !== undefined ? { alternative: o.alternative } : {}), ...(o.dissent !== undefined ? { dissent: o.dissent } : {}),
        recommendation: o.skipRecommend !== undefined ? { skipped: true, reason: o.skipRecommend } : { option: o.recommend!, why: o.why! },
        raisedBy: { agent: who, ...(o.track ? { track: o.track } : {}), ...(o.session ? { session: o.session } : {}) }, ...(o.ref.length ? { refs: o.ref } : {}),
        ...(o.resumeQuestion !== undefined ? { resume: { questionId: o.resumeQuestion, ...(o.run !== undefined ? { runId: o.run } : {}) } } : {}),
        ...(o.due ? { dueAt: dueAt(o.due) } : {}) });
      if (entry.crossCheckSkipped === 'missing') console.error('교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유');
      emit(entry, o.json, `올림: ${formatDecisionRow(entry)}`);
    }));
  root.command('record-seat').description('위임 범위에서 이미 내린 자리 결정을 사후 보고로 원장에 기록 (대표 카드 아님)')
    .requiredOption('--seat <OP|MK|TC|UX>').requiredOption('--title <text>')
    .requiredOption('--decision <text>').requiredOption('--delegation <scope>')
    .option('--at <UTC>', '알고 있는 결정 시각 (UTC ISO; 생략 시 결정 시각 미상)')
    .option('--ref <source>', '조율 글 등의 출처 (반복)', repeat, [] as string[])
    .option('--json').option('--hq-override')
    .action((o: { seat: Seat; title: string; decision: string; delegation: string; at?: string; ref: string[]; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('record-seat', o.hqOverride)) return;
      const entry = new DecisionLedger(config).recordSeatDecision({ seat: o.seat, title: o.title, decision: o.decision,
        delegation: o.delegation, ...(o.at ? { decidedAt: o.at } : {}), ...(o.ref.length ? { refs: o.ref } : {}) });
      emit(entry, o.json, formatSeatDecisionRow(entry));
    }));
  root.command('seat-report').description('밤사이 자리들의 사후 결정을 한 번에 조회 (기본 최근 24시간)')
    .option('--since <date>', '조회 시작 UTC ISO 또는 Nd', '1d').option('--seat <OP|MK|TC|UX>').option('--json')
    .action((o: { since: string; seat?: Seat; json?: boolean }) => fail(() => {
      const rows = new DecisionLedger(config).seatReport({ since: date(o.since), seat: o.seat });
      emit(rows, o.json, rows.length ? rows.map(formatSeatDecisionRow).join('\n') : '자리 결정 0건');
    }));
  root.command('proact').description('선제성 기준선 — 지난 7일, 먼저 낸 수·채택 수·물어서야 드러난 수')
    .option('--days <n>', 'KST 일수 (기본 7)', '7').option('--json')
    .action((o: { days: string; json?: boolean }) => fail(() => {
      const days = Number(o.days);
      if (!Number.isInteger(days) || days < 1) throw new Error('invalid days');
      const meter = readProactMeter({ ...(config.stateDir ? { stateDir: config.stateDir, instanceRoot: config.stateDir } : {}), ...(config.now ? { now: config.now() } : {}), days });
      emit(meter, o.json, formatProactMeter(meter));
    }));
  root.command('list').description('결정 목록 (기본 열린 것)')
    .option('--status <open|decided|all>', '기본 open', 'open').option('--since <date>').option('--version <version>')
    .option('--decided-by <human|auto>').option('--category <category>').option('--json')
    .action((o: { status: 'open' | 'decided' | 'all'; since?: string; version?: string; decidedBy?: 'human' | 'auto'; category?: DecisionCategory; json?: boolean }) => fail(() => {
      const rows = new DecisionLedger(config).list({ status: o.status, since: date(o.since), version: o.version, decidedBy: o.decidedBy, category: o.category });
      emit(rows, o.json, rows.length ? rows.map(formatDecisionRow).join('\n') : '결정 0건');
    }));
  root.command('show <id>').description('SCQA · 선택지 · 권고 · 이력 · 판').option('--json')
    .action((id: string, o: { json?: boolean }) => fail(() => { const entry = new DecisionLedger(config).show(id); emit(entry, o.json, formatDecisionDetail(entry)); }));
  root.command('decide <id> <option>').description('사람 또는 AUTO 위임 결정 기록')
    .option('--note <text>').option('--auto').option('--delegation <reason>').option('--track <track>').option('--agent <agent>').option('--json').option('--hq-override')
    .action((id: string, choice: string, o: { note?: string; auto?: boolean; delegation?: string; track?: DecisionTrack; agent?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (o.auto && !o.delegation?.trim()) throw new Error('--auto requires --delegation');
      if (!o.auto && (o.delegation || o.track || o.agent)) throw new Error('delegation/track/agent require --auto');
      const by = o.auto ? { kind: 'auto' as const, agent: agent(o.agent), delegation: o.delegation!, ...(o.track ? { track: o.track } : {}) } : { kind: 'human' as const };
      if (!mayWrite('decide', o.hqOverride)) return;
      const { entry, delivery } = new DecisionLedger(config).decideWithDelivery(id, choice, by, o.note);
      if (delivery && !delivery.ok) {
        // The decision is recorded; only the answer to the waiting run failed — say so and how to retry, never «success».
        const hint = `⚠ 답 전달 실패(${delivery.questionId} · ${delivery.reason}) — 결정은 기록됐다 · 다시: elanous decisions retry-answer ${entry.id}`;
        emit({ ...entry, delivery }, o.json, `결정: ${formatDecisionDetail(entry)}\n${hint}`);
        process.exitCode = 3;
        return;
      }
      emit(delivery ? { ...entry, delivery } : entry, o.json, `결정: ${formatDecisionDetail(entry)}`);
    }));
  root.command('retry-answer <id>').description('기록된 결정의 대기 질문 답 전달만 재시도한다').option('--json').option('--hq-override')
    .action((id: string, o: { json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('retry-answer', o.hqOverride)) return;
      const entry = new DecisionLedger(config).retryAnswer(id);
      emit(entry, o.json, `답 전달: ${entry.id} → ${entry.resume?.questionId}`);
    }));
  root.command('add-options <id>').description('선택지가 미기재된 과거 항목에 확인된 선택지를 추가')
    .requiredOption('--option <key=label:consequence>', '선택지 (두 번 이상)', repeat, [] as string[])
    .option('--agent <agent>').option('--json').option('--hq-override')
    .action((id: string, o: { option: string[]; agent?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      const who = agent(o.agent);
      if (!mayWrite('add-options', o.hqOverride)) return;
      const entry = new DecisionLedger(config).addOptions(id, o.option.map(parseOption), who);
      emit(entry, o.json, formatDecisionDetail(entry));
    }));
  root.command('withdraw <id>').description('결정 철회도 원장에 남긴다').requiredOption('--reason <reason>').option('--json').option('--hq-override')
    .action((id: string, o: { reason: string; json?: boolean; hqOverride?: boolean }) => fail(() => { if (!mayWrite('withdraw', o.hqOverride)) return; const entry = new DecisionLedger(config).withdraw(id, o.reason); emit(entry, o.json, `철회: ${formatDecisionDetail(entry)}`); }));
  root.command('import-markdown <file>').description('기존 대표 결정 문서 씨앗을 가져온다 (재실행 안전)').option('--json').option('--hq-override')
    .action((file: string, o: { json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('import-markdown', o.hqOverride)) return;
      const result = importDecisionMarkdown(new DecisionLedger(config), file);
      emit(result, o.json, `가져옴 ${result.imported.length} · 기존 ${result.existing.length} · 불완전 ${result.incomplete.length} · 못 읽음 ${result.unread.length}${result.incomplete.length ? `\n${result.incomplete.join('\n')}` : ''}${result.unread.length ? `\n${result.unread.join('\n')}` : ''}`);
      if (result.unread.length) process.exitCode = 1;
    }));
}
