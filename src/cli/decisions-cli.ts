import type { Command } from 'commander';
import { DecisionLedger, importDecisionMarkdown, type DecisionCategory, type DecisionLedgerOptions, type DecisionOption, type DecisionTrack, type DecisionEntry } from '../decisions/decision-ledger.js';

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

export function registerDecisionsCommands(program: Command, config: DecisionLedgerOptions = {}, out: Pick<Console, 'log'> = console): void {
  const root = program.command('decisions').description('대표 결정 원장 · 로컬 전용');
  const emit = (value: unknown, json?: boolean, text?: string) => out.log(json ? JSON.stringify(value) : text ?? JSON.stringify(value));
  const fail = (action: () => void) => { try { action(); } catch (e) { throw new Error(`decisions: ${e instanceof Error ? e.message : String(e)}`); } };
  root.command('raise').description('SCQA·선택지와 권고로 결정 항목을 올린다')
    .requiredOption('--title <text>').requiredOption('--category <category>')
    .requiredOption('--s <text>').requiredOption('--c <text>').option('--q <text>').option('--a <text>')
    .requiredOption('--option <key=label:consequence>', '선택지 (두 번 이상)', repeat, [] as string[])
    .option('--recommend <key>').option('--why <text>').option('--skip-recommend <reason>')
    .option('--track <track>').option('--agent <agent>').option('--session <id>')
    .option('--ref <url>', '참조 (반복)', repeat, [] as string[])
    .option('--due <when>', '기한 — UTC ISO(2026-10-04T09:00:00Z) 또는 +Nh(지금부터 N시간) · 기한 2시간 전 텔레그램·디스코드로 다시 알린다')
    .option('--json')
    .action((o: { due?: string; title: string; category: DecisionCategory; s: string; c: string; q?: string; a?: string; option: string[]; recommend?: string; why?: string; skipRecommend?: string; track?: DecisionTrack; agent?: string; session?: string; ref: string[]; json?: boolean }) => fail(() => {
      if (o.skipRecommend !== undefined && (o.recommend !== undefined || o.why !== undefined)) throw new Error('choose recommendation or skip, not both');
      if (o.skipRecommend === undefined && (!o.recommend || !o.why)) throw new Error('--recommend and --why required, or --skip-recommend <reason>');
      const options: DecisionOption[] = o.option.map(parseOption);
      const entry = new DecisionLedger(config).raise({ title: o.title, category: o.category, scqa: { s: o.s, c: o.c, ...(o.q ? { q: o.q } : {}), ...(o.a ? { a: o.a } : {}) }, options,
        recommendation: o.skipRecommend !== undefined ? { skipped: true, reason: o.skipRecommend } : { option: o.recommend!, why: o.why! },
        raisedBy: { agent: agent(o.agent), ...(o.track ? { track: o.track } : {}), ...(o.session ? { session: o.session } : {}) }, ...(o.ref.length ? { refs: o.ref } : {}),
        ...(o.due ? { dueAt: dueAt(o.due) } : {}) });
      emit(entry, o.json, `올림: ${formatDecisionRow(entry)}`);
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
    .option('--note <text>').option('--auto').option('--delegation <reason>').option('--track <track>').option('--agent <agent>').option('--json')
    .action((id: string, choice: string, o: { note?: string; auto?: boolean; delegation?: string; track?: DecisionTrack; agent?: string; json?: boolean }) => fail(() => {
      if (o.auto && !o.delegation?.trim()) throw new Error('--auto requires --delegation');
      if (!o.auto && (o.delegation || o.track || o.agent)) throw new Error('delegation/track/agent require --auto');
      const by = o.auto ? { kind: 'auto' as const, agent: agent(o.agent), delegation: o.delegation!, ...(o.track ? { track: o.track } : {}) } : { kind: 'human' as const };
      const entry = new DecisionLedger(config).decide(id, choice, by, o.note);
      emit(entry, o.json, `결정: ${formatDecisionDetail(entry)}`);
    }));
  root.command('add-options <id>').description('선택지가 미기재된 과거 항목에 확인된 선택지를 추가')
    .requiredOption('--option <key=label:consequence>', '선택지 (두 번 이상)', repeat, [] as string[])
    .option('--agent <agent>').option('--json')
    .action((id: string, o: { option: string[]; agent?: string; json?: boolean }) => fail(() => {
      const entry = new DecisionLedger(config).addOptions(id, o.option.map(parseOption), agent(o.agent));
      emit(entry, o.json, formatDecisionDetail(entry));
    }));
  root.command('withdraw <id>').description('결정 철회도 원장에 남긴다').requiredOption('--reason <reason>').option('--json')
    .action((id: string, o: { reason: string; json?: boolean }) => fail(() => { const entry = new DecisionLedger(config).withdraw(id, o.reason); emit(entry, o.json, `철회: ${formatDecisionDetail(entry)}`); }));
  root.command('import-markdown <file>').description('기존 대표 결정 문서 씨앗을 가져온다 (재실행 안전)').option('--json')
    .action((file: string, o: { json?: boolean }) => fail(() => {
      const result = importDecisionMarkdown(new DecisionLedger(config), file);
      emit(result, o.json, `가져옴 ${result.imported.length} · 기존 ${result.existing.length} · 불완전 ${result.incomplete.length} · 못 읽음 ${result.unread.length}${result.incomplete.length ? `\n${result.incomplete.join('\n')}` : ''}${result.unread.length ? `\n${result.unread.join('\n')}` : ''}`);
      if (result.unread.length) process.exitCode = 1;
    }));
}
