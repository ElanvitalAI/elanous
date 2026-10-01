import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isSupervisorContract, isSupervisorDecisionSection, rank, splitGoalSections, supervisorGoalDigest } from './goal-digest.js';

/**
 * ⛔ 2026-07-28 실측이 만든 테스트다. 감독자 프롬프트가 `골(수용기준·스코프 경계):` 라는 라벨로
 * `goal.slice(0, 3000)` 을 실었는데, 저작기 골은 **앞이 grounding 후보 목록**이라
 * **라벨이 약속한 절이 한 번도 도착하지 않았다.** 그 결과 감독자가
 * *"원문이 `src/auto` 에서 잘려 수렴 범위를 확정할 수 없다"* 며 UNCONVERGEABLE 을 냈고
 * **일하던 런이 자름 때문에 버려졌다.**
 */

const GOAL = 'docs/goals/GOAL-g1-aggregator-swap-retry-2026-07-28.txt';

/** 계약 절 — 감독 판단의 재료. 하나라도 없으면 감독이 스코프를 못 정한다. */
const CONTRACT = ['ACCEPTANCE CRITERIA', 'RULES', '의도적 스코프 경계', 'WHAT TO BUILD'] as const;

function body(text: string): string { return text.split('⚠️ 이 요약에서 빠진 것')[0]!; }

describe('감독자용 골 요약', () => {
  it('`## ` 로 절을 가른다 — 서두도 잃지 않는다', () => {
    const s = splitGoalSections('서두\n\n## A\n본문A\n\n## B\n본문B');
    expect(s.map((x) => x.title)).toEqual(['', 'A', 'B']);
    expect(s[0]!.body).toBe('서두');
  });

  it('표제가 없으면 전체 서두를 빈 제목 절로 보존한다', () => {
    expect(splitGoalSections('서두\n\n본문')).toEqual([{ title: '', body: '서두\n\n본문' }]);
  });

  it('기존 정규식처럼 공백만 캡처한 ## 줄을 공백 제목 표제로 보존한다', () => {
    expect(splitGoalSections('## A\n본문\n##  \n끝')).toEqual([
      { title: 'A', body: '본문' },
      { title: ' ', body: '끝' },
    ]);
  });

  // ⛔⭐ 무인 리뷰 should-fix(2026-08-04 · 2R): 「인식되는 경우」만 남고 「인식되지 «않는» 경우」가
  //   지워져 있었다. 정규식 경계는 «양쪽»을 다 물어야 회귀를 잡는다.
  //   ⇒ main 원본과 대조해 다섯 케이스가 «동일»함을 확인하고 고정한다(사람 실측 2026-08-04).
  it('기존 정규식이 표제로 «인식하지 않는» 경계도 보존한다 — 탭 전용·제목 없음', () => {
    // `##\t` — `\s+` 가 탭을 먹고 `.+?` 가 남을 게 없다 ⇒ 표제 «아님»
    expect(splitGoalSections('## A\n본문\n##\t\n끝')).toEqual([
      { title: 'A', body: '본문\n##\t\n끝' },
    ]);
    // `##` — 뒤에 아무것도 없다 ⇒ 표제 «아님»
    expect(splitGoalSections('## A\n본문\n##\n끝')).toEqual([
      { title: 'A', body: '본문\n##\n끝' },
    ]);
    // ⭐ 대조: 공백+탭 «혼합»은 `.+?` 가 한 칸을 잡아 표제 «맞음»
    expect(splitGoalSections('## A\n본문\n## \t \n끝')).toEqual([
      { title: 'A', body: '본문' },
      { title: ' ', body: '끝' },
    ]);
  });

  it('기존 정규식의 NBSP·수직 탭 제목 인식 계약을 보존한다', () => {
    expect(splitGoalSections(`서두\n##\u00a0NBSP\n본문 N\n##\vVERTICAL\n본문 V`)).toEqual([
      { title: '', body: '서두' },
      { title: 'NBSP', body: '본문 N' },
      { title: 'VERTICAL', body: '본문 V' },
    ]);
  });

  it('CRLF 문서에서 각 절의 원문 본문을 정확히 분리한다', () => {
    expect(splitGoalSections('서두\r\n## A\r\n본문 A\r\n## B\r\n본문 B')).toEqual([
      { title: '', body: '서두' },
      { title: 'A', body: '본문 A' },
      { title: 'B', body: '본문 B' },
    ]);
  });

  it.skipIf(!existsSync(GOAL))('⭐ private 실제 저작기 골에서 계약 절이 **전부 도착한다** (옛 prefix 자름은 하나도 못 실었다)', () => {
    const goal = readFileSync(GOAL, 'utf8');
    const old = goal.slice(0, 3000);
    const digest = supervisorGoalDigest(goal, 3000);
    const b = body(digest.text);

    // 옛 방식이 실패했다는 것을 같이 고정한다 — 이 테스트가 무엇을 막는지 남긴다.
    expect({ 옛방식_수용기준: old.includes('ACCEPTANCE CRITERIA') }).toEqual({ 옛방식_수용기준: false });

    for (const key of CONTRACT) {
      expect({ [`새방식_${key}`]: b.includes(key) }).toEqual({ [`새방식_${key}`]: true });
    }
    expect({ 통째로_빠진절: [...digest.droppedSections] }).toEqual({ 통째로_빠진절: [] });

    // ⛔⭐ 제목만 보면 **본문이 잘려도 통과**한다(리뷰 must-fix: Goodhart). ⇒ 계약 절 **본문**이
    //   원문 그대로 들어갔는지 본다. 원문에서 그 절을 떼어내 요약에 통째로 있는지 대조한다.
    const sectionBody = (src: string, title: string): string => {
      const m = new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm').exec(src);
      return (m?.[1] ?? '').trim();
    };
    for (const key of ['ACCEPTANCE CRITERIA', 'RULES'] as const) {
      const want = sectionBody(goal, key);
      expect({ [`${key}_본문온전`]: want.length > 0 && b.includes(want) })
        .toEqual({ [`${key}_본문온전`]: true });
    }
  });

  it.skipIf(!existsSync(GOAL))('⛔ private 실제 골 예산을 넘기지 않는다 (초판은 말미 경고를 안 세어 3229 > 3000 이었다)', () => {
    const goal = readFileSync(GOAL, 'utf8');
    for (const limit of [1200, 2000, 3000, 6000]) {
      const r = supervisorGoalDigest(goal, limit);
      expect({ limit, 지킴: r.text.length <= limit }).toEqual({ limit, 지킴: true });
    }
  });

  it.skipIf(!existsSync(GOAL))('⭐ private 실제 골에서 예산이 빠듯해도 계약 절이 **통째로 사라지지 않는다** — 절 안에서 자르고 표시한다', () => {
    const goal = readFileSync(GOAL, 'utf8');
    const r = supervisorGoalDigest(goal, 1600);
    const b = body(r.text);
    // 좁은 예산에서도 최우선 계약 절은 남는다.
    expect({ 수용기준: b.includes('ACCEPTANCE CRITERIA') }).toEqual({ 수용기준: true });
    // 자른 곳은 반드시 표시된다 — 조용한 자름이 사고의 원인이었다.
    expect({ 자름표시: r.text.includes('잘림') || r.text.includes('빠진 것') })
      .toEqual({ 자름표시: true });
  });

  it.skipIf(!existsSync(GOAL))('⛔ private 실제 골에서 무엇이 빠졌는지 말하고, 그걸로 판정하지 말라고 적는다', () => {
    const goal = readFileSync(GOAL, 'utf8');
    const r = supervisorGoalDigest(goal, 1600);
    expect({ 안내문: r.text.includes('안 본 것이지 없는 것이 아니다') }).toEqual({ 안내문: true });
  });

  it.skipIf(!existsSync(GOAL))('private 실제 골에서 grounding 나열 줄을 걷어낸다 — 감독 판단에 값이 낮고 길이만 먹는다', () => {
    const goal = readFileSync(GOAL, 'utf8');
    const r = supervisorGoalDigest(goal, 3000);
    expect({ 걷어냄: r.droppedNoiseLines > 0 }).toEqual({ 걷어냄: true });
    expect({ 잔존: body(r.text).includes('Candidate requiring path tracing') }).toEqual({ 잔존: false });
  });
});

/**
 * ⛔⭐ 손으로 쓴 골은 **한글 헤더**를 쓴다(T 트랙 템플릿 · 오늘 무인 완주 두 건이 이 방언 위에 섰다).
 * 초판 `PRIORITY` 는 영문만 담아 **계약 절을 최하위로 매겼다** — 이 파일이 막으려는 사고가
 * **대상만 바뀌어** 재발한다(T 리뷰 must-fix). 이 fixture 가 그 갈림을 고정한다.
 */
const KOREAN_GOAL = [
  '## 왜 (실측 · 2026-07-28)',
  'x'.repeat(1200),
  '',
  '## 무엇을 만드나',
  'y'.repeat(1200),
  '',
  '## 관측 (제1원칙)',
  'z'.repeat(1200),
  '',
  '## 수용 기준',
  '- 기준 하나',
  '- 기준 둘',
  '',
  '## 파일 경계',
  '- 이 파일만 건드린다',
  '',
  '## ⚠️ 전제가 틀리면 넓히지 말고 멈춰라',
  '- 멈춘다',
].join('\n');

describe('한글 헤더 방언 (손글씨 골)', () => {
  it('⭐ `rank()` 가 한글 계약 절을 상위로 올린다 — 영문 전용이면 최하위였다', () => {
    const 최하위 = rank('아무 상관 없는 제목');
    for (const title of ['수용 기준', '파일 경계', '⚠️ 전제가 틀리면 넓히지 말고 멈춰라']) {
      expect({ [title]: rank(title) < 최하위 }).toEqual({ [title]: true });
    }
  });

  it('⛔ 예산이 빠듯해도 한글 계약 절이 살아남는다 (긴 서술 절이 먼저 밀린다)', () => {
    const r = supervisorGoalDigest(KOREAN_GOAL, 1500);
    const b = r.text.split('⚠️ 이 요약에서 빠진 것')[0]!;
    expect({ 수용기준: b.includes('수용 기준') }).toEqual({ 수용기준: true });
    expect({ 파일경계: b.includes('파일 경계') }).toEqual({ 파일경계: true });
    expect({ 예산: r.text.length <= 1500 }).toEqual({ 예산: true });
  });

  it('⭐ 아주 작은 예산에서도 **계약 절이 통째로 사라지지 않는다** (리뷰 must-fix ②③)', () => {
    // ⛔ 초판 테스트는 `본문있음: b.length > 0` 만 봤다 — **일부 계약 절이 사라져도 통과**하는
    //   Goodhart 테스트였다(무인 리뷰가 잡았다). ⇒ **계약 절 제목을 각각** 본다.
    for (const limit of [300, 500, 900, 1500]) {
      const r = supervisorGoalDigest(KOREAN_GOAL, limit);
      const b = r.text.split('⚠️ 이 요약에서 빠진 것')[0]!;
      expect({ limit, 예산: r.text.length <= limit }).toEqual({ limit, 예산: true });
      // 최우선 계약 절은 어떤 예산에서도 남는다.
      expect({ limit, 수용기준: b.includes('수용 기준') }).toEqual({ limit, 수용기준: true });
      // ⭐ 뒤쪽 계약 절도 `break` 로 통째 탈락하지 않는다 — 예산이 아주 작으면 잘릴 수는 있다.
      if (limit >= 500) {
        expect({ limit, 파일경계: b.includes('파일 경계') }).toEqual({ limit, 파일경계: true });
      }
    }
  });

  it('수용 기준 동의어 절은 절단해도 원문의 완전한 행만 남긴다', () => {
    for (const title of ['ACCEPTANCE CRITERIA', '수용 기준', '수용기준']) {
      const sourceLines = ['- 첫 기준은 온전하다', '- 둘째 기준도 온전하다', `- 셋째 기준은 예산을 넘겨 통째로 빠진다 ${'x'.repeat(1000)}`];
      const source = [`## ${title}`, ...sourceLines].join('\n');
      const result = supervisorGoalDigest(source, 180);
      const rendered = splitGoalSections(result.text).find((section) => section.title === title)?.body ?? '';
      const retained = rendered.split('\n').filter((line) => line.startsWith('- '));

      expect(retained.length).toBeGreaterThan(0);
      expect(retained.length).toBeLessThan(sourceLines.length);
      expect(retained.every((line) => sourceLines.includes(line))).toBe(true);
      expect(result.truncatedSections).toEqual([title]);
    }
  });

  it('⭐ 잘림 표시가 **실제 누락량**을 말한다 (리뷰 must-fix ④ — 과소 보고 금지)', () => {
    const body = 'z'.repeat(2000);
    const r = supervisorGoalDigest(`## 수용 기준\n${body}`, 800);
    const m = /\[이 절에서 (\d+)자 잘림/.exec(r.text);
    expect({ 표시있음: !!m }).toEqual({ 표시있음: true });
    const reported = Number(m![1]);
    const kept = (r.text.match(/z+/)?.[0] ?? '').length;
    // 보고한 잘림 + 남은 본문 = 원본. 과소 보고면 이 등식이 깨진다.
    expect({ 합: reported + kept }).toEqual({ 합: body.length });
  });

  it('부분만 실린 절을 본문과 별도 산출 값으로 돌려준다', () => {
    const body = 'z'.repeat(2000);
    const r = supervisorGoalDigest(`## 수용 기준\n${body}`, 800);

    expect(r.truncatedSections).toEqual(['수용 기준']);
    expect(r.text).toContain('⚠️ 이 요약에서 빠진 것: 절 1개 부분(수용 기준).');
    expect(r.droppedSections).toEqual([]);
    expect(r.droppedNoiseLines).toBe(0);
  });
});

/**
 * ⛔⭐ **예산이 중간에 마르는 모양** — 앞 계약 절이 크면 뒤 계약 절이 통째로 밀린다(리뷰 must-fix ②).
 * 옛 조건(`remaining <= head + minSection` 이면 **break**)은 **작은 절이 들어갈 자리가 남아 있어도**
 * 뒤를 전부 버렸다. 새 조건은 `room <= 0` 일 때만 버리므로 **작은 절은 슬라이스로라도 실린다.**
 */
describe('예산이 마를 때 뒤 계약 절', () => {
  const CROWDED = [
    '## 수용 기준', 'a'.repeat(900), '',
    '## RULES', 'b'.repeat(900), '',
    '## 파일 경계', 'c'.repeat(300), '',
    '## WHAT TO BUILD', 'd'.repeat(300),
  ].join('\n');

  it('⭐ 자리가 남으면 뒤 계약 절을 슬라이스로라도 싣는다 (옛 break 는 통째로 버렸다)', () => {
    const r = supervisorGoalDigest(CROWDED, 800);
    const b = r.text.split('⚠️ 이 요약에서 빠진 것')[0]!;
    expect({ 수용기준: b.includes('수용 기준') }).toEqual({ 수용기준: true });
    // ⛔ 여기가 갈림점 — 옛 조건이면 `파일 경계` 가 dropped 로 간다.
    expect({ 파일경계: b.includes('파일 경계') }).toEqual({ 파일경계: true });
    expect({ 예산: r.text.length <= 800 }).toEqual({ 예산: true });
  });

  it('⭐ 예산이 아주 빠듯해도 **절을 버리지 않고 잘라서 싣고, 잘랐다고 말한다**', () => {
    // ⛔ 초판 기대는 *"버린다"* 였다. 워터필링으로 바꾼 뒤에는 **아무것도 통째로 안 버린다** —
    //   전부 슬라이스로 싣고 잘림을 표시한다. 감독이 "안 본 것"과 "없는 것"을 가릴 수 있으므로
    //   이쪽이 이 장치의 목적에 맞다.
    for (const limit of [300, 400, 800]) {
      const r = supervisorGoalDigest(CROWDED, limit);
      const b = r.text.split('⚠️ 이 요약에서 빠진 것')[0]!;
      expect({ limit, 예산: r.text.length <= limit }).toEqual({ limit, 예산: true });
      expect({ limit, 절수: (b.match(/^## /gm) ?? []).length }).toEqual({ limit, 절수: 4 });
      expect({ limit, 잘림표시: r.text.includes('자 잘림') }).toEqual({ limit, 잘림표시: true });
    }
  });
});

describe('명시적 감독 계약 분류와 우선 예산', () => {
  it('다섯 감독 판정 절과 기존 규칙 절만 계약으로 분류하고 일반어 부분 일치는 거부한다', () => {
    for (const title of ['ACCEPTANCE CRITERIA — 검증', 'WHAT TO BUILD', 'SCOPE BOUNDARY', '의도적 스코프 경계', '불변식', '판정 신호', 'RULES']) {
      expect(isSupervisorContract(title)).toBe(true);
    }
    for (const title of ['관측 (제1원칙)', '경계 조건 메모', '사전 실측', '불변식에 대한 배경', '판정 신호 분석', '규칙적인 작업']) {
      expect(isSupervisorContract(title)).toBe(false);
      expect(isSupervisorDecisionSection(title)).toBe(false);
    }
    for (const title of ['ACCEPTANCE CRITERIA — 검증', 'WHAT TO BUILD', 'SCOPE BOUNDARY', '의도적 스코프 경계', '불변식', '판정 신호']) {
      expect(isSupervisorDecisionSection(title)).toBe(true);
    }
  });

  it('다섯 긴 감독 계약 본문 각각을 긴 일반 서술보다 더 보존하면서 모든 절과 상한을 유지한다', () => {
    const contracts = ['ACCEPTANCE CRITERIA', 'WHAT TO BUILD', 'SCOPE BOUNDARY', '불변식', '판정 신호'];
    const goal = contracts.flatMap((title, index) => [`## ${title}`, ...Array.from({ length: 40 }, () => String.fromCharCode(97 + index).repeat(100)), ''])
      .concat(['## 일반 서술', 'p'.repeat(4000)]).join('\n');
    const result = supervisorGoalDigest(goal, 3000);
    const kept = (title: string, char: string): number => {
      const section = splitGoalSections(result.text).find((candidate) => candidate.title === title);
      return (section?.body.match(new RegExp(char, 'g')) ?? []).join('').length;
    };
    const proseKept = kept('일반 서술', 'p');

    expect(kept('ACCEPTANCE CRITERIA', 'a')).toBeGreaterThan(0);
    expect(kept('ACCEPTANCE CRITERIA', 'a')).toBeLessThan(4000);
    for (const [index, title] of contracts.entries()) {
      if (title === 'ACCEPTANCE CRITERIA') continue;
      expect(kept(title, String.fromCharCode(97 + index))).toBeGreaterThan(proseKept);
    }
    expect(result.text.length).toBeLessThanOrEqual(3000);
    expect(result.droppedSections).toEqual([]);
    expect(result.text).toContain('이 절에서');
  });

  it('계약 절이 없으면 서술 절에 전체 예산을 배분하고 짧은 입력을 온전히 보존한다', () => {
    const prose = ['## 관측 (제1원칙)', 'a'.repeat(2000), '', '## 배경', 'b'.repeat(2000)].join('\n');
    const short = '## 배경\n짧은 본문';
    const result = supervisorGoalDigest(prose, 1200);

    expect(result.text).toContain('## 관측 (제1원칙)');
    expect(result.text).toContain('## 배경');
    expect(result.text.length).toBeLessThanOrEqual(1200);
    expect(supervisorGoalDigest(short, 3000)).toEqual({
      text: short,
      droppedSections: [],
      truncatedSections: [],
      droppedNoiseLines: 0,
    });
  });
});

describe('실행 경로', () => {
  it('`seams.ts`의 diagnose가 감독 요약 경로를 호출한다', () => {
    const seams = readFileSync('src/self-implement/seams.ts', 'utf8');
    expect(seams).toContain('const goalDigest = supervisorGoalDigest(goal, 3000);');
  });
});

const INDEPENDENT_DECISION_TITLES = ['ACCEPTANCE CRITERIA', '수용 기준', '수용기준', 'WHAT TO BUILD', '무엇을 만드나', 'SCOPE BOUNDARY', '스코프 경계', '의도적 스코프 경계', '파일 경계', '불변식', '판정 신호'] as const;

function independentDecisionTitle(title: string): string | undefined {
  const normalized = title.trim();
  return INDEPENDENT_DECISION_TITLES.find((candidate) => normalized === candidate
    || (normalized.startsWith(candidate) && /^\s*(?:[—:：(\[·]|[-–]\s)/.test(normalized.slice(candidate.length))));
}

function retainedBodyLength(source: string, output: string): number {
  const marker = '\n… [이 절에서';
  const outputBody = output.slice(0, output.indexOf(marker) === -1 ? output.length : output.indexOf(marker));
  return outputBody.startsWith(source.slice(0, outputBody.length)) ? Math.min(source.length, outputBody.length) : 0;
}

function occurrenceSafeOutputSections(source: readonly { title: string; body: string }[], output: readonly { title: string; body: string }[]): Map<number, number> {
  const used = new Set<number>();
  const kept = new Map<number, number>();
  for (const [sourceIndex, sourceSection] of source.entries()) {
    if (!sourceSection.body.trim()) continue;
    const outputIndex = output.findIndex((outputSection, index) => !used.has(index)
      && outputSection.title === sourceSection.title
      && retainedBodyLength(sourceSection.body, outputSection.body) > 0);
    if (outputIndex === -1) continue;
    used.add(outputIndex);
    kept.set(sourceIndex, retainedBodyLength(sourceSection.body, output[outputIndex]!.body));
  }
  return kept;
}

describe('docs/goals 전수 보존율', () => {
  it.skipIf(!existsSync('docs/goals'))('독립 제목 기준과 occurrence-safe 대응으로 감독 계약 절을 서술 절보다 더 보존한다', () => {
    let contractOriginal = 0;
    let contractKept = 0;
    let proseOriginal = 0;
    let proseKept = 0;
    const contractTitles = new Set<string>();
    const retentionByPrefix = new Map<string, { original: number; kept: number }>();

    for (const file of readdirSync('docs/goals').filter((name) => name.endsWith('.md'))) {
      const source = readFileSync(`docs/goals/${file}`, 'utf8');
      const sourceSections = splitGoalSections(source);
      const output = supervisorGoalDigest(source, 3000);
      const keptByOccurrence = occurrenceSafeOutputSections(sourceSections, splitGoalSections(output.text));
      for (const [index, section] of sourceSections.entries()) {
        if (!section.body.trim()) continue;
        const kept = keptByOccurrence.get(index) ?? 0;
        const decisionTitle = independentDecisionTitle(section.title);
        if (decisionTitle) {
          contractOriginal += section.body.length;
          contractKept += kept;
          const retention = retentionByPrefix.get(decisionTitle) ?? { original: 0, kept: 0 };
          retention.original += section.body.length;
          retention.kept += kept;
          retentionByPrefix.set(decisionTitle, retention);
        } else {
          proseOriginal += section.body.length;
          proseKept += kept;
        }
        if (isSupervisorContract(section.title)) contractTitles.add(section.title);
      }
    }

    const contractRetention = contractKept / contractOriginal;
    const proseRetention = proseKept / proseOriginal;
    console.log(`goal digest retention: 계약 ${(contractRetention * 100).toFixed(1)}% 서술 ${(proseRetention * 100).toFixed(1)}%`);
    console.log(`goal digest retention by prefix: ${JSON.stringify(Object.fromEntries([...retentionByPrefix].map(([prefix, value]) => [prefix, `${(value.kept / value.original * 100).toFixed(1)}%`])))}`);
    console.log(`goal digest contracts: ${JSON.stringify([...contractTitles].sort())}`);
    expect(contractRetention).toBeGreaterThan(proseRetention);
    expect((retentionByPrefix.get('ACCEPTANCE CRITERIA')!.kept / retentionByPrefix.get('ACCEPTANCE CRITERIA')!.original) * 100).toBeGreaterThan(5.5);
    expect([...contractTitles].filter((title) => title.startsWith('관측') || title.startsWith('경계 조건'))).toEqual([]);
  });

  it('같은 제목의 중간 occurrence가 빠져도 본문 접두사로 뒤 절 보존량을 정확히 대응한다', () => {
    const source = splitGoalSections(['## 계약', 'first-body', '', '## 계약', 'missing-body', '', '## 계약', 'later-body'].join('\n'));
    const output = splitGoalSections(['## 계약', 'first-body', '', '## 계약', 'later-body'].join('\n'));
    expect([...occurrenceSafeOutputSections(source, output)]).toEqual([[0, 10], [2, 10]]);
  });
});

describe('워터필링 — 잔액 재분배', () => {
  it('⭐ **계약 집단이 안 쓴 몫이 서술 절로 흘러간다** (안 흐르면 예산이 그냥 버려진다)', () => {
    // ⚠️ 판별점을 실측으로 찾았다 — 계약 절이 **전부 짧아야** 집단 잔액이 생긴다.
    //   (한 절만 짧으면 같은 집단의 긴 절이 워터필링 내부에서 이미 흡수한다)
    //   실측: 잔액 흐름 O → 906자 · X → 306자.
    const G = ['## 수용 기준', '짧다', '', '## RULES', '짧다', '', '## 무관한 잡담', 'z'.repeat(3000)].join('\n');
    const r = supervisorGoalDigest(G, 1200);
    const b = r.text.split('⚠️ 이 요약에서 빠진 것')[0]!;
    const prose = /## 무관한 잡담\n([\s\S]*?)(?=\n## |$)/.exec(b)?.[1] ?? '';
    expect({ 잔액을_받음: prose.length > 500 }).toEqual({ 잔액을_받음: true });
    expect({ 예산: r.text.length <= 1200 }).toEqual({ 예산: true });
  });

  it('짧은 절과 긴 절을 반복 재분배해도 본문 길이를 넘겨 할당하지 않는다', () => {
    const source = ['## 수용 기준', 'a'.repeat(3), '', '## WHAT TO BUILD', 'b'.repeat(2000), '', '## 일반 서술', 'c'.repeat(2000)].join('\n');
    const result = supervisorGoalDigest(source, 1000);
    const sections = splitGoalSections(result.text);
    const retained = (title: string, char: string) => (sections.find((section) => section.title === title)?.body.match(new RegExp(`${char}+`))?.[0] ?? '').length;

    expect(retained('수용 기준', 'a')).toBe(3);
    expect(retained('WHAT TO BUILD', 'b')).toBeLessThanOrEqual(2000);
    expect(retained('일반 서술', 'c')).toBeLessThanOrEqual(2000);
    expect(result.text.length).toBeLessThanOrEqual(1000);
  });
});
