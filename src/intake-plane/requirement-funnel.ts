import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { normalizeClaim, type AddBriefItem } from '../briefing/brief-items.js';
import { createRequire } from 'node:module';
import { debug } from '../debug/log.js';
import { listChecklist, setItem, type ChecklistItem } from '../release-loop/checklist.js';
import { placeCell, type PlacementDeps } from '../release-loop/placement.js';
import { listSchedules } from '../release-loop/release-schedule.js';
import { getUserConfig } from '../user-config.js';
import { dateKey } from '../time/format.js';
import { cardIndexPath, CardStore, type TaskCard } from '../task-cards/card-store.js';
import { loadIntakeLedger, type IntakeItem } from './items.js';
import { parseRubric, rubricGrade, rubricScore } from '../release-loop/rubric.js';

export type RequirementSource = 'directive' | 'intake' | 'grounding' | 'coordination' | 'linear';
export interface RequirementCandidate {
  id: string;
  source: RequirementSource;
  text: string;
  link: string;
  receivedAt: string;
  priority?: 'P0' | 'P1' | 'P2';
  risk?: number;
  cost?: number;
  security?: number;
  license?: string;
  patentPrivatePath?: boolean;
  owner?: string;
  deadlineVersion?: string;
}
export type IncomingRequirement = Omit<RequirementCandidate, 'source'>;
export interface RequirementSources {
  directives?: readonly DirectiveRow[];
  intake?: readonly IntakeItem[];
  grounding?: readonly IncomingRequirement[];
  coordination?: readonly IncomingRequirement[];
  linear?: readonly IncomingRequirement[];
}
export interface RequirementDecision {
  candidate: RequirementCandidate;
  sources: RequirementCandidate[];
  status: 'adopted' | 'would-adopt' | 'proposal';
  cellId?: string;
  version?: string;
  rubric: string;
  reason?: string;
}
export interface RequirementFunnelResult {
  counts: Record<RequirementSource, number>;
  candidates: number;
  decisions: RequirementDecision[];
  unlinkedDirectives: RequirementCandidate[];
  briefItems: AddBriefItem[];
}
export interface FunnelOptions {
  sources: RequirementSources;
  /** Older directives are only checked for unlinked P0 backlog, not counted as today's arrivals. */
  historicalDirectives?: readonly DirectiveRow[];
  cells: readonly { version: string; item: ChecklistItem }[];
  now: Date;
  mode?: 'shadow' | 'live';
  /** Required for live external adoption; the unresolved daily limit has no implicit value. */
  dailyCap?: number;
  adoptedToday?: number;
  allowedLicenses?: readonly string[];
  placement?: PlacementDeps;
  adopt?: (candidate: RequirementCandidate, version: string, cellId: string, evidence: string) => void;
}

/** How many of the last 24 hours' unlinked directives the single P0 brief line names (the full backlog is one count). */
export const UNLINKED_DIRECTIVES_SHOWN = 5;
/** ABSORB-ADOPT daily limit when config sets none (OP 10-06 22:59 · the cell's own number). */
export const DEFAULT_DAILY_CAP = 5;
/** Directive row fields the funnel reads — kept local because `src/directives/directive-index` is excluded from the public export. */
export interface DirectiveRow { ts: string; track: string | null; text: string; source_file: string; line_no: number }

/** Loads the private directive index at run time only (same pattern as decisions/proact-meter), so public builds bundle cleanly. */
function openDirectiveIndex(stateDir: string): { dailyRequirements(since: string, until: string): DirectiveRow[]; close(): void } {
  const spec = ['..', 'directives', 'directive-index.js'].join('/');
  const mod = createRequire(import.meta.url)(spec) as { DirectiveIndex: new (o: { stateDir?: string }) => ReturnType<typeof openDirectiveIndex> };
  return new mod.DirectiveIndex({ stateDir });
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
const idFor = (source: RequirementSource, key: string) => createHash('sha256').update(`${source}:${key}`).digest('hex').slice(0, 16);

export function directiveCandidates(rows: readonly DirectiveRow[]): RequirementCandidate[] {
  return rows.map(row => ({ id: idFor('directive', `${row.source_file}:${row.line_no}`), source: 'directive',
    text: oneLine(row.text), link: `${row.source_file}#L${row.line_no}`, receivedAt: row.ts,
    priority: 'P2', owner: row.track && /^[A-Z]{2,8}$/.test(row.track) ? row.track : 'OP' }));
}
export function intakeCandidates(rows: readonly IntakeItem[]): RequirementCandidate[] {
  return rows.map(row => ({ id: row.id, source: 'intake', text: oneLine(row.text || row.title || ''),
    link: row.url || `intake:${row.id}`, receivedAt: row.observedAt }));
}
export function suppliedCandidates(source: 'grounding' | 'coordination' | 'linear', rows: readonly IncomingRequirement[]): RequirementCandidate[] {
  return rows.map(row => ({ ...row, source, text: oneLine(row.text) }));
}

function linkFor(candidate: RequirementCandidate, cells: FunnelOptions['cells']): FunnelOptions['cells'][number] | undefined {
  return cells.find(({ item }) => !!candidate.link && !!item.evidence && item.evidence.includes(candidate.link));
}
function gate(candidate: RequirementCandidate, options: FunnelOptions, used: number): string | null {
  if (candidate.priority !== 'P1' && candidate.priority !== 'P2') return 'P1/P2 판정 없음';
  if (candidate.priority === 'P1' && !candidate.deadlineVersion) return 'P1 마감 판 미확인';
  if (candidate.risk === undefined || !Number.isFinite(candidate.risk) || candidate.risk > 1 || candidate.risk < 0) return '위험≤1 미확인';
  if (candidate.cost !== 0) return '돈 0 미확인';
  if (candidate.security !== 0) return '보안 0 미확인';
  if (!candidate.license || !options.allowedLicenses?.includes(candidate.license)) return '허용 라이선스 미확인';
  if (candidate.patentPrivatePath !== false) return '특허 비공개 경로 무접촉 미확인';
  if (options.dailyCap === undefined || !Number.isSafeInteger(options.dailyCap) || options.dailyCap < 0) return '하루 상한 미설정';
  if (used >= options.dailyCap) return '하루 상한 도달';
  return null;
}

/** RUBRIC-PLACE: use the release placement engine's priority, deadline, capacity and predecessor checks, not an invented score. */
export function runRequirementFunnel(options: FunnelOptions): RequirementFunnelResult {
  const { sources, cells, now } = options;
  const arrivals = [
    ...directiveCandidates(sources.directives ?? []), ...intakeCandidates(sources.intake ?? []),
    ...suppliedCandidates('grounding', sources.grounding ?? []),
    ...suppliedCandidates('coordination', sources.coordination ?? []),
    ...suppliedCandidates('linear', sources.linear ?? []),
  ].filter(candidate => candidate.text && Number.isFinite(Date.parse(candidate.receivedAt)) && Date.parse(candidate.receivedAt) <= now.getTime());
  const counts: RequirementFunnelResult['counts'] = { directive: 0, intake: 0, grounding: 0, coordination: 0, linear: 0 };
  for (const candidate of arrivals) counts[candidate.source]++;
  const groups = new Map<string, RequirementCandidate[]>();
  for (const candidate of arrivals) {
    const key = normalizeClaim(candidate.text);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const decisions: RequirementDecision[] = [];
  let used = options.adoptedToday ?? 0;
  for (const members of groups.values()) {
    members.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const candidate = members.find(member => member.source === 'directive') ?? members[0]!;
    const linked = members.map(member => linkFor(member, cells)).find(Boolean);
    const evidence = members.map(member => `${member.link} (${member.receivedAt})`).join(' · ');
    if (linked) {
      decisions.push({ candidate, sources: members, status: 'adopted', cellId: linked.item.id, version: linked.version,
        rubric: `RUBRIC-PLACE ${linked.item.priority ?? '미지정'} · ${linked.version}` });
      continue;
    }
    const isDirective = members.some(member => member.source === 'directive');
    const reason = isDirective ? null : gate(candidate, options, used);
    if (reason) {
      decisions.push({ candidate, sources: members, status: 'proposal', reason, rubric: `ABSORB-ADOPT · ${reason}` });
      continue;
    }
    const cellId = candidate.id;
    const priority = candidate.priority ?? 'P1';
    const rubricInput = { id: cellId, title: candidate.text, owner: candidate.owner ?? 'OP', priority,
      predecessors: [], ...(priority === 'P1' && candidate.deadlineVersion ? { deadlineVersion: candidate.deadlineVersion } : {}) };
    let placement: ReturnType<typeof placeCell>;
    try { placement = placeCell(rubricInput, { ...options.placement, now, dryRun: true }); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      decisions.push({ candidate, sources: members, status: isDirective ? 'would-adopt' : 'proposal', reason,
        rubric: `RUBRIC-PLACE · 판 배치 보류: ${reason}` });
      continue;
    }
    const rubric = `RUBRIC-PLACE ${priority} · ${placement.version}: ${placement.reason}`;
    if (options.mode === 'live') {
      if (!options.adopt) throw new Error('편입 기록자가 설정되지 않았다');
      options.adopt(candidate, placement.version, cellId, evidence);
    }
    decisions.push({ candidate, sources: members, status: options.mode === 'live' ? 'adopted' : 'would-adopt',
      cellId, version: placement.version, rubric });
    if (!isDirective) used++;
  }
  const unlinkedDirectives = [...directiveCandidates(options.historicalDirectives ?? []).filter(candidate =>
    candidate.text && Number.isFinite(Date.parse(candidate.receivedAt)) && Date.parse(candidate.receivedAt) <= now.getTime()
    && !linkFor(candidate, cells) && !arrivals.some(arrival => arrival.id === candidate.id)),
    ...decisions.filter(decision => decision.status !== 'adopted')
      .flatMap(decision => decision.sources.filter(source => source.source === 'directive'))]
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const briefItems: AddBriefItem[] = [];
  const summary = `들어온 요구 ${groups.size}(문별 지시 ${counts.directive} · 흡수 ${counts.intake} · 그라운딩 ${counts.grounding} · 조율 ${counts.coordination} · Linear ${counts.linear}) · 편입 ${decisions.filter(d => d.status === 'adopted').length} · 했을 것 ${decisions.filter(d => d.status === 'would-adopt').length} · 제안 ${decisions.filter(d => d.status === 'proposal').length}`;
  if (arrivals.length || unlinkedDirectives.length) briefItems.push({ text: summary, domain: '흡수', priority: 'P1', source: 'requirement-funnel' });
  for (const decision of decisions) {
    const { candidate } = decision;
    const status = decision.status === 'adopted' ? `편입 ${decision.cellId} · 판 ${decision.version}`
      : decision.status === 'would-adopt' ? decision.version ? `했을 것 ${decision.cellId} · 판 ${decision.version}` : '편입 대상 · 판 배치 대기'
        : `제안: ${decision.reason}`;
    briefItems.push({ text: `${status} · ${candidate.text} · ${decision.rubric}`, domain: decision.status === 'proposal' ? '흡수' : '판',
      priority: 'P1', source: 'requirement-funnel', evidence: decision.sources.map(member => `${member.link} (${member.receivedAt})`).join(' · ') });
  }
  // OP 10-06 22:59: the backlog can hold the whole directive history, so only the last 24 hours get named (one P0 line);
  // the full backlog is a single count. Nothing recent → the count alone, at P1, so history cannot flood the brief.
  if (unlinkedDirectives.length) {
    const recent = unlinkedDirectives.filter(directive => now.getTime() - Date.parse(directive.receivedAt) <= 24 * 3_600_000);
    const named = recent.slice(0, UNLINKED_DIRECTIVES_SHOWN);
    const rest = recent.length - named.length;
    const total = `전체 누계 ${unlinkedDirectives.length}`;
    briefItems.push(recent.length
      ? { text: `대표 지시 중 아직 칸 없는 것 — 최근 24시간 ${recent.length}: ${named.map(directive => `${directive.text} (${directive.receivedAt})`).join(' · ')}${rest > 0 ? ` · 외 ${rest}` : ''} · ${total}`,
        domain: '판', priority: 'P0', source: 'requirement-funnel', evidence: named.map(directive => directive.link).join(' · ') }
      : { text: `대표 지시 중 아직 칸 없는 것 — 최근 24시간 0 · ${total}`, domain: '판', priority: 'P1', source: 'requirement-funnel' });
  }
  return { counts, candidates: groups.size, decisions, unlinkedDirectives, briefItems };
}

/** Existing ledgers only; no source collector or sender is started here. */
export function readRequirementFunnel(options: { stateDir?: string; now?: Date; mode?: 'shadow' | 'live'; dailyCap?: number;
  allowedLicenses?: readonly string[]; grounding?: readonly IncomingRequirement[]; coordination?: readonly IncomingRequirement[];
  linear?: readonly IncomingRequirement[]; placement?: PlacementDeps } = {}): RequirementFunnelResult {
  const stateDir = options.stateDir ?? elanousStateRoot();
  const now = options.now ?? new Date();
  const config = (getUserConfig().raw.intake as { requirementFunnel?: { mode?: 'shadow' | 'live'; dailyCap?: number; allowedLicenses?: string[] } } | undefined)?.requirementFunnel;
  const mode = options.mode ?? config?.mode ?? 'shadow';
  if (mode !== 'shadow' && mode !== 'live') throw new Error(`알 수 없는 요구 깔때기 모드: ${mode}`);
  const dailyCap = options.dailyCap ?? config?.dailyCap ?? DEFAULT_DAILY_CAP;
  const allowedLicenses = options.allowedLicenses ?? config?.allowedLicenses;
  let directives: DirectiveRow[] = [];
  let historicalDirectives: DirectiveRow[] = [];
  const since = new Date(Date.parse(`${dateKey(now, { timeZone: 'Asia/Seoul' })}T00:00:00+09:00`)).toISOString();
  try {
    const index = openDirectiveIndex(stateDir);
    try {
      directives = index.dailyRequirements(since, now.toISOString());
      historicalDirectives = index.dailyRequirements('1970-01-01T00:00:00.000Z', since);
    } finally { index.close(); }
  } catch (error) {
    // Public builds have no directive index; the other doors still report.
    debug.log('intake.requirement-funnel', 'directives-unavailable', { error: error instanceof Error ? error.message : String(error) });
  }
  const schedules = listSchedules();
  const cells = schedules.flatMap(schedule => listChecklist(schedule.version).items.map(item => ({ version: schedule.version, item })));
  const ledger = loadIntakeLedger(stateDir);
  const day = dateKey(now, { timeZone: 'Asia/Seoul' });
  const todayCount = cells.filter(({ item }) => {
    const adoptedAt = item.evidence?.match(/ABSORB-ADOPT@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/)?.[1];
    return adoptedAt && dateKey(adoptedAt, { timeZone: 'Asia/Seoul' }) === day;
  }).length;
  const cardRequests: Record<'coordination' | 'linear', IncomingRequirement[]> = { coordination: [], linear: [] };
  if (existsSync(cardIndexPath(stateDir))) {
    const cards = new CardStore(stateDir, true);
    try {
      for (const card of cards.listCards()) {
        const section = card.sections.find(entry => entry.key === 'intake');
        if (!section) continue;
        let raw: unknown;
        try { raw = JSON.parse(section.content); } catch { continue; }
        if (!raw || typeof raw !== 'object') continue;
        const input = raw as { source?: string; text?: string; ref?: string; replyTo?: { surface?: string } };
        const source = input.source === 'linear' ? 'linear' : input.source === 'coordination' ? 'coordination' : null;
        if (!source || !input.text) continue;
        cardRequests[source].push({ id: card.goalId, text: oneLine(input.text.split('\n')[0] ?? ''),
          link: input.ref || card.goalId, receivedAt: card.createdAt });
      }
    } finally { cards.close(); }
  }
  const fromQueue = (name: string): IncomingRequirement[] => {
    const path = join(stateDir, 'intake', name);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap(line => {
      if (!line.trim()) return [];
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object') return [];
        const row = value as Partial<IncomingRequirement> & { path?: string };
        const item = row.id ? ledger.items.get(row.id) : undefined;
        const text = row.text ?? item?.text ?? item?.title;
        const link = row.link ?? item?.url ?? row.path;
        const receivedAt = row.receivedAt ?? (row as { at?: string }).at ?? item?.observedAt;
        return typeof row.id === 'string' && typeof text === 'string' && typeof link === 'string' && typeof receivedAt === 'string'
          ? [{ ...row, id: row.id, text, link, receivedAt }] : [];
      } catch { return []; }
    });
  };
  // The grounding queue and the card store are cumulative; only today's rows are today's arrivals.
  const today = (rows: readonly IncomingRequirement[]) => rows.filter(row => Date.parse(row.receivedAt) >= Date.parse(since));
  return runRequirementFunnel({ sources: { directives, intake: [...ledger.items.values()].filter(item => Date.parse(item.observedAt) >= Date.parse(since)),
    grounding: today(options.grounding ?? fromQueue('outbox/grounding.jsonl')),
    coordination: today(options.coordination ?? cardRequests.coordination), linear: today(options.linear ?? cardRequests.linear) }, historicalDirectives, cells, now, mode,
    dailyCap, adoptedToday: todayCount, allowedLicenses, placement: { ...options.placement, schedules },
    adopt: (candidate, version, cellId, evidence) => {
      placeCell({ id: cellId, title: candidate.text, owner: candidate.owner ?? 'OP', priority: candidate.priority ?? 'P1',
        predecessors: [], ...(candidate.deadlineVersion ? { deadlineVersion: candidate.deadlineVersion } : {}) }, { ...options.placement, now, schedules });
      setItem(version, cellId, { evidence: `${evidence} · ABSORB-ADOPT@${now.toISOString()}` }, 'OP');
    } });
}

// ── `intake candidates` — 읽기 전용 요구 후보 목록(지시·흡수·소원 · 명시 루브릭만 점수) ──
export interface FunnelCandidate {
  source: 'directive' | 'intake' | 'wish';
  id: string;
  title: string;
  score: number | null;
  grade: 'P1' | 'P2' | 'P3' | 'P4' | null;
}
/** The candidate list keys directives by session — the funnel's local `DirectiveRow` plus the index's `session_id`. */
export type FunnelDirectiveRow = DirectiveRow & { session_id: string };

function funnelCandidate(source: FunnelCandidate['source'], id: string, title: string, original: string): FunnelCandidate {
  const rubric = parseRubric(original);
  const score = rubric === null ? null : rubricScore(rubric);
  return { source, id, title: title.split(/\r?\n/, 1)[0]!.slice(0, 80), score, grade: score === null ? null : rubricGrade(score) };
}

export function collectFunnelCandidates({ directives, intakeItems, cards }: {
  directives: readonly FunnelDirectiveRow[];
  intakeItems: readonly IntakeItem[];
  cards: readonly TaskCard[];
}): FunnelCandidate[] {
  return [
    ...directives.map((row) => funnelCandidate('directive', `${row.session_id}:${row.line_no}`, row.text, row.text)),
    ...intakeItems.filter((item) => item.status !== 'discarded')
      .map((item) => funnelCandidate('intake', item.id, item.title ?? item.text ?? item.url ?? '', [item.title, item.text, item.url].filter(Boolean).join('\n'))),
    ...cards.filter((card) => card.status === 'open' && card.goalId.startsWith('wish:'))
      .map((card) => funnelCandidate('wish', card.goalId, card.title, card.title)),
  ].sort((a, b) => a.score === null && b.score === null ? 0
    : a.score === null ? 1 : b.score === null ? -1 : b.score - a.score);
}
