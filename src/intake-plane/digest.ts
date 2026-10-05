// 흡수 하루 다이제스트 — 그날 흡수한 것을 사람이 «발견»하는 자리. 노트 절(마크다운) ⊕ 텔레그램 짧은 판.
// 결정론만: 요약 한 줄은 각 노트가 이미 쓴 「한 줄 결론」을 뽑는다(LLM 을 다시 부르지 않는다).
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadIntakeLedger, type IntakeItem } from './items.js';
import { readSavedCursorAt } from './collect-telegram-saved.js';
import { intakeOutboxDir, kstDay } from './route.js';

export interface DigestEntry { id: string; sources: string[]; url?: string; note?: string; noteName?: string; oneLiner?: string; axis: string; impact?: { fact: string; current: string; action: string } }
export interface IntakeDigest { day: string; absorbed: DigestEntry[]; goals: { fact: string; url?: string }[]; review?: { fact: string; note?: string }[]; grounding: number; release: number; manual: number; savedSilence?: { days: number; lastNewAt: string } }

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

export function buildIntakeDigest(root: string, day: string, readFile: (p: string) => string | undefined = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined), now: Date = new Date()): IntakeDigest {
  const items = [...loadIntakeLedger(root).items.values()]
    .filter((i) => (i.status === 'absorbed' || i.status === 'routed') && kstDay(i.lastSeenAt) === day && i.outputs.some((o) => o.kind === 'note'));
  const out = intakeOutboxDir(root);
  const relevant = new Map<string, NonNullable<DigestEntry['impact']>>();
  for (const [folder, action] of [
    ['goals', '없는 기능의 골 후보를 세운다'],
    ['manual', '문서·약속을 현재 동작에 맞게 보강한다'],
    ['review', '대조 근거를 추가로 확인한다'],
    ['release', '이미 착지한 기능의 바깥 맥락을 릴리스 노트에 반영한다'],
  ] as const) {
    for (const row of readJsonl(join(out, folder, `${day}.jsonl`))) {
      if (typeof row.id !== 'string' || relevant.has(row.id)) continue;
      const fact = folder === 'release' ? row.title : row.fact;
      if (typeof fact !== 'string' || !fact.trim()) continue;
      relevant.set(row.id, {
        fact,
        current: typeof (folder === 'release' ? row.summary : row.current) === 'string'
          ? String(folder === 'release' ? row.summary : row.current) : '대조 근거 없음',
        action,
      });
    }
  }
  const absorbed = items.map((i: IntakeItem): DigestEntry => {
    const note = [...i.outputs].reverse().find((o) => o.kind === 'note')?.ref;
    const md = note ? readFile(note) : undefined;
    const impact = relevant.get(i.id);
    return {
      id: i.id, sources: i.sources, ...(i.url ? { url: i.url } : {}),
      ...(note ? { note, noteName: basename(note, '.md') } : {}),
      ...(md ? { oneLiner: noteOneLiner(md) } : {}),
      axis: AXIS_LABEL[i.judgement?.axis ?? i.axis ?? ''] ?? (i.sources.includes('telegram-saved') ? '내가 저장한 것' : '그 밖'),
      ...(impact ? { impact } : {}),
    };
  });
  const goals = readJsonl(join(out, 'goals', `${day}.jsonl`)).map((g) => ({ fact: String(g.fact ?? ''), ...(g.url ? { url: String(g.url) } : {}) }));
  const review = readJsonl(join(out, 'review', `${day}.jsonl`)).map((r) => ({ fact: String(r.fact ?? ''), ...(r.note ? { note: String(r.note) } : {}) }));
  const grounding = readJsonl(join(out, 'grounding.jsonl')).filter((g) => typeof g.at === 'string' && kstDay(g.at) === day).length;
  const lastNewAt = readSavedCursorAt(root);
  const silentMs = lastNewAt ? now.getTime() - Date.parse(lastNewAt) : NaN;
  return {
    day, absorbed, goals, review, grounding,
    release: readJsonl(join(out, 'release', `${day}.jsonl`)).length,
    manual: readJsonl(join(out, 'manual', `${day}.jsonl`)).length,
    ...(lastNewAt && silentMs > SAVED_SILENCE_MS ? { savedSilence: { days: Math.floor(silentMs / 86_400_000), lastNewAt } } : {}),
  };
}

/** 노트 절 — 축별 묶음 · 노트 링크 · 한 줄 요약 · 골 후보. */
export function renderDigestMarkdown(d: IntakeDigest): string {
  const L: string[] = [`## 📰 오늘의 흡수 요약 (${d.absorbed.length})`, ''];
  if (d.savedSilence) L.push(`> ⚠️ 텔레그램 «저장된 메시지»에서 새 글을 ${d.savedSilence.days}일째 못 받았다(마지막 새 글 수집 ${kstDay(d.savedSilence.lastNewAt)}) — 저장했는데 안 들어왔다면 저장한 곳(본인 «저장된 메시지»인지)을 확인한다.`, '');
  if (!d.absorbed.length) { L.push('오늘 흡수한 것이 없다.', ''); return L.join('\n'); }
  const byAxis = new Map<string, DigestEntry[]>();
  for (const e of d.absorbed) (byAxis.get(e.axis) ?? byAxis.set(e.axis, []).get(e.axis)!).push(e);
  for (const [axis, rows] of byAxis) {
    L.push(`### ${axis} (${rows.length})`, '');
    for (const e of rows) L.push(`- ${e.noteName ? `[[${e.noteName}]]` : e.url ?? e.id} — ${e.oneLiner ?? '(요약 줄 없음)'}`);
    L.push('');
  }
  if (d.goals.length) {
    L.push(`### 🔴 엘라누스에 없는 것 — 골 후보 (${d.goals.length})`, '');
    for (const g of d.goals.slice(0, 10)) L.push(`- ${g.fact}${g.url ? ` · [원본](${g.url})` : ''}`);
    L.push('');
  }
  if (d.review?.length) {
    L.push(`### 🟡 사람이 가를 것 — 판단 필요 (${d.review.length})`, '', '> 근거가 실행 코드에 닿지만 «같은 것인가»는 결정론으로 못 가른다 — 노트의 🧭 절에서 판단한다.', '');
    for (const r of d.review.slice(0, 10)) L.push(`- ${r.fact}${r.note ? ` · [[${basename(r.note, '.md')}]]` : ''}`);
    if (d.review.length > 10) L.push(`- … 외 ${d.review.length - 10}건`);
    L.push('');
  }
  L.push(`> 매뉴얼 후보 ${d.manual} · 릴리스 노트 맥락 ${d.release} · 그라운딩 후보 ${d.grounding} — 흡수 원장 \`elanous intake items\` · 큐 \`<인스턴스>/intake/outbox/\``, '');
  return L.join('\n');
}

/** 텔레그램 — 흡수 렌즈가 대조한 항목만 SCQA 짧은 판으로 낸다. */
export function renderDigestTelegram(d: IntakeDigest, _opts: { vaultRoot?: string; notePath?: string } = {}): string {
  const touching = d.absorbed.filter((e) => e.impact);
  const L = [`흡수 ${d.absorbed.length} → 우리에게 닿는 것 ${touching.length}`];
  if (!touching.length) return L[0];
  for (const e of touching.slice(0, 3)) {
    L.push('',
      `S 무엇: ${e.impact!.fact}`,
      `C 우리에게 왜: ${e.impact!.current}`,
      `A 그래서 무엇을 하나: ${e.impact!.action}`,
      `🔗 원문 링크: ${e.url?.trim() || '링크 없음'}`,
    );
  }
  if (d.absorbed.length > touching.length) L.push('', `그 밖 ${d.absorbed.length - touching.length}건 · 닿지 않음`);
  return L.join('\n');
}
