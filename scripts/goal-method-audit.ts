#!/usr/bin/env bun
/**
 * 골 저작 방법론 매뉴얼을 «세 축»으로 잰다 — ⛔ 「따르는 수」가 아니라 «어기는 수»를 센다.
 *
 * 축① 로직화   : 조항마다 §0 관문 판정(로직화 완료 / 기계가 못 한다 / 후보)이 «있나»
 * 축② 사람 칸  : §6 이 선언한 수 ↔ 실제 조항 수의 벌어짐
 * 축③ 팩트 위주: 머리말이 *"서사·실측·이력은 여기 없다"* 고 선언했는데 실제로 얼마나 있나
 *
 * 🩸 계기(2026-09-01 · 대표 지시): 매뉴얼이 §0 에 「조항 대신 로직으로 민다」는 관문을 «맨 앞»에
 *    두고도, 그 관문을 «자기 조항들»에 적용했는지 재는 자가 없었다. 그래서 판정 없는 조항이
 *    조용히 쌓였다.
 *
 * ⛔ 이 자가 «못 보는» 것: 판정이 «있다»와 그 판정이 «옳다»는 다른 값이다. 이 자는 앞의 것만 본다.
 *
 * 사용:
 *   bun scripts/goal-method-audit.ts --self-check   # ⭐ 알려진 양성·음성으로 자를 먼저 건다
 *   bun scripts/goal-method-audit.ts                # 전수
 */
import { readFileSync } from 'node:fs';

const MANUAL = 'docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
const CLAUSE_LABEL = /[🅐🅑🅒🅓🅔🅕🅖🅗🅘🅙🅚🅛🅜🅝🅞🅟🅠🅡🅢🅣🅤🅥]/u;
/**
 * ⛔ 같은 문자가 «두 뜻»이다 — 조항 라벨(🅐~🅥)이면서 트랙 표지(🅢 🅣 🅕)다.
 *    가르는 것은 «자리»다: 조항 라벨은 헤딩 «맨 앞»(장식 이모지 ⊕ 선택적 「조항」 뒤)에 온다.
 *    트랙 표지는 괄호나 문장 «안»에 온다 — 실물: "(2026-08-26 · 🅣 제보 둘 → 🅢 반증·통합)".
 *    ⇒ 이 구분이 없으면 위양성이 «둘» 난다(첫 두 판이 15 를 냈고 실제는 13 이었다).
 */
const CLAUSE_HEADING = /^#{3,5}\s+(?:[🆕🚨⛔⭐🔌🎯🩸🔑📌✅❌\s·]*)(?:조항\s*)?([🅐🅑🅒🅓🅔🅕🅖🅗🅘🅙🅚🅛🅜🅝🅞🅟🅠🅡🅢🅣🅤🅥])/u;
// ⛔ 판정은 «네» 종류이고 저자마다 «다른 말»로 적는다. 좁게 잡으면 과대 집계된다 —
//    첫 판(#14938)이 그렇게 «19»를 냈고 실제는 «15»였다(🅓·🅛·🅝·🅡 넷을 놓쳤다).
const VERDICT_DONE = /로직화\s*«?완료|저작기가\s*«?스스로»?\s*(?:표시|낸다)|도구가\s*이미/u;
const VERDICT_CANNOT = /기계가\s*«?못»?\s*(?:한다|하는)|사람\s*칸으로\s*남긴다|⇒\s*«?사람\s*칸|사람\s*칸\s*\+0|기계가\s*판정할\s*수\s*있나\s*—\s*\*{0,3}지금은\s*아니다/u;
const VERDICT_CANDIDATE = /로직화\s*후보|로직화\s*중|로직화는\s*«?아직\s*안\s*됐다|흡수\s*후보/u;
/** 🆕 넷째 — 로직화를 «시도했고 거부»된 것. 「아직 안 물었다」와 «다른 값»이다. */
const VERDICT_REJECTED = /로직화는?\s*«?기각/u;

export interface Clause {
  readonly label: string;
  readonly line: number;
  readonly lineCount: number;
  readonly verdicts: readonly string[];
  readonly heading: string;
}

export function readManual(path = MANUAL): readonly string[] {
  return readFileSync(path, 'utf8').split('\n');
}

/** 조항 = ### 이상 헤딩 ⊕ 원문자 라벨. 본문은 다음 조항/절 헤딩 직전까지. */
export function collectClauses(lines: readonly string[]): readonly Clause[] {
  const heads: Array<{ index: number; heading: string }> = [];
  lines.forEach((line, index) => {
    if (CLAUSE_HEADING.test(line)) heads.push({ index, heading: line });
  });

  return heads.map(({ index, heading }) => {
    let end = lines.length;
    for (let j = index + 1; j < lines.length; j += 1) {
      const candidate = lines[j]!;
      if (/^##\s/u.test(candidate) || CLAUSE_HEADING.test(candidate)) { end = j; break; }
    }
    // ⛔ 판정 문장 «안»에 마크다운 강조(`***`)와 꺾쇠(«»)가 끼면 정규식이 못 문다 —
    //    실물: 🅓 의 "로직화는 ***아직 안 됐다***". 그래서 «걷고» 잰다.
    const body = lines.slice(index, end).join('\n').replace(/[*«»]/gu, '');
    const verdicts: string[] = [];
    if (VERDICT_DONE.test(body)) verdicts.push('완료');
    if (VERDICT_CANNOT.test(body)) verdicts.push('못함');
    if (VERDICT_CANDIDATE.test(body)) verdicts.push('후보');
    if (VERDICT_REJECTED.test(body)) verdicts.push('기각');
    return {
      label: CLAUSE_HEADING.exec(heading)![1]!,
      line: index + 1,
      lineCount: end - index,
      verdicts,
      heading: heading.trim(),
    };
  });
}

/** §6 의 「사람 칸」이 «어느 조항»을 무는가 — 표기 `①a … 🅞 · 🅡` 를 읽는다.
 *  🩸 계기(2026-09-01): §6 이 「사람 칸 여섯」을 선언하면서 조항 20개를 «그 칸에 안 걸었다».
 *     그래서 저자는 「지금 쓰는 줄에서 무는 것이 몇 개인가」를 알 수 없었다.
 *  ⛔ 이 자가 «못 보는» 것: 한 조항이 «두 칸»을 물 수 있다(완료 ⊕ 사람이 섞인 조항 여덟). 중복은 그대로 센다. */
export interface SlotLoad { readonly slot: string; readonly clauses: readonly string[] }

const SLOT_LINE = /^\s*(①[a-d]?|[②③④⑤⑥])\s+(.+)$/u;
const CLAUSE_IN_LINE = /[🅐🅑🅒🅓🅔🅕🅖🅗🅘🅙🅚🅛🅜🅝🅞🅟🅠🅡🅢🅣🅤🅥]/gu;

export function collectSlotLoads(lines: readonly string[]): readonly SlotLoad[] {
  // ⛔ 원문자(①②⑤…)가 이 문서에서 «두 뜻»이다 — §6 의 「사람 칸」이면서 §7 의 「후보 번호」다.
  //    실물(2026-09-01): §7 의 `⑤ 🅑 «세 번 죽은 골»` 이 「칸 ⑤」로 잡혀 «두 번» 찍혔다.
  //    ⇒ §6 절 «안»으로 좁힌다. 절 밖의 원문자는 칸이 아니다.
  const start = lines.findIndex(l => /^##\s*6\./u.test(l));
  const scope = start < 0 ? lines : lines.slice(start, (() => {
    const rel = lines.slice(start + 1).findIndex(l => /^##\s/u.test(l));
    return rel < 0 ? lines.length : start + 1 + rel;
  })());
  const out: SlotLoad[] = [];
  for (const line of scope) {
    const m = SLOT_LINE.exec(line);
    if (!m) continue;
    const clauses = [...new Set(m[2]!.match(CLAUSE_IN_LINE) ?? [])];
    if (clauses.length === 0) continue;          // 조항을 «안 단» 칸은 세지 않는다(0 과 「안 적음」을 안 섞는다)
    out.push({ slot: m[1]!, clauses });
  }
  return out;
}

/** §6 머리말이 선언한 「사람 몫」 — 매뉴얼이 canonical 이므로 «수»를 이 파일에 박지 않는다.
 *  🩸 계기(2026-10-31): `«여섯»` 이 여기 박혀 있었고 매뉴얼 §6 이 `«둘»` 로 바뀐 뒤에도 그 수를 계속 찍었다. */
const HUMAN_SLOT_DECLARATION = /사람\s*(?:몫|칸)\s*«([^»]+)»/u;

export function declaredHumanSlots(lines: readonly string[]): string | null {
  const start = lines.findIndex(l => /^##\s*6\./u.test(l));
  if (start < 0) return null;
  const rel = lines.slice(start + 1).findIndex(l => /^##\s/u.test(l));
  const end = rel < 0 ? lines.length : start + 1 + rel;
  for (const line of lines.slice(start, end)) {
    const match = HUMAN_SLOT_DECLARATION.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

export interface NarrativeCount { readonly name: string; readonly lines: number }

/** 머리말이 「여기 없다」고 선언한 것들이 실제로 몇 줄인가. */
export function countNarrative(lines: readonly string[]): readonly NarrativeCount[] {
  const probes: ReadonlyArray<readonly [string, RegExp]> = [
    ['📏 실측 표지', /📏/u],
    ['실물·사례', /실물|사례/u],
    ['날짜(2026-)', /2026-/u],
    ['PR 번호', /#1[0-9]{4}/u],
    ['차수(NNN차)', /[0-9]{2,3}차/u],
  ];
  return probes.map(([name, re]) => ({ name, lines: lines.filter(l => re.test(l)).length }));
}

function report(path = MANUAL): number {
  const lines = readManual(path);
  const clauses = collectClauses(lines);
  const unjudged = clauses.filter(c => c.verdicts.length === 0);

  console.log(`📄 ${path} — ${lines.length}줄`);
  console.log('');
  console.log(`축① 로직화 — 조항 ${clauses.length} · ⛔ §0 판정이 «없는» 조항 ${unjudged.length}`);
  for (const c of unjudged) {
    console.log(`   ${c.label} L${String(c.line).padEnd(5)} ${String(c.lineCount).padStart(3)}줄  ${c.heading.slice(0, 62)}`);
  }
  console.log('');
  const slots = collectSlotLoads(lines);
  const mapped = new Set(slots.flatMap(s => s.clauses));
  console.log(`축② 사람 칸 — §6 선언 «${declaredHumanSlots(lines) ?? '없음'}» ↔ 조항 ${clauses.length} · 칸에 «걸린» 조항 ${mapped.size}`);
  for (const { slot, clauses: c } of slots) {
    console.log(`   ${slot.padEnd(3)} ${String(c.length).padStart(2)}개  ${c.join(' ')}`);
  }
  const unmapped = clauses.map(c => c.label).filter(l => !mapped.has(l));
  if (unmapped.length > 0) console.log(`   ⛔ 어느 칸에도 «안 걸린» 조항 ${unmapped.length}: ${[...new Set(unmapped)].join(' ')}`);
  else console.log('   ✅ 모든 조항이 칸에 걸려 있다.');
  console.log('   ⚠️ 한 조항이 «두 칸»을 물 수 있다 — 중복은 그대로 센다.');
  console.log('');
  console.log('축③ 팩트 위주 — 머리말: "서사·실측·이력은 여기 없다(→ EVIDENCE · git log)"');
  for (const { name, lines: n } of countNarrative(lines)) {
    console.log(`   ${name.padEnd(14)} ${String(n).padStart(4)}줄  (${((n / lines.length) * 100).toFixed(1)}%)`);
  }
  return 0;
}

/**
 * ⭐ 자를 먼저 건다 — ⛔ «합성» 표본으로 건다. 실물 조항을 관문으로 쓰면 자를 «쓰는 일» 자체가 관문을 깬다:
 *    2026-09-01 에 조항 13개에 판정을 달았더니 「판정 없는 조항」이 사라져 self-check 이 «성공 때문에» 빨강이 됐다.
 * ⛔ 그리고 합성이라고 퇴화가 아니다 — 아래 표본은 «각각 다른 분기»를 탄다
 *    (라벨 자리 · 판정 있음/없음 · 다른 어휘 · 마크다운 강조 · 기각 · 트랙 표지).
 */
const FIXTURE: readonly string[] = [
  '### 🅐 **판정이 있는 조항**',
  '',
  '> 🔎 §0 관문 — 로직화 «완료»(도구가 낸다).',
  '',
  '### 🅑 **판정이 없는 조항**',
  '',
  '| | 규칙 | 왜 |',
  '| ⛔ | 무엇을 한다 | 어떤 이유 |',
  '',
  '### 🅒 **판정을 «다른 말»로 적은 조항**',
  '',
  '> §0 관문의 답: 기계가 판정할 수 있나 — 지금은 아니다.',
  '',
  '### 🅓 **판정에 마크다운 강조가 낀 조항**',
  '',
  '> 이 줄의 로직화는 ***아직 안 됐다*** — 후보로 남긴다.',
  '',
  '### 🅔 **로직화가 «기각»된 조항**',
  '',
  '> ❌ 로직화는 기각됐다 — 근거 문서를 보라.',
  '',
  '### 🆕⛔⭐ **트랙 표지는 조항이 아니다** (2026-08-26 · 🅣 제보 둘 → 🅢 반증·통합)',
  '',
  '아무 내용.',
];

function selfCheck(): number {
  const clauses = collectClauses(FIXTURE);
  const by = (label: string) => clauses.find(c => c.label === label);
  const checks: ReadonlyArray<readonly [string, boolean, string]> = [
    ['판정 있음 🅐', by('🅐')?.verdicts.includes('완료') === true, JSON.stringify(by('🅐')?.verdicts)],
    ['판정 없음 🅑', by('🅑')?.verdicts.length === 0, JSON.stringify(by('🅑')?.verdicts)],
    ['다른 어휘 🅒', by('🅒')?.verdicts.includes('못함') === true, JSON.stringify(by('🅒')?.verdicts)],
    ['강조가 낀 🅓', by('🅓')?.verdicts.includes('후보') === true, JSON.stringify(by('🅓')?.verdicts)],
    ['기각 🅔', by('🅔')?.verdicts.includes('기각') === true, JSON.stringify(by('🅔')?.verdicts)],
    ['트랙 표지를 안 센다', clauses.length === 5, `조항 ${clauses.length}개`],
    ['칸→조항 표기를 읽는다', collectSlotLoads(['   ①a 무엇을·왜를 정한다     🅞 · 🅡', '   ② 조항 없는 칸']).length === 1, JSON.stringify(collectSlotLoads(['   ①a x 🅞 · 🅡', '   ② 없음']))],
  ];
  let ok = true;
  for (const [name, passed, detail] of checks) {
    console.log(`${passed ? '✅' : '⛔'} ${name.padEnd(20)} ${detail}`);
    if (!passed) ok = false;
  }
  if (!ok) { console.log('⛔ 자가 고장났다 — 이 자로 낸 수를 믿지 마라.'); return 1; }
  console.log('✅ 자가 산다 (여섯 관문 · 합성 표본이 각각 다른 분기를 «탄다»).');
  return 0;
}

if (import.meta.main) {
  process.exit(process.argv.includes('--self-check') ? selfCheck() : report());
}
