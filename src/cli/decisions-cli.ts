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
import { CROWN_MARK, CROWN_THRESHOLD_CATEGORIES, CONSENSUS_CATEGORIES, ConsensusEngine, MAX_REVIEW_ROUND_TRIPS, categoryLabel, representativeLabel, type ConsensusCategory, type ConsensusRepresentative, type CrownCard, type ProposalCard } from '../loops/consensus.js';
import { writeStdoutFully } from './stdout-flush.js';

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
    ...(e.pendingQuestion ? [`판단 재료:\n${e.pendingQuestion}`] : []),
    ...(e.refs?.length ? [`참조: ${e.refs.join(' · ')}`] : [])].join('\n');
}

export function formatSeatDecisionRow(e: SeatDecisionRecord): string {
  return `${e.id} · 결정: ${e.decidedAt ? kst(e.decidedAt) : '시각 미상'} · 기록: ${e.recordedAt ? kst(e.recordedAt) : '시각 미상'} · ${e.seat} 결정 · 사후 보고 · ${e.title} → ${e.decision} · 위임: ${e.delegation}${e.refs?.length ? ` · 참조: ${e.refs.join(' · ')}` : ''}`;
}

export function formatProposalRow(p: ProposalCard): string {
  return `${p.id} · ${categoryLabel(p.category)} · ${p.title} · 사실 ${p.factId} · 비용 ${p.cost} · 되돌리기 ${p.undo}${p.thresholds.length ? ` · ${CROWN_MARK} 몫 ${p.thresholds.join('|')}` : ''} · 제안 ${representativeLabel(p.proposedBy)} · ${kst(p.proposedAt)} · 왕복 ${p.roundTrips}/${MAX_REVIEW_ROUND_TRIPS} · ${p.status === 'open' ? '검토 중' : p.status === 'agreed' ? (p.thresholds.length ? '합의·승인 대기' : '합의·실행·기록') : '불합의'}`;
}

export function formatCrownCardRow(c: CrownCard): string {
  return `${c.id} · ${CROWN_MARK} ${c.reason === 'disagreement' ? '불합의' : '임계 승인'} · 제안 ${c.proposalId} · 조율자 주장: ${c.coordinatorClaim} | 수호자 주장: ${c.guardianClaim}${c.decisionId ? ` · 결정 카드 ${c.decisionId}` : ''}`;
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
  const emit = (value: unknown, json?: boolean, text?: string): void | Promise<void> => {
    const line = json ? JSON.stringify(value) : text ?? JSON.stringify(value);
    if (json && out === console) return writeStdoutFully(line);
    out.log(line);
  };
  const fail = (action: () => void | Promise<void>): void | Promise<void> => {
    const wrap = (e: unknown) => new Error(`decisions: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const result = action();
      return result instanceof Promise ? result.catch(e => { throw wrap(e); }) : result;
    } catch (e) { throw wrap(e); }
  };
  root.command('linear-sync').description('열린 결정을 COO Linear 프로젝트에 투영하고 닫힌 결정을 동기화한다')
    .option('--dry-run').option('--json').option('--hq-override')
    .action(async (o: { dryRun?: boolean; json?: boolean; hqOverride?: boolean }) => {
      if (!o.dryRun && !mayWrite('linear-sync', o.hqOverride)) return;
      const result = await projectDecisionsToLinear({ stateDir: config.stateDir, dryRun: o.dryRun });
      await emit(result, o.json, result.reason ?? `생성 ${result.created} · 닫음 ${result.closed} · 건너뜀 ${result.skipped} · 실패 ${result.failed}${result.plan?.length ? `\n${result.plan.map(p => `${p.action} ${p.decisionId}${p.issue ? ` ${p.issue}` : ''}`).join('\n')}` : ''}`);
    });
  root.command('raise').description('SCQA·선택지와 권고로 결정 항목을 올린다')
    .requiredOption('--title <text>').requiredOption('--category <category>')
    .requiredOption('--s <text>').requiredOption('--c <text>').option('--q <text>').option('--a <text>')
    .option('--pending-question <text>', '판단 재료 전문 (무엇·지금까지·재측·선택지별 결과·권고·확신·그냥 두면·근거)')
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
    .action((o: { due?: string; title: string; category: DecisionCategory; s: string; c: string; q?: string; a?: string; pendingQuestion?: string; option: string[]; recommend?: string; why?: string; skipRecommend?: string; xcheck: string[]; noXcheck?: string; alternative?: string; dissent?: string; track?: DecisionTrack; agent?: string; session?: string; resumeQuestion?: string; run?: string; ref: string[]; json?: boolean; hqOverride?: boolean }) => fail(() => {
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
        ...(o.pendingQuestion ? { pendingQuestion: o.pendingQuestion } : {}),
        ...(crossCheck.length ? { crossCheck } : { crossCheckSkipped: o.noXcheck ?? 'missing' }),
        ...(o.alternative !== undefined ? { alternative: o.alternative } : {}), ...(o.dissent !== undefined ? { dissent: o.dissent } : {}),
        recommendation: o.skipRecommend !== undefined ? { skipped: true, reason: o.skipRecommend } : { option: o.recommend!, why: o.why! },
        raisedBy: { agent: who, ...(o.track ? { track: o.track } : {}), ...(o.session ? { session: o.session } : {}) }, ...(o.ref.length ? { refs: o.ref } : {}),
        ...(o.resumeQuestion !== undefined ? { resume: { questionId: o.resumeQuestion, ...(o.run !== undefined ? { runId: o.run } : {}) } } : {}),
        ...(o.due ? { dueAt: dueAt(o.due) } : {}) });
      if (entry.crossCheckSkipped === 'missing') console.error('교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유');
      return emit(entry, o.json, `올림: ${formatDecisionRow(entry)}`);
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
      return emit(entry, o.json, formatSeatDecisionRow(entry));
    }));
  root.command('seat-report').description('밤사이 자리들의 사후 결정을 한 번에 조회 (기본 최근 24시간)')
    .option('--since <date>', '조회 시작 UTC ISO 또는 Nd', '1d').option('--seat <OP|MK|TC|UX>').option('--json')
    .action((o: { since: string; seat?: Seat; json?: boolean }) => fail(() => {
      const rows = new DecisionLedger(config).seatReport({ since: date(o.since), seat: o.seat });
      return emit(rows, o.json, rows.length ? rows.map(formatSeatDecisionRow).join('\n') : '자리 결정 0건');
    }));
  root.command('proact').description('선제성 기준선 — 지난 7일, 먼저 낸 수·채택 수·물어서야 드러난 수')
    .option('--days <n>', 'KST 일수 (기본 7)', '7').option('--json')
    .action((o: { days: string; json?: boolean }) => fail(() => {
      const days = Number(o.days);
      if (!Number.isInteger(days) || days < 1) throw new Error('invalid days');
      const meter = readProactMeter({ ...(config.stateDir ? { stateDir: config.stateDir, instanceRoot: config.stateDir } : {}), ...(config.now ? { now: config.now() } : {}), days });
      return emit(meter, o.json, formatProactMeter(meter));
    }));
  root.command('list').description('결정 목록 (기본 열린 것)')
    .option('--status <open|decided|all>', '기본 open', 'open').option('--since <date>').option('--version <version>')
    .option('--decided-by <human|auto>').option('--category <category>').option('--json')
    .action((o: { status: 'open' | 'decided' | 'all'; since?: string; version?: string; decidedBy?: 'human' | 'auto'; category?: DecisionCategory; json?: boolean }) => fail(() => {
      const rows = new DecisionLedger(config).list({ status: o.status, since: date(o.since), version: o.version, decidedBy: o.decidedBy, category: o.category });
      return emit(rows, o.json, rows.length ? rows.map(formatDecisionRow).join('\n') : '결정 0건');
    }));
  root.command('show <id>').description('SCQA · 선택지 · 권고 · 이력 · 판').option('--json')
    .action((id: string, o: { json?: boolean }) => fail(() => { const entry = new DecisionLedger(config).show(id); return emit(entry, o.json, formatDecisionDetail(entry)); }));
  root.command('decide <id> <option>').description('사람 또는 AUTO 위임 결정 기록')
    .option('--note <text>').option('--auto').option('--delegation <reason>').option('--track <track>').option('--agent <agent>').option('--json').option('--hq-override')
    .action((id: string, choice: string, o: { note?: string; auto?: boolean; delegation?: string; track?: DecisionTrack; agent?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (o.auto && !o.delegation?.trim()) throw new Error('--auto requires --delegation');
      if (!o.auto && (o.delegation || o.track || o.agent)) throw new Error('delegation/track/agent require --auto');
      const by = o.auto ? { kind: 'auto' as const, agent: agent(o.agent), delegation: o.delegation!, ...(o.track ? { track: o.track } : {}) } : { kind: 'human' as const };
      if (!mayWrite('decide', o.hqOverride)) return;
      const { entry, delivery, notice } = new DecisionLedger(config).decideWithDelivery(id, choice, by, o.note);
      const failures = [
        ...(delivery && !delivery.ok ? [`⚠ 답 전달 실패(${delivery.questionId} · ${delivery.reason}) — 결정은 기록됐다 · 다시: elanous decisions retry-answer ${entry.id}`] : []),
        ...(notice.status === 'failed' ? [`⚠ 자리 우편 실패(${notice.seat} · ${notice.reason}) — 결정은 기록됐다 · 다시: elanous decisions retry-notify ${entry.id}`] : []),
      ];
      if (failures.length) {
        process.exitCode = 3;
        return emit({ ...entry, ...(delivery ? { delivery } : {}), notice }, o.json, `결정: ${formatDecisionDetail(entry)}\n${failures.join('\n')}`);
      }
      const sent = notice.status === 'sent' ? `\n자리 우편: ${notice.seat} #${notice.messageId}` : '';
      return emit({ ...entry, ...(delivery ? { delivery } : {}), notice }, o.json, `결정: ${formatDecisionDetail(entry)}${sent}`);
    }));
  root.command('retry-notify <id>').description('기록된 결정의 올린 자리 우편만 중복 없이 재시도한다').option('--json').option('--hq-override')
    .action((id: string, o: { json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('retry-notify', o.hqOverride)) return;
      const notice = new DecisionLedger(config).retryNotice(id);
      if (notice.status === 'failed') process.exitCode = 3;
      return emit(notice, o.json, notice.status === 'sent' ? `자리 우편: ${notice.seat} #${notice.messageId}` : notice.status === 'skipped' ? '올린 자리 없음 — 우편 대상 없음' : `⚠ 자리 우편 실패(${notice.seat} · ${notice.reason})`);
    }));
  root.command('retry-answer <id>').description('기록된 결정의 대기 질문 답 전달만 재시도한다').option('--json').option('--hq-override')
    .action((id: string, o: { json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('retry-answer', o.hqOverride)) return;
      const entry = new DecisionLedger(config).retryAnswer(id);
      return emit(entry, o.json, `답 전달: ${entry.id} → ${entry.resume?.questionId}`);
    }));
  root.command('add-options <id>').description('선택지가 미기재된 과거 항목에 확인된 선택지를 추가')
    .requiredOption('--option <key=label:consequence>', '선택지 (두 번 이상)', repeat, [] as string[])
    .option('--agent <agent>').option('--json').option('--hq-override')
    .action((id: string, o: { option: string[]; agent?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      const who = agent(o.agent);
      if (!mayWrite('add-options', o.hqOverride)) return;
      const entry = new DecisionLedger(config).addOptions(id, o.option.map(parseOption), who);
      return emit(entry, o.json, formatDecisionDetail(entry));
    }));
  root.command('withdraw <id>').description('결정 철회도 원장에 남긴다').requiredOption('--reason <reason>').option('--json').option('--hq-override')
    .action((id: string, o: { reason: string; json?: boolean; hqOverride?: boolean }) => fail(() => { if (!mayWrite('withdraw', o.hqOverride)) return; const entry = new DecisionLedger(config).withdraw(id, o.reason); return emit(entry, o.json, `철회: ${formatDecisionDetail(entry)}`); }));
  root.command('import-markdown <file>').description('기존 대표 결정 문서 씨앗을 가져온다 (재실행 안전)').option('--json').option('--hq-override')
    .action((file: string, o: { json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('import-markdown', o.hqOverride)) return;
      const result = importDecisionMarkdown(new DecisionLedger(config), file);
      if (result.unread.length) process.exitCode = 1;
      return emit(result, o.json, `가져옴 ${result.imported.length} · 기존 ${result.existing.length} · 불완전 ${result.incomplete.length} · 못 읽음 ${result.unread.length}${result.incomplete.length ? `\n${result.incomplete.join('\n')}` : ''}${result.unread.length ? `\n${result.unread.join('\n')}` : ''}`);
    }));
  const consensusRoot = root.command('consensus').description('두 대표 합의 — 조율자(일의 흐름)·수호자(몸)의 다섯 범주는 «둘의 합의» 뒤에 실행');
  const consensusEngine = () => new ConsensusEngine({ stateDir: config.stateDir, now: config.now, resolveVersion: config.resolveVersion });
  consensusRoot.command('propose').description('제안 카드를 올린다 — 사실 id·비용·되돌리기')
    .requiredOption('--by <representative>', '제안 대표 (coordinator|guardian)')
    .requiredOption('--category <category>', `합의 범주 (${CONSENSUS_CATEGORIES.join('|')})`)
    .requiredOption('--title <text>').requiredOption('--fact-id <id>', '사실 id')
    .requiredOption('--cost <text>', '비용').requiredOption('--undo <text>', '되돌리기')
    .option('--work-key <orch:card:cell>', 'splitter 교차 영향 작업 키')
    .option('--threshold <category>', `${CROWN_MARK} 몫 임계 범주 (반복: ${CROWN_THRESHOLD_CATEGORIES.join('|')})`, repeat, [])
    .option('--provider <name>', 'LLM 제공자 표식 — 가능하면 상대와 다른 제공자 (메아리 방지)')
    .option('--json').option('--hq-override')
    .action((o: { by: string; category: string; title: string; factId: string; cost: string; undo: string; workKey?: string; threshold: string[]; provider?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('consensus propose', o.hqOverride)) return;
      const proposal = consensusEngine().propose({
        by: o.by as ConsensusRepresentative, category: o.category as ConsensusCategory, title: o.title, factId: o.factId, cost: o.cost, undo: o.undo,
        workKey: o.workKey, thresholds: o.threshold.map(threshold => threshold as DecisionCategory), provider: o.provider,
      });
      return emit(proposal, o.json, `제안: ${formatProposalRow(proposal)}`);
    }));
  consensusRoot.command('review <id>').description('상대 검토 왕복을 남긴다 — 최대 2왕복, 마지막 왕복은 결론으로')
    .requiredOption('--by <representative>', '검토 대표 — 제안한 대표의 상대 (coordinator|guardian)')
    .requiredOption('--claim <text>', '검토 주장')
    .option('--provider <name>', 'LLM 제공자 표식 (메아리 방지)')
    .option('--json').option('--hq-override')
    .action((id: string, o: { by: string; claim: string; provider?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('consensus review', o.hqOverride)) return;
      const proposal = consensusEngine().review(id, { by: o.by as ConsensusRepresentative, claim: o.claim, provider: o.provider });
      return emit(proposal, o.json, `검토 ${proposal.roundTrips}/${MAX_REVIEW_ROUND_TRIPS}왕복: ${formatProposalRow(proposal)}`);
    }));
  consensusRoot.command('agree <id>').description(`상대 대표의 합의 — 실행·합의 원장 기록 (임계 범주면 ${CROWN_MARK} 카드도 함께)`)
    .requiredOption('--by <representative>', '합의 대표 — 제안한 대표의 상대 (coordinator|guardian)')
    .option('--claim <text>', '합의 주장 (생략 시 제안대로 실행)')
    .option('--provider <name>', 'LLM 제공자 표식 (메아리 방지)')
    .option('--json').option('--hq-override')
    .action((id: string, o: { by: string; claim?: string; provider?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('consensus agree', o.hqOverride)) return;
      const consensus = consensusEngine();
      const { proposal, crownCard } = consensus.agree(id, { by: o.by as ConsensusRepresentative, claim: o.claim, provider: o.provider });
      if (!crownCard && !consensus.canExecute(proposal.id)) throw new Error(`합의 실행 관문 거부: ${proposal.id}`);
      return emit({ proposal, ...(crownCard ? { crownCard } : {}) }, o.json,
        `합의: ${formatProposalRow(proposal)}${crownCard ? `\n${CROWN_MARK} 카드: ${formatCrownCardRow(crownCard)}` : ''}`);
    }));
  consensusRoot.command('disagree <id>').description(`상대 대표의 불합의 — 양쪽 주장 나란히 ${CROWN_MARK} 결정 카드`)
    .requiredOption('--by <representative>', '불합의 대표 — 제안한 대표의 상대 (coordinator|guardian)')
    .requiredOption('--claim <text>', `불합의 주장 — ${CROWN_MARK} 카드에 나란히 실린다`)
    .option('--provider <name>', 'LLM 제공자 표식 (메아리 방지)')
    .option('--json').option('--hq-override')
    .action((id: string, o: { by: string; claim: string; provider?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('consensus disagree', o.hqOverride)) return;
      const { proposal, crownCard } = consensusEngine().disagree(id, { by: o.by as ConsensusRepresentative, claim: o.claim, provider: o.provider });
      return emit({ proposal, crownCard }, o.json, `불합의: ${formatProposalRow(proposal)}\n${CROWN_MARK} 카드: ${formatCrownCardRow(crownCard)}`);
    }));
  consensusRoot.command('crown').description(`${CROWN_MARK} 결정 카드 목록 — 불합의·임계 범주만 만든다`)
    .option('--json')
    .action((o: { json?: boolean }) => fail(() => {
      const cards = consensusEngine().crownCards();
      return emit(cards, o.json, cards.length ? cards.map(formatCrownCardRow).join('\n') : `${CROWN_MARK} 결정 카드 0건`);
    }));
}
