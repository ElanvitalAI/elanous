import { Option, type Command } from 'commander';
import { hqCliWriteAllowed, type HqDeps } from '../hq/hq.js';
import { fileLeaseStore } from '../hq/lease.js';
import { isIsolatedLedgerWriteRoot } from '../hq/ledger-write-target.js';
import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { dirname, join } from 'node:path';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig } from '../user-config/reader.js';
import { projectDecisionsToLinear } from '../decisions/decision-linear-projection.js';
import { DecisionLedger, importDecisionMarkdown, validateDecisionRaise, type DecisionCategory, type DecisionLedgerOptions, type DecisionOption, type DecisionTrack, type DecisionEntry, type RaiseInput, type Seat, type SeatDecisionRecord } from '../decisions/decision-ledger.js';
import { formatProactMeter, readProactMeter } from '../decisions/proact-meter.js';
import { CROWN_MARK, CROWN_THRESHOLD_CATEGORIES, CONSENSUS_CATEGORIES, ConsensusEngine, MAX_REVIEW_ROUND_TRIPS, categoryLabel, representativeLabel, type ConsensusCategory, type ConsensusRepresentative, type CrownCard, type ProposalCard } from '../loops/consensus.js';
import { writeStdoutFully } from './stdout-flush.js';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { approvalProofPayload, checkHumanApprovalProof, readDecisionTrustRoots, type HumanProofCheck } from '../decisions/decision-ledger.js';
import { readQueryCache } from '../storage/short-lived-read-cache.js';
import { formatDecisionRow } from './decision-list-format.js';
import { decisionListSince, filterDecisionListSince } from './decision-list-since.js';
import { openMsgStore } from '../msg/msg-store.js';
import { resolveSeat } from '../seat-address/seat-address.js';
import { recordAction } from '../fed-state/actions.js';
import { crownRecordInput, pointDecisionToBus } from '../kit/decision-bus/index.js';
import { BUS_HQ_SPACE } from '../op-context-bus/spaces.js';
import { BUS_COORDINATOR_SEAT } from '../op-context-bus/seat-turn.js';
// Preserve the formatter export for existing consumers of this CLI module.
export { formatDecisionRow } from './decision-list-format.js';

const repeat = (value: string, values: string[]) => [...values, value];
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
/** FED-FACT-OP-ACTIONS — the seat a decision fact is attributed to: the resolved seat, else ELANOUS_TRACK, else the agent. */
function actorSeat(fallback: string): string {
  const raw = process.env.ELANOUS_TRACK?.trim() || process.env.ELANOUS_SEAT?.trim() || fallback;
  try { return resolveSeat(raw)?.id ?? raw; } catch { return raw; }
}
function parseOption(raw: string): DecisionOption {
  const m = /^([a-z])=(.+?):(.+)$/.exec(raw);
  if (!m) throw new Error(`invalid --option: ${raw} (expected a=label:consequence)`);
  return { key: m[1]!, label: m[2]!, consequence: m[3]! };
}
function hasKorean(text: string): boolean { return /\p{Script=Hangul}/u.test(text); }
function missingJudgmentFields(text: string): string[] {
  return ['근거', '무엇이 바뀌나', '기본값 시 결과'].filter(label => !new RegExp(`^${label}[ \\t]*[:：][ \\t]*\\S`, 'm').test(text));
}
export function formatDecisionDetail(e: DecisionEntry): string {
  return [formatDecisionRow(e), `상태: ${e.status}`, `S: ${e.scqa.s}`, `C: ${e.scqa.c}`, `Q: ${e.scqa.q ?? '(비움)'}`, `A: ${e.scqa.a ?? '(비움)'}`,
    '선택지 | 결과', ...(e.options.length ? e.options.map(o => `${o.key}: ${o.label} | ${o.consequence}`) : ['원문에 선택지 없음 · 확인 필요']),
    'skipped' in e.recommendation ? `권고 생략: ${e.recommendation.reason}` : `권고: ${e.recommendation.option} — ${e.recommendation.why}`,
    `올림: ${e.raisedAt ? kst(e.raisedAt) : '시각 미상'} · ${e.raisedBy.agent} · ${version(e.version)}`,
    ...(e.dueAt ? [`기한: ${kst(e.dueAt)}`] : []),
    ...(e.importedAt ? [`가져옴: ${kst(e.importedAt)}`] : []),
    ...(e.status === 'decided' ? [`결정: ${e.decidedAt ? kst(e.decidedAt) : '시각 미상'} · ${e.decidedBy?.kind === 'auto' ? `AUTO ${e.decidedBy.agent} (${e.decidedBy.delegation})${e.decidedBy.origin ? ` · origin=${e.decidedBy.origin}` : ''}` : e.decidedBy?.kind === 'human' ? `human${e.decidedBy.via ? ` · ${e.decidedBy.via}` : ' · 경로 미기록'}${e.decidedBy.platformUserId ? ` · ${e.decidedBy.platformUserId}` : ''}${e.proof ? ` · 증명 ${e.proof.keyId}` : ''}` : e.decidedBy?.kind === 'imported' ? `IMPORTED ${e.decidedBy.source}` : '주체 미상'} · ${e.choice ?? '선택 키 미상'} · ${e.versionAtDecision ? version(e.versionAtDecision) : '결정 당시 판 미상'}`,
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

/** Legacy terminal hint only. TTY and environment are both controlled by the caller, so this grants no human authority. */
export function isHumanTerminal(env: Readonly<Record<string, string | undefined>> = process.env, tty = process.stdin.isTTY === true): boolean {
  return !env.ELANOUS_SEAT?.trim() && tty;
}

export const HUMAN_DECIDE_REFUSED = 'CLI는 사람 신원을 검증할 수 없어 human 결정을 기록하지 않는다 — 자동화 결정은 --auto --agent <이름> --delegation <근거>';

/** Injection seams for `decisions signer rotate|revoke` (tests): the person's-terminal check, the typed code, the OP notice. */
export interface SignerCliSeams {
  terminal?: () => { ok: true } | { ok: false; line: string };
  ask?: (prompt: string) => Promise<string>;
  notify?: (line: string) => void;
  ownerLedgerPath?: string;
  host?: string;
}
export function registerDecisionsCommands(program: Command, config: DecisionLedgerOptions & { humanTerminal?: () => boolean; signer?: SignerCliSeams } = {}, out: Pick<Console, 'log'> = console, hqDeps: HqDeps = {}): void {
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
  root.command('raise').description('판단 재료가 있는 대표 결정 카드를 올린다 (자리는 OP 우편으로 제안한다)')
    .requiredOption('--title <text>').requiredOption('--category <category>')
    .requiredOption('--s <text>').requiredOption('--c <text>').option('--q <text>').option('--a <text>')
    .option('--pending-question <text>', '필수 판단 재료: 근거·무엇이 바뀌나·기본값 시 결과')
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
      if (!o.pendingQuestion?.trim()) throw new Error('--pending-question required (근거·무엇이 바뀌나·기본값 시 결과)');
      const missingJudgment = missingJudgmentFields(o.pendingQuestion.trim());
      if (missingJudgment.length) throw new Error(`--pending-question missing: ${missingJudgment.join('·')}`);
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
      const raiseInput: RaiseInput = {
        title: o.title, category: o.category,
        scqa: { s: o.s, c: o.c, ...(o.q ? { q: o.q } : {}), ...(o.a ? { a: o.a } : {}) },
        options,
        pendingQuestion: o.pendingQuestion.trim(),
        ...(crossCheck.length ? { crossCheck } : { crossCheckSkipped: o.noXcheck ?? 'missing' }),
        ...(o.alternative !== undefined ? { alternative: o.alternative } : {}),
        ...(o.dissent !== undefined ? { dissent: o.dissent } : {}),
        recommendation: o.skipRecommend !== undefined ? { skipped: true, reason: o.skipRecommend } : { option: o.recommend!, why: o.why! },
        raisedBy: { agent: who, ...(o.track ? { track: o.track } : {}), ...(o.session ? { session: o.session } : {}) },
        ...(o.ref.length ? { refs: o.ref } : {}),
        ...(o.resumeQuestion !== undefined ? { resume: { questionId: o.resumeQuestion, ...(o.run !== undefined ? { runId: o.run } : {}) } } : {}),
        ...(o.due ? { dueAt: dueAt(o.due) } : {}),
      };
      // Seat proposals are validated against the ledger contract without writing a representative decision.
      const validated = validateDecisionRaise(raiseInput);
      const pendingValues = validated.pendingQuestion!.split(/\r?\n/).map(line => line.replace(/^[^:：]+[:：][ \t]*/, '').trim());
      const userCopy = [validated.title, validated.scqa.s, validated.scqa.c, validated.scqa.q, validated.scqa.a,
        ...validated.options.flatMap(option => [option.label, option.consequence]), ...pendingValues,
        ...(validated.crossCheck ?? []).map(check => check.note), validated.dissent, o.noXcheck,
        'skipped' in validated.recommendation ? validated.recommendation.reason : validated.recommendation.why]
        .filter((part): part is string => Boolean(part));
      if (userCopy.some(part => !hasKorean(part))) console.error('한국어 문면 경고 — 대표 카드의 판단 재료와 선택지 문구를 한국어로 작성하세요.');
      if (!validated.crossCheck?.length && o.noXcheck === undefined) console.error('교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유');
      // A release track is not the origin seat. A CLI command raised by OP can target UX for notice
      // delivery while remaining a representative card; only explicit seat context routes as a proposal.
      const seatHint = process.env.ELANOUS_SEAT?.trim() || who;
      const seat = resolveSeat(seatHint)?.id;
      if (process.env.ELANOUS_SEAT?.trim() && !seat) throw new Error(`unknown ELANOUS_SEAT: ${process.env.ELANOUS_SEAT.trim()}`);
      if (seat && seat !== 'OP') {
        const recommendation = 'skipped' in validated.recommendation ? `권고 생략: ${validated.recommendation.reason}` : `권고: ${validated.recommendation.option} — ${validated.recommendation.why}`;
        const body = [
          `대표 결정 제안: ${validated.title}`,
          `분류: ${validated.category}`,
          `S: ${validated.scqa.s}`,
          `C: ${validated.scqa.c}`,
          ...(validated.scqa.q ? [`Q: ${validated.scqa.q}`] : []),
          ...(validated.scqa.a ? [`A: ${validated.scqa.a}`] : []),
          `판단 재료: ${validated.pendingQuestion}`,
          `선택지: ${validated.options.map(option => `${option.key.toUpperCase()}) ${option.label} — ${option.consequence}`).join(' · ')}`,
          recommendation,
          ...(validated.crossCheck?.length ? [`교차 확인: ${validated.crossCheck.map(check => `${check.seat} — ${check.note}`).join(' · ')}`] : []),
          ...(o.noXcheck !== undefined ? [`교차 확인 생략 이유: ${validated.crossCheckSkipped}`] :
            validated.crossCheckSkipped ? ['교차 확인: 미제공'] : []),
          ...(validated.alternative ? [`대안: ${validated.alternative}`] : []),
          ...(validated.dissent ? [`이견: ${validated.dissent}`] : []),
          ...(validated.refs?.length ? [`근거 참조: ${validated.refs.join(' · ')}`] : []),
          ...(validated.resume ? [`재개 연결: questionId=${validated.resume.questionId}${validated.resume.runId ? ` · runId=${validated.resume.runId}` : ''}`] : []),
          ...(validated.resume ? [`후속 처리: OP 결정 카드에 --resume-question ${validated.resume.questionId}${validated.resume.runId ? ` --run ${validated.resume.runId}` : ''}를 전달해 대기 런에 답을 기록`] : []),
          ...(validated.dueAt ? [`기한: ${validated.dueAt}`] : []),
          ...((validated.raisedBy.track || validated.raisedBy.session) ? [`발신 맥락: track=${validated.raisedBy.track ?? '-'} · session=${validated.raisedBy.session ?? '-'}`] : []),
        ].join('\n');
        const store = openMsgStore(join(config.stateDir ?? elanousStateRoot(), 'msg', 'messages.db'));
        try {
          const message = store.append({ from: seat, to: 'OP', kind: 'question', body });
          recordAction({ kind: 'decision', verb: 'propose', by: seat, to: 'OP', ref: `msg:${message.id}`, why: validated.title, source: 'decisions' });
          return emit({ routedTo: 'OP', messageId: message.id, body }, o.json, `OP 우편으로 제안 전달: #${message.id}`);
        } finally { store.close(); }
      }
      const entry = new DecisionLedger(config).raise(validated);
      recordAction({ kind: 'decision', verb: 'raise', by: seat ?? actorSeat(who), ref: entry.id, why: validated.title, source: 'decisions' });
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
      recordAction({ kind: 'decision', verb: 'record', by: o.seat, ref: entry.id, why: o.title, source: 'decisions' });
      return emit(entry, o.json, formatSeatDecisionRow(entry));
    }));
  // DECISION-TO-BUS-AUTO — Claude OP's one line: record a CEO decision once (ledger = the effect) → the HQ bus pointer follows.
  root.command('crown <summary...>').description('\u{1F451} 결정 한 줄 기록 — 원장(효력) 한 줄 ⊕ HQ 맥락 버스 포인터 자동 (같은 원문·시각 재실행 = 그대로)')
    .requiredOption('--quote <text>', '\u{1F451} 원문 그대로').option('--at <when>', '결정 시각 UTC ISO (기본 지금)').option('--doc <path>', '정본 문서 경로 (예: docs/conductor/X.md §8b)')
    .option('--category <category>', '기본 other')
    // ELN-OP-CROWN-MEMORY — a directive that binds seats: eln OP's assign / owner handoff is checked against it until it expires.
    .option('--seat <SEAT>', '지시 대상 자리 (반복 · 그 자리의 손 포함)', repeat, [] as string[])
    .option('--only <pattern>', '대상 자리가 가질 수 있는 칸 (정확한 id 또는 접두 DOCS-* · 반복)', repeat, [] as string[])
    .option('--never <pattern>', '대상 자리에게 주면 안 되는 칸 (반복)', repeat, [] as string[])
    .option('--until <when>', '지시 만료 UTC ISO 또는 +Nh (기본 = 정책 default_expiry_h)')
    .option('--json').option('--hq-override')
    .action((summary: string[], o: { quote: string; at?: string; doc?: string; category?: DecisionCategory; seat: string[]; only: string[]; never: string[]; until?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (!mayWrite('crown', o.hqOverride)) return;
      const at = new Date(o.at?.trim() ? o.at.trim() : (config.now?.() ?? new Date()).toISOString());
      if (!Number.isFinite(at.getTime())) throw new Error(`invalid --at: ${o.at}`);
      const seat = actorSeat(process.env.AI_AGENT?.trim() || 'CLAUDE-OP');
      if (!o.seat.length && (o.only.length || o.never.length || o.until)) throw new Error('--only/--never/--until need --seat <SEAT>');
      const until = o.until ? new Date(dueAt(o.until)) : undefined;
      if (until && !Number.isFinite(until.getTime())) throw new Error(`invalid --until: ${o.until}`);
      const directive = o.seat.length ? { seats: o.seat.map(s => s.trim().toUpperCase()), only: o.only, never: o.never, ...(until ? { until: until.toISOString() } : {}) } : null;
      const { input, ref, note, source } = crownRecordInput({ summary: summary.join(' '), quote: o.quote, at: at.toISOString(), ...(o.doc ? { doc: o.doc } : {}), seat, ...(o.category ? { category: o.category } : {}), directive });
      const ledger = new DecisionLedger(config);
      const existing = ledger.list({ status: 'all' }).find(e => e.refs?.includes(ref));
      const entry = existing ?? ledger.importRecorded(input, undefined, { kind: 'imported', source }, note);
      if (!existing) recordAction({ kind: 'decision', verb: 'record', by: seat, ref: entry.id, why: entry.title, source: 'decisions' });
      const bus = pointDecisionToBus(config.stateDir ?? elanousStateRoot(), entry, BUS_HQ_SPACE, BUS_COORDINATOR_SEAT, (config.now?.() ?? new Date()).getTime());
      const busLine = bus?.kind === 'posted' ? `버스 ${bus.entry.id} @${BUS_HQ_SPACE}` : bus ? `버스 이미 있음 ${bus.id}` : '버스 실패 — 다음 decision-bus 틱이 다시 올린다';
      return emit({ entry, existing: !!existing, bus }, o.json, `${existing ? '이미 기록됨' : '기록'}: ${entry.id} · ${entry.title} · ${busLine}`);
    }));
  root.command('seat-report').description('밤사이 자리들의 사후 결정을 한 번에 조회 (기본 최근 24시간)')
    .option('--since <date>', '조회 시작 UTC ISO 또는 Nd', '1d').option('--seat <OP|MK|TC|UX>').option('--json')
    .action((o: { since: string; seat?: Seat; json?: boolean }) => fail(() => {
      const rows = new DecisionLedger(config).seatReport({ since: decisionListSince(o.since), seat: o.seat });
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
      const ledger = new DecisionLedger(config);
      const filters = { status: o.status, since: decisionListSince(o.since), version: o.version, decidedBy: o.decidedBy, category: o.category };
      const { since, ...stableFilters } = filters;
      const cachedRows = readQueryCache({ root: join(dirname(ledger.path), '..', 'cache', 'cli-read-query'),
        key: { command: 'decisions-list', filters: { ...stableFilters, since: o.since ?? null } }, sourcePaths: [ledger.path], ttlMs: 500,
        load: () => ledger.list(stableFilters) });
      const rows = filterDecisionListSince(cachedRows, since);
      return emit(rows, o.json, rows.length ? rows.map(formatDecisionRow).join('\n') : '결정 0건');
    }));
  root.command('show <id>').description('SCQA · 선택지 · 권고 · 이력 · 판').option('--json')
    .action((id: string, o: { json?: boolean }) => fail(() => { const entry = new DecisionLedger(config).show(id); return emit(entry, o.json, formatDecisionDetail(entry)); }));
  root.command('decide <id> <option>').description('AUTO 위임 결정 기록 · 사람 결정은 대역 밖 신원 확인 필요')
    .option('--note <text>').option('--auto').option('--delegation <reason>').option('--track <track>').option('--agent <agent>').option('--json').option('--hq-override')
    .action((id: string, choice: string, o: { note?: string; auto?: boolean; delegation?: string; track?: DecisionTrack; agent?: string; json?: boolean; hqOverride?: boolean }) => fail(() => {
      if (o.auto && !o.delegation?.trim()) throw new Error('--auto requires --delegation');
      if (!o.auto && (o.delegation || o.track || o.agent)) throw new Error('delegation/track/agent require --auto');
      if (!o.auto) throw new Error(HUMAN_DECIDE_REFUSED);
      const by = { kind: 'auto' as const, origin: 'automation' as const, agent: agent(o.agent), delegation: o.delegation!, ...(o.track ? { track: o.track } : {}) };
      if (!mayWrite('decide', o.hqOverride)) return;
      const { entry, delivery, notice } = new DecisionLedger(config).decideWithDelivery(id, choice, by, o.note);
      recordAction({ kind: 'decision', verb: 'decide', by: actorSeat(by.agent), ref: entry.id, why: `${choice}${o.note ? ` · ${o.note}` : ''}`, source: 'decisions' });
      const failures = [
        ...(delivery && !delivery.ok ? [`⚠ 답 전달 실패(${delivery.questionId} · ${delivery.reason}) — 결정은 기록됐다 · 다시: elanous decisions retry-answer ${entry.id}`] : []),
        ...(notice.status === 'failed' ? [`⚠ 자리 우편 실패(${notice.seat} · ${notice.reason}) — 결정은 기록됐다 · 다시: elanous decisions retry-notify ${entry.id}`] : []),
      ];
      if (failures.length) {
        process.exitCode = 3;
        return emit({ ...entry, ...(delivery ? { delivery } : {}), notice }, o.json, `결정: ${formatDecisionDetail(entry)}\n${failures.join('\n')}`);
      }
      const noticeStatus = notice.status === 'sent' ? `\n자리 우편: ${notice.seat} #${notice.messageId}`
        : notice.status === 'skipped' ? '\n자리 우편: 올린 자리 없음 — 우편 대상 없음' : '';
      return emit({ ...entry, ...(delivery ? { delivery } : {}), notice }, o.json, `결정: ${formatDecisionDetail(entry)}${noticeStatus}`);
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
  const proofLine = (id: string, c: HumanProofCheck | null): string => !c ? `human 결정 ${id}: 증명 대상 아님`
    : c.ok ? `human 결정 ${id}: 증명 확인(${c.keyId})` : `human 결정 ${id}: 증명 미확인(reason=${c.reason}${c.keyId ? ` · ${c.keyId}` : ''})`;
  root.command('verify [id]').description('결정 원장 사슬 검증 · 대역 밖 사람 증명 재확인 (id 를 주면 그 결정만 · 사슬 파손·미확인 증명 시 exit 1)')
    .option('--json')
    .action((id: string | undefined, o: { json?: boolean }) => fail(() => {
      const led = new DecisionLedger(config);
      const chain = led.verifyChain();
      const roots = readDecisionTrustRoots(config.stateDir ?? elanousStateRoot());
      const all = led.list({ status: 'all' });
      const humans = id ? [led.show(id)] : all.filter(e => e.decidedBy?.kind === 'human');
      // RELEASE-HUMAN-PROOF-TRUST-ROOT: the reason code is printed as-is (no-proof · no-roots · unknown-key · bad-sig · …).
      const proofs = humans.map(e => {
        const checks = (e.refs ?? []).map(ref => checkHumanApprovalProof(e, ref, roots));
        const check = checks.find(c => c.ok) ?? checks[0] ?? (e.decidedBy?.kind === 'human' ? checkHumanApprovalProof(e, '', roots) : null);
        return { id: e.id, via: e.decidedBy?.kind === 'human' ? e.decidedBy.via ?? null : null, proof: check, ...(e.proof ? { keyId: e.proof.keyId } : {}) };
      });
      const unverified = proofs.filter(p => p.proof !== null && !p.proof.ok);
      if (!chain.ok || unverified.length) process.exitCode = 1; // a broken chain fails a single-id check too (Terra r1)
      return emit({ chain, trustRoots: roots.length, proofs }, o.json,
        `사슬 ${chain.ok ? '양호' : '파손'}${chain.problems.length ? ` · ${chain.problems.join(' · ')}` : ''} · 과거(무사슬) 행 ${chain.legacy} · 신뢰 뿌리 ${roots.length}개\n` +
        (proofs.length ? proofs.map(p => proofLine(p.id, p.proof)).join('\n') : 'human 결정 0건'));
    }));
  root.command('sign-approval').description('대역 밖 승인 서명(elanous-approval/v2) — 사람 키 장치에서만 실행 (개인 키는 우편·보고에 올리지 않는다)')
    .requiredOption('--ref <approvalRef>', '서명할 승인 묶음 참조 (release-critpath/<v>/<cut>/<notesSha>)')
    .requiredOption('--card <id>', '결정 카드 id').requiredOption('--raised-at <iso>', '카드 raisedAt')
    .requiredOption('--choice <key>').requiredOption('--via <via>').requiredOption('--platform-user <id>')
    .requiredOption('--key <private-pem>', '사람 개인 키 PEM 경로')
    .option('--json')
    .action((o: { ref: string; card: string; raisedAt: string; choice: string; via: string; platformUser: string; key: string; json?: boolean }) => fail(() => {
      const payload = approvalProofPayload({ ref: o.ref, cardId: o.card, raisedAt: o.raisedAt, choice: o.choice, via: o.via, platformUserId: o.platformUser });
      const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), createPrivateKey(readFileSync(o.key, 'utf8'))).toString('hex');
      return emit({ ref: o.ref, card: o.card, sig }, o.json, `ref: ${o.ref}\ncard: ${o.card}\nsig: ${sig}`);
    }));
  // RELEASE-HUMAN-PROOF-TRUST-ROOT ④ — the release approval signer. status is read-only; rotate/revoke only from a person's terminal.
  const signer = root.command('signer').description('발행 승인 서명 키(nexus · TG 봇 주인) — status · rotate · revoke(사람 터미널만)');
  const seams = config.signer ?? {};
  const signerOpts = () => ({ stateDir: config.stateDir, ...(seams.ownerLedgerPath ? { ownerLedgerPath: seams.ownerLedgerPath } : {}), ...(seams.host ? { host: seams.host } : {}) });
  const personTerminal = async (command: string): Promise<{ ok: true } | { ok: false; line: string }> => {
    if (seams.terminal) return seams.terminal();
    const { humanTerminalPreflight, defaultProcLookup, defaultProcMeta } = await import('../proxy/proxy-identity.js');
    const pre = humanTerminalPreflight({ selfPid: process.pid, stdinIsTTY: process.stdin.isTTY === true, lookup: defaultProcLookup(), meta: defaultProcMeta(), command });
    return pre.ok ? { ok: true } : { ok: false, line: pre.line };
  };
  const confirmCode = async (prompt: string): Promise<boolean> => {
    const { grantConfirmCode } = await import('../proxy/proxy-identity.js');
    const code = grantConfirmCode();
    const ask = seams.ask ?? (async (p: string) => {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try { return await new Promise<string>((resolve) => rl.question(p, resolve)); } finally { rl.close(); }
    });
    return (await ask(`${prompt}\nType ${code} to continue: `)).trim().toUpperCase() === code;
  };
  const signerNotice = (line: string) => {
    try {
      if (seams.notify) return seams.notify(line);
      const store = openMsgStore(join(config.stateDir ?? elanousStateRoot(), 'msg', 'messages.db'));
      try { store.post({ from: 'RELEASE-PROOF', to: 'OP', kind: 'info', body: line }); } finally { store.close(); }
    } catch { /* the signer audit row is the record */ }
  };
  signer.command('status').description('서명 키 상태 (키 내용은 출력하지 않는다)').option('--json')
    .action((o: { json?: boolean }) => fail(async () => {
      const { signerStatus, signerKeyMode, signerPaths } = await import('../decisions/approval-signer.js');
      const status = signerStatus(signerOpts());
      const mode = signerKeyMode(config.stateDir ?? elanousStateRoot());
      const paths = signerPaths(config.stateDir ?? elanousStateRoot());
      const row = { ...status, keyMode: mode ? { dir: mode.dir.toString(8), key: mode.key.toString(8) } : null, trustRoot: paths.trustRoot };
      return emit(row, o.json, `서명자 ${status.state}${status.keyId ? ` · ${status.keyId}` : ''} · 신뢰 뿌리 ${status.roots}개 · 주인 ${status.ownerHost ?? '미등록'}${mode ? ` · 권한 ${mode.dir.toString(8)}/${mode.key.toString(8)}` : ''}${status.detail ? ` · ${status.detail}` : ''}`);
    }));
  signer.command('rotate').description('새 키로 교체 — 옛 keyId 는 신뢰 뿌리에 남아 과거 증명을 계속 확인한다 (사람 터미널만)')
    .action(() => fail(async () => {
      const gate = await personTerminal('eln decisions signer rotate');
      if (!gate.ok) { process.exitCode = 1; return emit(null, false, gate.line); }
      if (!(await confirmCode('Rotate the release approval signer? A new key signs from now; old proofs keep verifying.'))) { process.exitCode = 1; return emit(null, false, 'eln decisions signer rotate: not rotated (code mismatch)'); }
      const { rotateApprovalSigner } = await import('../decisions/approval-signer.js');
      const r = rotateApprovalSigner(signerOpts());
      signerNotice(`[release.proof] 서명 키 회전 · 새 ${r.keyId}${r.previous ? ` · 옛 ${r.previous}(뿌리에 남김)` : ''}`);
      return emit(r, false, `rotated → ${r.keyId}${r.previous ? ` (previous ${r.previous} kept in the trust root)` : ''}`);
    }));
  signer.command('revoke <keyId>').description('keyId 를 신뢰 뿌리에서 지운다 — 그 키의 증명은 더 확인되지 않는다 (사람 터미널만)')
    .action((keyId: string) => fail(async () => {
      const gate = await personTerminal('eln decisions signer revoke');
      if (!gate.ok) { process.exitCode = 1; return emit(null, false, gate.line); }
      if (!(await confirmCode(`Revoke ${keyId}? Proofs signed by it stop verifying.`))) { process.exitCode = 1; return emit(null, false, 'eln decisions signer revoke: not revoked (code mismatch)'); }
      const { revokeApprovalSigner } = await import('../decisions/approval-signer.js');
      const r = revokeApprovalSigner(keyId, signerOpts());
      if (!r.revoked) { process.exitCode = 1; return emit(r, false, `${keyId}: not in the trust root`); }
      signerNotice(`[release.proof] 서명 키 폐기 · ${keyId}${r.deletedPrivateKey ? ' · 개인 키 삭제' : ''}`);
      return emit(r, false, `revoked ${keyId}${r.deletedPrivateKey ? ' (private key deleted)' : ''}`);
    }));
  // RELEASE-PRESIGNED-AUTO — the CEO's pre-authorization card (kit/release-preauth): raise · list · revoke.
  // The signature comes only from the owner's TG/PWA tap (two-step confirm · nexus signer); this CLI never signs.
  const preauth = root.command('preauth').description('발행 사전 승인(대표가 미리 서명) — raise · list · revoke · 서명은 TG/PWA 소유자 탭만');
  const preauthState = () => config.stateDir ?? elanousStateRoot();
  preauth.command('raise').description('사전 승인 카드를 올린다 — 판 · 모드(auto|surgery) · 창(기본 = 다음 발행 시각 ±정책 분) · 조건은 정책 YAML')
    .requiredOption('--version <x.y.z>').requiredOption('--mode <auto|surgery>').option('--from <iso>').option('--to <iso>').option('--json').option('--hq-override')
    .action((o: { version: string; mode: string; from?: string; to?: string; json?: boolean; hqOverride?: boolean }) => fail(async () => {
      if (!mayWrite('preauth raise', o.hqOverride)) { process.exitCode = 1; return; }
      const { loadPreAuthPolicy, raisePreAuth } = await import('../kit/release-preauth/index.js');
      const { getSchedule } = await import('../release-loop/release-schedule.js');
      let publishAt: string | null = null;
      try { publishAt = getSchedule(o.version)?.publishAt ?? null; } catch { publishAt = null; }
      const r = raisePreAuth(new DecisionLedger(config), loadPreAuthPolicy(), { version: o.version, mode: o.mode as 'auto' | 'surgery', from: o.from, to: o.to, publishAt, now: new Date(), raisedBy: 'release-preauth' });
      return emit(r, o.json, `${r.id} · ${r.status} · ${r.ref} — 대표가 TG/PWA 에서 A → 확인을 누르면 서명된다`);
    }));
  preauth.command('list').description('사전 승인 카드와 지금 상태(서명 대기 · 예정 · 활성 · 사용됨 · 취소 · 만료)').option('--version <x.y.z>').option('--json')
    .action((o: { version?: string; json?: boolean }) => fail(async () => {
      const { listPreAuth, formatPreAuthRow, readPreAuthUses, readPreAuthRevocations } = await import('../kit/release-preauth/index.js');
      const rows = listPreAuth({ records: new DecisionLedger(config).list({ status: 'all' }), trustRoots: readDecisionTrustRoots(preauthState()),
        uses: readPreAuthUses(preauthState()), revocations: readPreAuthRevocations(preauthState()), now: new Date(), ...(o.version ? { version: o.version } : {}) });
      return emit(rows, o.json, rows.length ? rows.map(formatPreAuthRow).join('\n') : '사전 승인 없음');
    }));
  preauth.command('revoke <id>').description('사전 승인 취소 — 권한을 줄이기만 하므로 누구나 · 언제든').requiredOption('--reason <text>').option('--json').option('--hq-override')
    .action((id: string, o: { reason: string; json?: boolean; hqOverride?: boolean }) => fail(async () => {
      if (!mayWrite('preauth revoke', o.hqOverride)) { process.exitCode = 1; return; }
      const { revokePreAuth } = await import('../kit/release-preauth/index.js');
      const r = revokePreAuth(preauthState(), id, process.env.ELANOUS_TRACK ? `cli:${process.env.ELANOUS_TRACK}` : 'cli', o.reason, new Date());
      return emit({ id, ...r }, o.json, `${id} ${r.already ? '이미 취소됨' : '취소됨'}`);
    }));
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
