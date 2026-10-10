// 흡수 하루 다이제스트 — 그날 흡수한 것을 사람이 «발견»하는 자리. 노트 절(마크다운) ⊕ 텔레그램 짧은 판.
// 결정론만: 요약 한 줄은 각 노트가 이미 쓴 「한 줄 결론」을 뽑는다(LLM 을 다시 부르지 않는다).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadIntakeLedger, type IntakeItem } from './items.js';
import { canonicalSeat } from './intake-sources.js';
import { readSavedCursorAt } from './collect-telegram-saved.js';
import { intakeOutboxDir, kstDay } from './route.js';

export type DigestLensVerdict = '대체 후보' | '보강' | '경쟁 대조';
export interface DigestEntry { id: string; sources: string[]; url?: string; note?: string; noteName?: string; oneLiner?: string; axis: string; impact?: { verdict: DigestLensVerdict; why: string; target: string } }
export interface DigestLedgerEntry { id: string; title: string; url: string; verdict: DigestLensVerdict | '참고' | '판정 대기' }
export interface IntakeDigest { day: string; seat?: string; absorbed: DigestEntry[]; goals: { fact: string; url?: string }[]; news?: { title: string; url: string; summary: string[]; implication: string[] }[]; xTrends?: DigestLedgerEntry[]; githubNew?: DigestLedgerEntry[]; shadowSuggestions?: { fact: string; url?: string; verdict: string }[]; review?: { fact: string; note?: string }[]; grounding: number; release: number; manual: number; savedSilence?: { days: number; lastNewAt: string } }

const AXIS_LABEL: Record<string, string> = {
  video_automation: '영상 자동화', agent_basics: '에이전트 기본', agent_applied: '에이전트 응용', unrelated: '그 밖',
};

/** 노트에서 요약 한 줄 — 「한 줄 결론」/「한줄 결론」 표지 다음의 첫 문장. 없으면 frontmatter·제목 뒤 첫 문단. */
export function noteOneLiner(md: string): string | undefined {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = body.split('\n');
  const clean = (l: string) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').replace(/\s{2,}$/, '').trim();
  const i = lines.findIndex((l) => /한\s?줄\s?결론/.test(l));
  if (i >= 0) {
    const inline = clean(lines[i].split(/한\s?줄\s?결론\**\s*[:：]?/)[1] ?? '');
    if (inline.length > 10) return inline.slice(0, 220);
    for (const l of lines.slice(i + 1)) { const c = clean(l); if (c) return c.slice(0, 220); }
  }
  for (const l of lines) {
    const c = clean(l);
    if (c && !l.startsWith('#') && !/^(원문|참조|출처)/.test(c) && !c.startsWith('http')) return c.slice(0, 220);
  }
  return undefined;
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** `day`(KST YYYY-MM-DD)에 흡수·갈래가 끝난 항목과 그날의 산출 큐를 모은다. */
/** Saved Messages silent for more than two days → the digest says so (a quiet 0 must not look like «nothing to do»). */
const SAVED_SILENCE_MS = 48 * 3600_000;

/** A «why» that only names paths (optionally behind a label like «경로:») is evidence, not a reason for us. */
export function pathOnly(why: string): boolean {
  const rest = why
    .replace(/`?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,6}(?::\d+)?`?/g, ' ')
    .replace(/`?(?:[\w.-]+\/)+[\w.-]*`?/g, ' ')
    .replace(/(?:경로|파일|근거|path|file|evidence)\s*[:：]?/gi, ' ')
    .replace(/[\s,·:;()[\]\-–—]+/g, '');
  return rest.length < 4;
}

/** Seat briefing receipts — `outbox/brief/<seat>.jsonl` rows `{ id, day }`: an item already sent on an earlier day is not «new» again. */
export function seatBriefFile(root: string, seat: string): string { return join(intakeOutboxDir(root), 'brief', `${seat}.jsonl`); }

/** Record the items a seat briefing delivered (called only after a successful send). */
export function recordSeatBriefed(root: string, seat: string, day: string, ids: readonly string[]): void {
  if (!ids.length) return;
  const file = seatBriefFile(root, seat);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, ids.map((id) => JSON.stringify({ id, day })).join('\n') + '\n');
}

export function buildIntakeDigest(root: string, day: string, readFile: (p: string) => string | undefined = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined), now: Date = new Date(), seat?: string): IntakeDigest {
  const selectedSeat = seat === undefined ? undefined : canonicalSeat(seat);
  // Re-collecting the same search result moves lastSeenAt to today; without receipts it would be «new» every morning.
  const briefedEarlier = new Set(selectedSeat
    ? readJsonl(seatBriefFile(root, selectedSeat)).filter((r) => typeof r.id === 'string' && r.day !== day).map((r) => r.id as string)
    : []);
  const ledgerItems = [...loadIntakeLedger(root).items.values()];
  const items = ledgerItems
    .filter((i) => (selectedSeat === undefined || (i.seat === selectedSeat && !briefedEarlier.has(i.id)))
      && (selectedSeat ? i.status !== 'discarded' : (i.status === 'absorbed' || i.status === 'routed') && i.outputs.some((o) => o.kind === 'note'))
      && kstDay(i.lastSeenAt) === day);
  const out = intakeOutboxDir(root);
  const allLensRows = readJsonl(join(out, 'lens', `${day}.jsonl`));
  const ledgerDecisions = new Map<string, { verdict: Exclude<DigestLedgerEntry['verdict'], '판정 대기'>; why: string; target: string }>();
  // The first valid lens row owns an ID's verdict for both absorbed notes and same-day ledger sections.
  for (const row of allLensRows) {
    if (typeof row.id !== 'string' || ledgerDecisions.has(row.id)) continue;
    const verdict = row.lensVerdict;
    if (verdict !== '대체 후보' && verdict !== '보강' && verdict !== '경쟁 대조' && verdict !== '참고') continue;
    const why = typeof row.why === 'string' ? row.why.trim() : '';
    const target = typeof row.target === 'string' ? row.target.trim() : '';
    // A check's fact/current or repo path is evidence, not a lens judgement or a reason for us.
    if (!why || !target || pathOnly(why)) continue;
    ledgerDecisions.set(row.id, { verdict, why, target });
  }
  const absorbed = items.map((i: IntakeItem): DigestEntry => {
    const note = [...i.outputs].reverse().find((o) => o.kind === 'note')?.ref;
    const md = note ? readFile(note) : undefined;
    const decision = ledgerDecisions.get(i.id);
    const impact = decision && decision.verdict !== '참고'
      ? { verdict: decision.verdict, why: decision.why, target: decision.target } : undefined;
    return {
      id: i.id, sources: i.sources, ...(i.url ? { url: i.url } : {}),
      ...(note ? { note, noteName: basename(note, '.md') } : {}),
      ...(md ? { oneLiner: noteOneLiner(md) } : selectedSeat && i.title ? { oneLiner: i.title } : {}),
      axis: AXIS_LABEL[i.judgement?.axis ?? i.axis ?? ''] ?? (i.sources.includes('telegram-saved') ? '내가 저장한 것' : '그 밖'),
      ...(impact ? { impact } : {}),
    };
  });
  const goals = selectedSeat ? [] : readJsonl(join(out, 'goals', `${day}.jsonl`)).map((g) => ({ fact: String(g.fact ?? ''), ...(g.url ? { url: String(g.url) } : {}) }));
  const lensRows = selectedSeat ? [] : allLensRows;
  const news = lensRows.flatMap((row) =>
    typeof row.title === 'string' && typeof row.url === 'string' && Array.isArray(row.summary) && Array.isArray(row.implication)
      ? [{ title: row.title, url: row.url, summary: row.summary.filter((s): s is string => typeof s === 'string'), implication: row.implication.filter((s): s is string => typeof s === 'string') }]
      : []);
  const ledgerEntry = (item: IntakeItem): DigestLedgerEntry => ({
    id: item.id, title: item.title?.trim() || item.url!, url: item.url!,
    verdict: ledgerDecisions.get(item.id)?.verdict ?? '판정 대기',
  });
  const sameDayLedger = selectedSeat ? [] : ledgerItems
    .filter((item) => item.status !== 'discarded' && item.url && kstDay(item.lastSeenAt) === day);
  const xTrends = sameDayLedger.filter((item) => item.sources.includes('x')).map(ledgerEntry);
  const githubNew = sameDayLedger.filter((item) => item.sources.includes('github')).map(ledgerEntry);
  const shadowSuggestions = lensRows.flatMap((row) =>
    Array.isArray(row.suggestions) ? row.suggestions.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const suggestion = raw as Record<string, unknown>;
      if (suggestion.status !== '제안' || typeof suggestion.fact !== 'string' || !suggestion.fact.trim()) return [];
      return [{ fact: suggestion.fact, ...(typeof row.url === 'string' ? { url: row.url } : {}), verdict: typeof suggestion.verdict === 'string' ? suggestion.verdict : '판단 필요' }];
    }) : []);
  const review = selectedSeat ? [] : readJsonl(join(out, 'review', `${day}.jsonl`)).map((r) => ({ fact: String(r.fact ?? ''), ...(r.note ? { note: String(r.note) } : {}) }));
  const grounding = selectedSeat ? 0 : readJsonl(join(out, 'grounding.jsonl')).filter((g) => typeof g.at === 'string' && kstDay(g.at) === day).length;
  const lastNewAt = selectedSeat ? undefined : readSavedCursorAt(root);
  const silentMs = lastNewAt ? now.getTime() - Date.parse(lastNewAt) : NaN;
  return {
    day, ...(selectedSeat ? { seat: selectedSeat } : {}), absorbed, goals, ...(news.length ? { news } : {}), ...(xTrends.length ? { xTrends } : {}), ...(githubNew.length ? { githubNew } : {}), ...(shadowSuggestions.length ? { shadowSuggestions } : {}), review, grounding,
    release: selectedSeat ? 0 : readJsonl(join(out, 'release', `${day}.jsonl`)).length,
    manual: selectedSeat ? 0 : readJsonl(join(out, 'manual', `${day}.jsonl`)).length,
    ...(!selectedSeat && lastNewAt && silentMs > SAVED_SILENCE_MS ? { savedSilence: { days: Math.floor(silentMs / 86_400_000), lastNewAt } } : {}),
  };
}

function digestNoteRef(e: DigestEntry): string {
  return e.noteName ? `[[${e.noteName}]]` : e.note?.trim() || e.url?.trim() || e.id;
}

/** 참고 줄에 이름을 다는 상한 — 많은 날에도 화면 한 장을 지킨다(M 은 그대로 센다). */
const DIGEST_REFERENCE_NAMED = 10;

function digestReferenceLine(entries: DigestEntry[]): string {
  const named = entries.slice(0, DIGEST_REFERENCE_NAMED).map(digestNoteRef).join(', ');
  const rest = entries.length - DIGEST_REFERENCE_NAMED;
  return `참고 ${entries.length}편 — 노트: ${named}${rest > 0 ? ` 외 ${rest}편 · 원장 \`elanous intake items\`` : ''}`;
}

/** 노트 절 — 축별 묶음 · 노트 링크 · 한 줄 요약 · 골 후보. */
export function renderDigestMarkdown(d: IntakeDigest): string {
  const L: string[] = [`## 📰 오늘의 흡수 요약 (${d.absorbed.length})`, ''];
  if (d.savedSilence) L.push(`> ⚠️ 텔레그램 «저장된 메시지»에서 새 글을 ${d.savedSilence.days}일째 못 받았다(마지막 새 글 수집 ${kstDay(d.savedSilence.lastNewAt)}) — 저장했는데 안 들어왔다면 저장한 곳(본인 «저장된 메시지»인지)을 확인한다.`, '');
  if (!d.absorbed.length && !d.news?.length && !d.xTrends?.length && !d.githubNew?.length) {
    L.push('오늘 흡수한 것이 없다.', '');
    return L.join('\n');
  }
  const byAxis = new Map<string, DigestEntry[]>();
  for (const e of d.absorbed) (byAxis.get(e.axis) ?? byAxis.set(e.axis, []).get(e.axis)!).push(e);
  for (const [axis, rows] of byAxis) {
    L.push(`### ${axis} (${rows.length})`, '');
    for (const e of rows) L.push(`- ${e.noteName ? `[[${e.noteName}]]` : e.url ?? e.id} — ${e.oneLiner ?? '(요약 줄 없음)'}`);
    L.push('');
  }
  if (d.news?.length) {
    L.push(`### 📰 관심 뉴스 (${d.news.length})`, '');
    for (const article of d.news.slice(0, 10)) {
      L.push(`- [${article.title}](${article.url})`);
      for (const line of article.summary) L.push(`  - ${line}`);
      for (const line of article.implication) L.push(`  - 엘라누스 함의: ${line}`);
    }
    L.push('');
  }
  for (const [heading, entries] of [['X 트렌드', d.xTrends], ['GitHub 신규', d.githubNew]] as const) {
    if (!entries?.length) continue;
    L.push(`### ${heading} (${entries.length})`, '');
    for (const entry of entries) L.push(`- [${entry.title}](${entry.url}) — ${entry.verdict}`);
    L.push('');
  }
  if (d.goals.length) {
    L.push(`### 🔴 엘라누스에 없는 것 — 골 후보 (${d.goals.length})`, '');
    for (const g of d.goals.slice(0, 10)) L.push(`- ${g.fact}${g.url ? ` · [원본](${g.url})` : ''}`);
    L.push('');
  }
  if (d.shadowSuggestions?.length) {
    L.push(`### 📰 뉴스 칸 제안 — 그림자, 판 미등록 (${d.shadowSuggestions.length})`, '');
    for (const s of d.shadowSuggestions.slice(0, 10)) L.push(`- [${s.verdict}] ${s.fact}${s.url ? ` · [원본](${s.url})` : ''}`);
    L.push('');
  }
  const undecided = d.absorbed.filter((e) => !e.impact).length;
  if (undecided) L.push(`렌즈 판정 못 함 ${undecided} — 원장 \`elanous intake items\``, '');
  L.push(`> 매뉴얼 후보 ${d.manual} · 릴리스 노트 맥락 ${d.release} · 그라운딩 후보 ${d.grounding} — 흡수 원장 \`elanous intake items\` · 큐 \`<인스턴스>/intake/outbox/\``, '');
  return L.join('\n');
}

/** 텔레그램 — 흡수 렌즈가 대조한 항목만 SCQA 짧은 판으로 낸다. */
export function renderDigestTelegram(d: IntakeDigest, _opts: { vaultRoot?: string; notePath?: string } = {}): string {
  // «Touching» is decided by the lens verdict alone; a missing note summary only changes how S reads (ACP must-fix).
  const touching = d.absorbed.filter((e) => e.impact);
  const L = [`흡수 ${d.absorbed.length}편 → 우리에게 닿는 것 ${touching.length}`];
  // 관심 뉴스는 최대 셋 — 기사마다 S(요약 첫 줄) · A(엘라누스 함의 첫 줄) · 링크를 한 덩어리로(NEWS-INTAKE).
  for (const article of (d.news ?? []).slice(0, 3)) {
    L.push(`📰 ${article.title}`);
    if (article.summary[0]) L.push(`S: ${article.summary[0]}`);
    if (article.implication[0]) L.push(`A: ${article.implication[0]}`);
    L.push(article.url);
  }
  if (d.shadowSuggestions?.length) L.push(`뉴스 칸 제안 ${d.shadowSuggestions.length}건 (그림자·판 미등록): ${d.shadowSuggestions.slice(0, 3).map((s) => `[${s.verdict}] ${s.fact}${s.url ? ` ${s.url}` : ''}`).join(' · ')}`);
  for (const [heading, entries] of [['X 트렌드', d.xTrends], ['GitHub 신규', d.githubNew]] as const) {
    if (!entries?.length) continue;
    L.push('', `${heading} (${entries.length})`);
    for (const entry of entries.slice(0, 5)) L.push(`- [${entry.verdict}] ${entry.title} — ${entry.url}`);
    if (entries.length > 5) L.push(`외 ${entries.length - 5}건 · 원장 \`elanous intake items\``);
  }
  // At most three items are shown, each as its own S·C·A·note block so context and source stay paired.
  // S must be the note's own summary: items without one still count as touching but are not shown (ACP must-fix).
  const shownItems = touching.filter((e) => e.oneLiner?.trim()).slice(0, 3);
  const actionSeen = new Set<string>();
  const actionsUsed = new Set<string>();
  for (const e of shownItems) {
    const impact = e.impact!;
    const key = `${impact.verdict}\u0000${impact.target}`;
    const base = impact.verdict === '대체 후보' ? `${impact.target} lite Pod 실증 제안`
      : impact.verdict === '보강' ? `칸 ${impact.target} 에 근거 추가`
        : `${impact.target} 비교표 갱신`;
    // Every item keeps its own concrete action; a repeat of (verdict, target) names which item it is, so no two A lines match.
    const label = (e.oneLiner?.trim() || impact.why).slice(0, 24);
    let action = actionSeen.has(key) ? `${base} — «${label}» 근거로` : base;
    // Two identical labels still differ by their position in the list.
    if (actionsUsed.has(action)) action = `${action} (${shownItems.indexOf(e) + 1})`;
    actionsUsed.add(action);
    actionSeen.add(key);
    L.push('',
      `S 무엇: ${e.oneLiner?.trim() || '노트 한 줄 요약 없음'}`,
      `C 우리에게 왜: ${impact.why}`,
      `A 그래서 무엇을 하나: ${action}`,
      `🔗 노트: ${digestNoteRef(e)}`,
    );
  }
  if (touching.length > shownItems.length) L.push('', `닿는 것 ${touching.length - shownItems.length}건 더(요약 없는 것 포함) · 원장 \`elanous intake items\``);
  const reference = d.absorbed.filter((e) => !e.impact);
  if (reference.length) L.push('', digestReferenceLine(reference));
  return L.join('\n');
}
