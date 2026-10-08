#!/usr/bin/env bun
/**
 * RETRO-DAILY — 매일 회고 그래프(`graphs/retro/daily.yaml`)의 노드 본체.
 *
 * collect → cluster → recur → insight → act → report
 *
 * - 사실은 `elanous retro facts --since 24h --json`(RETRO-FACTS) 에서만 온다. 글은 읽지 않는다.
 * - 반복(지난 7일 회고 파일)과 «초록으로 닫은 뒤 다시 깨진 것»을 1순위로 올린다.
 * - 조치는 최대 셋, 칸 «초안 글»뿐이다 — 체크리스트에 쓰지 않는다(그림자).
 * - `retro.daily.mode` = shadow(기본) | live. shadow 는 체크리스트·메시지·브리핑 어느 것도 건드리지 않는다.
 *   live 는 day 파일에 `briefing: true` 를 찍어 08:30 데일리 리뷰가 세 줄을 싣게 한다(체크리스트 쓰기는 아직 없다).
 *
 * RFC: 내부 문서 `RFC-retro-loop-daily-weekly-insight-2026-10-07` §1 (§0 표가 첫 판의 정답지).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { getUserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';

export const RETRO_DAILY_GRAPH_ID = 'retro-daily';
export const RETRO_MAX_ACTIONS = 3;
export const RETRO_LOOKBACK_DAYS = 7;
const MAX_FACTS = 2000;

export type RetroMode = 'shadow' | 'live';
export type RetroStage = 'collect' | 'cluster' | 'recur' | 'insight' | 'act' | 'report';
export const RETRO_STAGES: readonly RetroStage[] = ['collect', 'cluster', 'recur', 'insight', 'act', 'report'];

export type RetroFactIn = { store?: string; at: string; category?: string; event?: string; kind: string; data?: unknown };
export type RetroFact = RetroFactIn & { id: string; signature: string; text: string };
/** `greenAt` = 그 칸이 마지막으로 green/done 이 된 시각(체크리스트 history). 모르면 비운다 — «모름»은 «재발 아님»으로 읽지 않는다. */
export type GreenCell = { id: string; title?: string; status: string; version?: string; greenAt?: string };

export type RetroTheme = {
  id: string;
  title: string;
  owner: string;
  /** 사실의 서명·본문에 맞는 낱말. 순서대로 처음 맞는 것이 이긴다. */
  pattern: RegExp;
  /** RFC §0 의 «한 단 위 원인» 틀. 사실이 이 틀을 «증명»하지는 않는다 — insight 가 사실 id 로 근거를 단다. */
  rootCause: string;
  falsifier: string;
};

/**
 * RFC §0 다섯 반복 문제의 서명 사전. 순서가 의미를 갖는다(조용한 실패가 draft 낱말을 같이 가져도 «조용한 실패»다).
 * 새 반복이 생기면 여기에 줄을 더한다 — 사전에 없는 서명은 `sig:<서명>` 주제로 그대로 남는다(버리지 않는다).
 */
export const RETRO_THEMES: readonly RetroTheme[] = [
  { id: 'silent-failure', title: '조용한 실패', owner: 'TC',
    pattern: /silent|조용|send-disabled|deliveryState|delivery-state|truncat|절단|no[-_ ]?alert|not[-_ ]?sent|\/tmp|log[-_ ]?only|repeated_failure/i,
    rootCause: '«돌았다»를 «일했다»로 읽는다 — 실패가 알림으로 가지 않는다',
    falsifier: '루프 failed·deliveryState≠sent 가 알림 없이 24h 넘게 이어진 수' },
  { id: 'universe-confusion', title: '우주 혼동', owner: 'TC',
    pattern: /universe|우주|test[-_ ]?instance|config-dir|empty[-_ ]?value|빈 값/i,
    rootCause: '자리 트리 = test 우주라는 기본값이 사람·에이전트 직관과 반대다',
    falsifier: 'test 우주를 읽어 «빈 값»으로 오판한 수/일' },
  { id: 'serialization', title: '직렬화 재발', owner: 'OP',
    pattern: /serial|직렬|overlap|겹침|hotPaths|hot-path|order[-_ ]?edge/i,
    rootCause: '«병렬 우선»(R-RUN17)이 규칙에는 있는데 새 도구를 만들 때 검사하지 않는다',
    falsifier: '겹침을 이유로 뺀 칸·순서 간선 수/일' },
  { id: 'unreadable-stop', title: '멈춤을 읽을 수 없음', owner: 'TC',
    pattern: /unreadable|unknown|읽을 수 없|non[-_ ]?convergen|unconvergeable|비수렴|no[-_ ]?reason/i,
    rootCause: '멈춤이 사람이 읽는 글로만 남는다 — 기계가 다음 수를 고를 어휘가 없다',
    falsifier: '멈춤 사유를 읽을 수 없는 draft 비율' },
  { id: 'draft-backlog', title: 'draft 적체', owner: 'OP',
    pattern: /draft|rework|supersede|적체|DRAFT/i,
    rootCause: '고친 것을 «초록»으로 닫고 효과를 다시 재지 않았다',
    falsifier: '열린 draft 수(7일 이동평균)' },
];

// ── 작은 도구 ──────────────────────────────────────────────────────────
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
export const kstDay = (date: Date): string => new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._:/-]+/gu, '').slice(0, 80) || 'none';

export function retroDailyDir(root: string): string { return join(root, 'retro', 'daily'); }
export function retroDayFile(root: string, day: string): string { return join(retroDailyDir(root), `${day}.json`); }

export function factId(fact: RetroFactIn): string {
  return `F-${createHash('sha1').update(JSON.stringify([fact.store ?? '', fact.at, fact.category ?? '', fact.event ?? '', fact.kind, fact.data ?? null])).digest('hex').slice(0, 8)}`;
}

/** 서명 = 묶음 열쇠. 실패 테스트 > 멈춤 사유 > 카드 종류 순으로 고른다(RFC §1 cluster). */
export function factSignature(fact: RetroFactIn): string {
  const data = record(fact.data);
  const test = str(data.failingTest) || str(data.test) || (Array.isArray(data.failingTests) ? str(data.failingTests[0]) : '');
  if (test) return `test:${norm(test)}`;
  if (fact.kind === 'draft-birth' || fact.kind === 'draft-death') return fact.kind;
  if (fact.kind === 'stop-reason') return `stop:${norm(str(data.stopReason) || 'unknown')}`;
  if (fact.kind === 'ta-outcome') {
    const result = str(data.result);
    // 결과를 모르면 ok 로 접지 않는다 — 판정할 낱말이 없으면 «no-result» 로 남긴다.
    const verdict = !result.trim() ? 'no-result' : /fail|error|실패|abandon|stuck|멈춤/i.test(result) ? 'failed'
      : /\b(ok|done|success|merged|landed|passed|updated|completed)\b|완료|성공|착지/i.test(result) ? 'ok' : 'unjudged';
    return `card:${norm(str(data.cardKind) || str(data.card) || 'task-agent')}:${verdict}`;
  }
  return `${norm(fact.kind)}:${norm(str(data.signature) || str(data.cardKind) || str(data.reason) || str(data.stopReason) || '')}`;
}

function factText(fact: RetroFactIn): string {
  const data = record(fact.data);
  return [fact.category, fact.event, str(data.stopReason), str(data.result), str(data.reason), str(data.summary), str(data.title), str(data.cardKind)]
    .filter(Boolean).join(' · ').slice(0, 300);
}

export function themeOf(signature: string, texts: readonly string[]): RetroTheme | undefined {
  if (signature === 'draft-birth' || signature === 'draft-death') return RETRO_THEMES.find(t => t.id === 'draft-backlog');
  // 서명이 먼저 말하면 서명을 믿는다 — 본문은 서명이 침묵할 때만 본다.
  return RETRO_THEMES.find(t => t.pattern.test(signature)) ?? RETRO_THEMES.find(t => texts.some(text => t.pattern.test(text)));
}

// ── 단계 순수 함수 ─────────────────────────────────────────────────────
export function normalizeFacts(raw: unknown): { facts: RetroFact[]; truncated: boolean } {
  const list = Array.isArray(raw) ? raw : Array.isArray(record(raw).facts) ? record(raw).facts as unknown[] : [];
  const facts = list.map(record).filter(f => typeof f.at === 'string' && typeof f.kind === 'string')
    .map(f => {
      const fact = f as unknown as RetroFactIn;
      return { ...fact, id: factId(fact), signature: factSignature(fact), text: factText(fact) };
    });
  return { facts: facts.slice(0, MAX_FACTS), truncated: facts.length > MAX_FACTS };
}

export type Cluster = { signature: string; theme: string; themeTitle: string; count: number; factIds: string[]; lastAt: string; samples: string[] };

export function clusterFacts(facts: readonly RetroFact[]): Cluster[] {
  const groups = new Map<string, RetroFact[]>();
  for (const fact of facts) groups.set(fact.signature, [...(groups.get(fact.signature) ?? []), fact]);
  return [...groups.entries()].map(([signature, members]) => {
    const theme = themeOf(signature, members.map(m => m.text));
    return { signature, theme: theme?.id ?? `sig:${signature}`, themeTitle: theme?.title ?? signature, count: members.length,
      factIds: members.map(m => m.id), lastAt: members.map(m => m.at).sort().at(-1) ?? '', samples: [...new Set(members.map(m => m.text).filter(Boolean))].slice(0, 3) };
  }).sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

export type PriorDay = { day: string; themes: string[]; signatures: string[]; actedThemes: string[] };
export type Recurrence = {
  theme: string; title: string; count: number; signatures: string[]; factIds: string[];
  daysSeen: string[]; actedBefore: string[]; greenCells: string[];
  /** 초록(green/done) 칸이 «사실보다 먼저» 있었는데 다시 나왔다. 지난 조치 «초안»은 초록이 아니다(→ recurAfterAction). */
  reBrokeAfterGreen: boolean;
  /** 지난 회고가 조치 초안을 냈는데 다시 나왔다. 1순위 다음. */
  recurAfterAction: boolean; recurring: boolean; rank: number;
};

export function readPriorDays(root: string, day: string, lookback = RETRO_LOOKBACK_DAYS): PriorDay[] {
  const dir = retroDailyDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < day).sort().slice(-lookback)
    .flatMap((name) => {
      try {
        const file = record(JSON.parse(readFileSync(join(dir, name), 'utf8')));
        return [{ day: name.slice(0, 10),
          themes: Array.isArray(file.themes) ? file.themes.map(t => str(record(t).theme)).filter(Boolean) : [],
          signatures: Array.isArray(file.clusters) ? file.clusters.map(c => str(record(c).signature)).filter(Boolean) : [],
          actedThemes: Array.isArray(file.actions) ? file.actions.map(a => str(record(a).theme)).filter(Boolean) : [] }];
      } catch { return []; }
    });
}

/** RFC §1 recur — ① 지난 회고 ② 이미 green/done 인 칸 ③ 지난 조치. «초록 뒤 재발»이 1순위다. */
export function findRecurrences(clusters: readonly Cluster[], prior: readonly PriorDay[], greenCells: readonly GreenCell[]): Recurrence[] {
  const byTheme = new Map<string, Cluster[]>();
  for (const cluster of clusters) byTheme.set(cluster.theme, [...(byTheme.get(cluster.theme) ?? []), cluster]);
  const out = [...byTheme.entries()].map(([theme, members]) => {
    const def = RETRO_THEMES.find(t => t.id === theme);
    const signatures = members.map(m => m.signature);
    const count = members.reduce((sum, m) => sum + m.count, 0);
    const daysSeen = prior.filter(p => p.themes.includes(theme) || p.signatures.some(s => signatures.includes(s))).map(p => p.day);
    const actedBefore = prior.filter(p => p.actedThemes.includes(theme)).map(p => p.day);
    const lastAt = members.map(m => m.lastAt).sort().at(-1) ?? '';
    // 초록이 된 시각이 그 주제의 마지막 사실보다 «앞»이어야 «초록 뒤 재발»이다. 시각을 모르면(greenAt 없음) 후보로 둔다.
    const green = def ? greenCells.filter(c => (c.status === 'green' || c.status === 'done') && def.pattern.test(`${c.id} ${c.title ?? ''}`)
      && (!c.greenAt || !lastAt || Date.parse(c.greenAt) < Date.parse(lastAt)))
      .map(c => `${c.id}${c.version ? `@${c.version}` : ''}${c.greenAt ? '' : '(시각 모름)'}`) : [];
    const reBrokeAfterGreen = green.length > 0;
    const recurAfterAction = actedBefore.length > 0;
    const recurring = reBrokeAfterGreen || recurAfterAction || daysSeen.length > 0 || count >= 2;
    return { theme, title: def?.title ?? members[0]!.themeTitle, count, signatures, factIds: members.flatMap(m => m.factIds),
      daysSeen, actedBefore, greenCells: green, reBrokeAfterGreen, recurAfterAction, recurring, rank: 0 };
  }).sort((a, b) => Number(b.reBrokeAfterGreen) - Number(a.reBrokeAfterGreen) || Number(b.recurAfterAction) - Number(a.recurAfterAction) || Number(b.recurring) - Number(a.recurring)
    || b.daysSeen.length - a.daysSeen.length || b.count - a.count || a.theme.localeCompare(b.theme));
  return out.map((r, i) => ({ ...r, rank: i + 1 }));
}

export type Insight = { theme: string; title: string; text: string; rootCause: string; cites: string[] };

/** 결정적 insight — 사실 id 를 반드시 단다. (LLM 노드로 바꿀 때도 `cites` 검사는 그대로 남긴다.) */
export function buildInsights(recurrences: readonly Recurrence[]): Insight[] {
  return recurrences.filter(r => r.recurring).map((r) => {
    const def = RETRO_THEMES.find(t => t.id === r.theme);
    const cites = r.factIds.slice(0, 5);
    const why = [
      r.greenCells.length ? `초록으로 닫은 칸(${r.greenCells.join(', ')}) 뒤 다시 나왔다` : '',
      r.actedBefore.length ? `지난 회고 조치(${r.actedBefore.join(', ')}) 뒤에도 남았다` : '',
      r.daysSeen.length ? `지난 ${r.daysSeen.length}일 회고에도 있었다` : '',
    ].filter(Boolean).join(' · ');
    const rootCause = def?.rootCause ?? `서명 ${r.signatures.join(', ')} 이 반복된다 — 사전에 없는 반복이라 원인 틀이 아직 없다`;
    return { theme: r.theme, title: r.title, rootCause, cites,
      text: `${r.title} ${r.count}건 [${cites.join(', ')}]${why ? ` — ${why}` : ''} ⇒ ${rootCause}` };
  });
}

export function assertInsightsCite(insights: readonly Insight[], facts: readonly { id: string }[]): void {
  const known = new Set(facts.map(f => f.id));
  for (const insight of insights) {
    if (!insight.cites.length || insight.cites.some(id => !known.has(id))) throw new Error(`insight ${insight.theme} cites unknown or no fact ids`);
  }
}

export type DraftCell = { id: string; theme: string; title: string; owner: string; verdictLine: string; falsifier: string; evidence: string[]; status: 'draft' };

export function draftActions(insights: readonly Insight[], recurrences: readonly Recurrence[], day: string): DraftCell[] {
  return insights.slice(0, RETRO_MAX_ACTIONS).map((insight) => {
    const def = RETRO_THEMES.find(t => t.id === insight.theme);
    const rec = recurrences.find(r => r.theme === insight.theme)!;
    const slug = insight.theme.replace(/^sig:/, '').replace(/[^a-z0-9]+/gi, '-').toUpperCase().slice(0, 32);
    return { id: `RETRO-${slug}-${day.replace(/-/g, '')}`, theme: insight.theme, status: 'draft' as const,
      title: `${insight.title} 한 단 위 수리 — ${insight.rootCause}`, owner: def?.owner ?? 'OP',
      verdictLine: rec.reBrokeAfterGreen || rec.recurAfterAction ? '다음 7일 회고에서 이 주제가 다시 나오지 않는다' : '다음 회고에서 이 주제의 건수가 줄어든다',
      falsifier: def?.falsifier ?? `서명 ${rec.signatures.join(', ')} 건수/일`, evidence: insight.cites };
  });
}

export function summaryLines(recurrences: readonly Recurrence[], actions: readonly DraftCell[], factCount: number, mode: RetroMode): string[] {
  const top = recurrences.filter(r => r.recurring);
  const first = top[0];
  return [
    first ? `회고 1순위: ${first.title} ${first.count}건${first.reBrokeAfterGreen ? ' · 초록 뒤 재발' : first.recurAfterAction ? ' · 조치 뒤 재발' : first.daysSeen.length ? ` · ${first.daysSeen.length}일째` : ''}` : '회고: 반복 없음',
    `사실 ${factCount} · 반복 주제 ${top.length}(${top.slice(0, 5).map(r => r.title).join(' · ') || '없음'})`,
    `조치 초안 ${actions.length}: ${actions.map(a => `${a.id}(${a.owner})`).join(', ') || '없음'} · ${mode}`,
  ];
}

// ── 모드 ───────────────────────────────────────────────────────────────
export function resolveRetroMode(input: Record<string, unknown>, readConfig: () => unknown = () => getUserConfig().raw): RetroMode {
  // 입력은 «더 안전한 쪽»으로만 바꿀 수 있다(shadow 강제). live 는 config 에서만 온다.
  if (input.mode === 'shadow') return 'shadow';
  try { return record(record(record(readConfig()).retro).daily).mode === 'live' ? 'live' : 'shadow'; } catch { return 'shadow'; }
}

// ── 노드 실행 ─────────────────────────────────────────────────────────
type Ctx = { graphId?: string; nodeId?: string; input: Record<string, unknown> | null; outputs: Record<string, Record<string, unknown> | null> };
export type RetroDeps = { now?: Date; readFacts?: (since: string, root: string) => unknown; readGreenCells?: () => GreenCell[]; readConfig?: () => unknown; repo?: string };

const repoRoot = resolve(import.meta.dir, '..', '..');

function readFactsViaCli(since: string, root: string, repo = repoRoot): unknown {
  const args = ['bin/elanous.mjs', ...(root === prodInstanceRoot() ? [] : [`--test=${root}`]), 'retro', 'facts', '--since', since, '--json'];
  const result = spawnSync('bun', args, { cwd: repo, encoding: 'utf8', timeout: 570_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`retro facts failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
  return JSON.parse(result.stdout);
}

/** 최근 판 열 개의 체크리스트에서 green/done 칸을 모은다(예: DRAFT3 0.2.12 · DRAFT-TRIAGE 0.2.18). 못 읽은 판은 건너뛴다. */
async function readGreenCellsFromChecklist(span = 10): Promise<GreenCell[]> {
  const { listChecklist, checklistDevVersion } = await import('../release-loop/checklist.js');
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(checklistDevVersion());
  if (!match) throw new Error(`unparseable version: ${checklistDevVersion()}`);
  const cells: GreenCell[] = [];
  for (let patch = Number(match[3]); patch >= Math.max(0, Number(match[3]) - span); patch--) {
    const version = `${match[1]}.${match[2]}.${patch}`;
    try {
      // 체크리스트는 릴리스 원장(releaseLedgerRoot — 기본 prod)에 있다. 회고 런의 우주가 아니라 원장 우주를 읽는다(쓰기 없음).
      const list = listChecklist(version);
      const greenAt = (id: string) => list.history.filter(h => h.id === id && h.field === 'status' && (h.to === 'green' || h.to === 'done')).map(h => h.at).sort().at(-1);
      cells.push(...list.items.filter(i => i.status === 'green' || i.status === 'done').map(i => ({ id: i.id, title: i.title, status: i.status, version, greenAt: greenAt(i.id) })));
    }
    catch { /* 그 판의 체크리스트가 없다 */ }
  }
  return cells;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export async function runRetroStage(stage: RetroStage, ctx: Ctx, root: string, dryRun: boolean, deps: RetroDeps = {}): Promise<Record<string, unknown>> {
  const input = ctx.input ?? {};
  const now = deps.now ?? new Date();
  const out = ctx.outputs;
  const day = str(out.collect?.day) || str(input.day) || kstDay(now);
  switch (stage) {
    case 'collect': {
      const since = str(input.since) || '24h';
      const sources: Record<string, string> = {};
      let raw: unknown;
      if (typeof input.factsFile === 'string') { raw = JSON.parse(readFileSync(input.factsFile, 'utf8')); sources.facts = `file:${input.factsFile}`; }
      else if (Array.isArray(input.facts)) { raw = input.facts; sources.facts = 'input'; }
      else { raw = (deps.readFacts ?? ((s, r) => readFactsViaCli(s, r, deps.repo)))(since, root); sources.facts = `retro facts --since ${since}`; }
      const { facts, truncated } = normalizeFacts(raw);
      let greenCells: GreenCell[] = [];
      if (Array.isArray(input.greenCells)) { greenCells = input.greenCells.map(record).map(c => ({ id: str(c.id), title: str(c.title), status: str(c.status), version: str(c.version) || undefined, greenAt: str(c.greenAt) || undefined })); sources.green = 'input'; }
      else {
        try { greenCells = (deps.readGreenCells ? deps.readGreenCells() : await readGreenCellsFromChecklist()).map(c => ({ ...c, title: (c.title ?? "").slice(0, 120) })); sources.green = 'checklist'; }
        catch (error) { sources.green = `unreadable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`; }
      }
      const unavailable = Array.isArray(record(raw).unavailable) ? record(raw).unavailable : [];
      return { outcome: 'ok', day, since, mode: resolveRetroMode(input, deps.readConfig), facts, factCount: facts.length, truncated, unavailable, greenCells, sources };
    }
    case 'cluster': {
      const clusters = clusterFacts((out.collect?.facts ?? []) as RetroFact[]);
      return { outcome: 'ok', clusters };
    }
    case 'recur': {
      const prior = readPriorDays(root, day);
      const recurrences = findRecurrences((out.cluster?.clusters ?? []) as Cluster[], prior, (out.collect?.greenCells ?? []) as GreenCell[]);
      return { outcome: 'ok', priorDays: prior.map(p => p.day), recurrences };
    }
    case 'insight': {
      const insights = buildInsights((out.recur?.recurrences ?? []) as Recurrence[]);
      assertInsightsCite(insights, (out.collect?.facts ?? []) as RetroFact[]);
      return { outcome: 'ok', insights };
    }
    case 'act': {
      // 그림자든 live 든 이 노드는 «글»만 낸다 — `checklist add` 를 부르지 않는다(RETRO-DAILY 첫 조각).
      const actions = draftActions((out.insight?.insights ?? []) as Insight[], (out.recur?.recurrences ?? []) as Recurrence[], day);
      return { outcome: 'ok', actions, wroteChecklist: false };
    }
    case 'report': {
      const mode = (str(out.collect?.mode) || 'shadow') as RetroMode;
      const facts = (out.collect?.facts ?? []) as RetroFact[];
      const recurrences = (out.recur?.recurrences ?? []) as Recurrence[];
      const actions = (out.act?.actions ?? []) as DraftCell[];
      const summary = summaryLines(recurrences, actions, facts.length, mode);
      const themes = recurrences.map(r => ({ theme: r.theme, title: r.title, count: r.count, recurring: r.recurring, reBrokeAfterGreen: r.reBrokeAfterGreen, recurAfterAction: r.recurAfterAction, greenCells: r.greenCells, rank: r.rank }));
      const dayFile = { day, mode, briefing: mode === 'live', generatedAt: now.toISOString(), factCount: facts.length,
        truncated: out.collect?.truncated === true, unavailable: out.collect?.unavailable ?? [], sources: out.collect?.sources ?? {},
        priorDays: out.recur?.priorDays ?? [], clusters: ((out.cluster?.clusters ?? []) as Cluster[]).map(({ samples: _s, ...c }) => c),
        themes, insights: out.insight?.insights ?? [], actions, summary };
      const file = retroDayFile(root, day);
      const md = [`# 매일 회고 ${day} (${mode})`, '', ...summary.map(l => `- ${l}`), '', '## 반복 (순위)',
        ...recurrences.filter(r => r.recurring).map(r => `${r.rank}. ${r.title} — ${r.count}건${r.reBrokeAfterGreen ? ' · 초록 뒤 재발' : r.recurAfterAction ? ' · 조치 뒤 재발' : ''}${r.daysSeen.length ? ` · ${r.daysSeen.length}일째` : ''} · ${r.signatures.join(', ')}`),
        '', '## 인사이트', ...((out.insight?.insights ?? []) as Insight[]).map(i => `- ${i.text}`),
        '', '## 조치 초안 (그림자 — 체크리스트에 쓰지 않았다)', ...actions.map(a => `- ${a.id} · ${a.owner} · ${a.title} · 판정선: ${a.verdictLine} · 반증: ${a.falsifier} · 근거: ${a.evidence.join(', ')}`), ''].join('\n');
      if (!dryRun) {
        writeAtomic(file, JSON.stringify(dayFile, null, 2) + '\n');
        writeAtomic(file.replace(/\.json$/, '.md'), md);
      }
      debug.log('retro.daily', 'report', { day, mode, dryRun, facts: facts.length, recurring: themes.filter(t => t.recurring).length, actions: actions.length });
      return { outcome: 'ok', day, mode, dryRun, file: dryRun ? null : file, summary, actions: actions.length, sent: false, wroteChecklist: false };
    }
  }
}

/** 08:30 데일리 리뷰가 싣는 세 줄 — live 로 쓴 회고 파일만 읽는다(shadow 는 브리핑에 안 나간다). */
export function retroBriefingLines(root: string, day: string): string[] {
  try {
    const file = record(JSON.parse(readFileSync(retroDayFile(root, day), 'utf8')));
    if (file.briefing !== true || !Array.isArray(file.summary)) return [];
    return file.summary.map(str).filter(Boolean).slice(0, 3);
  } catch { return []; }
}

if (import.meta.main) {
  const stage = process.argv[2] as RetroStage;
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path || !RETRO_STAGES.includes(stage)) throw new Error('invalid retro-daily graph stage');
  const ctx = JSON.parse(readFileSync(path, 'utf8')) as Ctx;
  if (ctx.graphId !== RETRO_DAILY_GRAPH_ID || ctx.nodeId !== stage) throw new Error('retro-daily graph context mismatch');
  // <root>/graph-runs/<graphId>/<runId>.json.contexts/<n>.json — 런 원장의 우주가 곧 회고 파일의 우주다.
  const statePath = resolve(path, '..', '..', '..', '..');
  const root = statePath || effectiveInstanceRoot();
  console.log(JSON.stringify(await runRetroStage(stage, ctx, root, process.env.ELANOUS_GRAPH_DRY_RUN === '1')));
}
