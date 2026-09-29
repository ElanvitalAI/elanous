// ── anti-ai-slop 린터 — 규칙서가 «전제하던» 강제자 (2026-09-08) ─────────────────
//
// ⛔⭐ 결손이었다: `docs/design/craft/anti-ai-slop.md` 는 스스로 이렇게 적는다 —
//    *"Several rules below are auto-enforced by the daemon's `lint-artifact` linter —
//      failing an enforced rule is not a style preference, it is a regression."*
//    ⇒ 그런데 이 저장소에 그 린터가 «없었다»(전수 0건). 규칙서는 «있고» 강제는 «없었다».
//    🔑 오늘 이 저장소가 여러 번 확인한 그 병이다 — ***「있다 ≠ 닿는다」***.
//
// ⭐ 순서를 지켰다: ***씨앗에 토큰이 생긴 «뒤»에*** 린터를 만든다.
//    ⛔ 반대로 하면 「규칙은 있는데 묶일 값이 없다」가 되고, 그것이 애초의 결손이다.
//    📄 그 순서는 `MANUAL-web-clone-to-reproducible-resource` §6 이 «먼저» 못 박았다.
//
// 원칙:
//   • ⛔ **P0 만 「위반」이라 부른다.** 나머지는 `advisory` — 스타일 취향과 회귀를 섞지 않는다.
//   • ⛔ 「검사하지 못했다」를 「통과」로 접지 않는다(`skipped` 를 값으로 낸다).
//   • ⭐ 규칙마다 «왜»와 «어디»를 낸다 — 줄 번호 없는 지적은 고칠 수 없다.
//   • ⛔ 이 파일은 파일을 «안 읽는다». 순수하다.

export type Severity = 'p0' | 'advisory';

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  /** 1-기반 줄 번호. 문서 전체에 걸린 규칙이면 null */
  readonly line: number | null;
  readonly evidence: string;
  readonly why: string;
}

export interface LintInput {
  readonly html: string;
  readonly css: string;
  /** 씨앗이 선언한 토큰. ⛔ 없으면 그것에 의존하는 규칙은 «건너뛴다»(통과가 아니다) */
  readonly declaredTokens?: ReadonlyArray<{ name: string; value: string }>;
}

export interface LintResult {
  readonly findings: readonly Finding[];
  /** ⛔ 「못 검사한」 규칙의 이름. 빈 배열이 「전부 검사했다」를 뜻한다 */
  readonly skipped: readonly string[];
  readonly p0Count: number;
  readonly advisoryCount: number;
}

/** ⛔ 기본 Tailwind 인디고 — `anti-ai-slop` §1 이 이름으로 못 박은 목록 그대로다. */
export const AI_DEFAULT_INDIGO: readonly string[] = [
  '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#8b5cf6', '#7c3aed', '#a855f7',
];

/** ⛔ §3 — 기능 아이콘 자리에 오면 안 되는 이모지. */
const ICON_EMOJI = ['✨', '🚀', '🎯', '⚡', '🔥', '💡'];

/** ⛔ §7 — 채움말. */
const FILLER = ['lorem ipsum', 'placeholder text', 'sample content', 'feature one', 'feature two', 'your text here'];

/** ⛔ §6 — 지어낸 지표. 「10× faster」류. */
// 🩸 2026-09-08 실측: 옛 판은 «영어만» 봤다(`faster|more|better`). 이 저장소의 산출물은 한글인데,
//    양성 표본의 *"10x 더 빠르게"* · *"99.9% 달성"* 을 한 건도 못 물었다.
const INVENTED_METRIC = new RegExp([
  String.raw`\b(\d+(?:\.\d+)?)\s*(?:×|x)\s*(faster|more|better|productive)\b`,
  String.raw`\b(\d+(?:\.\d+)?)\s*(?:×|x|배)\s*(?:더\s*)?(빠르|빨라|좋|높|성장|향상)`,
  String.raw`\b99\.9+\s*%\s*(uptime|반영|가동|가동률|달성|보장)`,
  String.raw`(고객\s*만족도|정확도|재방문율)\s*<?[^>]{0,12}>?\s*\d{2,3}(?:\.\d+)?\s*%`,
].join('|'), 'i');

/** hex → 색상각(0~360). ⛔ 무채색(채도 0)은 null — 「빨강도 파랑도 아니다」를 0°로 접지 않는다. */
export function hueOf(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function scan(text: string, needle: string): { line: number; evidence: string } | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  const line = lineOf(text, i);
  const start = Math.max(0, i - 30);
  return { line, evidence: text.slice(start, i + needle.length + 30).replace(/\s+/g, ' ').trim() };
}

/**
 * ⛔⭐ **P0 일곱** — 실패는 스타일 취향이 아니라 «회귀»다.
 *
 * ⚠️ 이 린터가 «답하지 못하는» 것은 `skipped` 에 이름으로 나온다.
 *    특히 §4(디스플레이 서체)는 ***씨앗이 세리프를 묶었을 때만*** 검사할 수 있다 —
 *    묶지 않은 씨앗에서 산세리프 디스플레이는 위반이 «아니다».
 */
export function lintArtifact(input: LintInput): LintResult {
  const { html, css } = input;
  const findings: Finding[] = [];
  const skipped: string[] = [];
  const push = (rule: string, severity: Severity, hit: { line: number; evidence: string } | null, why: string) => {
    if (hit) findings.push({ rule, severity, line: hit.line, evidence: hit.evidence, why });
  };

  // ① 기본 인디고 강조
  for (const hex of AI_DEFAULT_INDIGO) {
    push('default-indigo-accent', 'p0', scan(css, hex),
      '기본 Tailwind 인디고는 교과서적 AI 신호다 — 씨앗의 `--accent` 를 쓴다');
    push('default-indigo-accent', 'p0', scan(html, hex),
      '기본 Tailwind 인디고는 교과서적 AI 신호다 — 씨앗의 `--accent` 를 쓴다');
  }

  // ② 히어로의 2-스톱 「신뢰 그라디언트」
  // ⛔⭐ 정규식으로 hex 모양을 «맞히지» 마라 — 첫 판이 그랬고 `#2563eb` 를 놓쳤다
  //    (「`f` 로 끝나는」 같은 우연한 자리를 물고 있었다). ⇒ ***색을 실제로 푼다.***
  for (const g of css.matchAll(/linear-gradient\([^)]*\)/gi)) {
    const stops = g[0].match(/#[0-9a-f]{6}\b/gi) ?? [];
    if (stops.length !== 2) continue;         // ⛔ 3스톱 이상은 «의도된» 것으로 본다
    const hues = stops.map(hueOf).filter((h): h is number => h !== null);
    if (hues.length !== 2) continue;
    // 보라(≈270°)·인디고(≈245°)·분홍(≈320°) ↔ 파랑(≈215°)·시안(≈185°) 대역을 잇는 쌍
    // 🩸 2026-09-08 실측: 옛 대역은 warm ≥250 이라 ***Tailwind 인디고 `#6366f1`(239°)이 빠졌다*** —
    //    바로 이 규칙의 주석이 "인디고(≈245°)" 라고 «이름을 대던» 색이다. 코드가 자기 주석과 모순이었다.
    //    ⇒ 경계를 235 로 내린다. 대신 cool 상한도 234 로 내려 파랑→시안(221→188)은 «안» 물게 한다.
    const warm = hues.find((h) => h >= 235 && h <= 330);
    const cool = hues.find((h) => h >= 175 && h <= 234);
    if (warm !== undefined && cool !== undefined) {
      push('two-stop-trust-gradient', 'p0', { line: lineOf(css, g.index ?? 0), evidence: g[0].slice(0, 90) },
        '보라→파랑 2-스톱 히어로 그라디언트는 AI 기본값이다 — 단색 면 + 의도적 타이포가 낫다');
    }
  }

  // ③ 기능 아이콘 자리의 이모지 — ⛔ 「문서 어디든」이 아니라 «그 자리»만 본다
  for (const e of ICON_EMOJI) {
    const re = new RegExp(`<(h[1-6]|button|li)\\b[^>]*>[^<]{0,80}${e}`, 'i');
    const m = re.exec(html);
    if (m) {
      push('emoji-as-icon', 'p0', { line: lineOf(html, m.index), evidence: m[0].replace(/\s+/g, ' ').slice(0, 90) },
        '기능 아이콘에 이모지를 쓰지 않는다 — 1.6~1.8px 스트로크 모노라인 SVG + currentColor');
    }
  }

  // ④ 씨앗이 세리프를 묶었는데 디스플레이가 산세리프인가
  const displayToken = input.declaredTokens?.find((t) => t.name === '--font-display');
  if (!displayToken) {
    skipped.push('display-font-mismatch (씨앗에 --font-display 선언이 없다)');
  } else if (!/serif/i.test(displayToken.value) || /sans-serif/i.test(displayToken.value)) {
    // ⛔ 씨앗이 세리프를 «안» 묶었다 ⇒ 이 규칙은 «해당 없음»이지 통과가 아니다.
    skipped.push('display-font-mismatch (씨앗이 세리프를 묶지 않았다 — 해당 없음)');
  } else {
    const m = /h[12][^{]*\{[^}]*font-family:\s*(?!var\()([^;}]+)/i.exec(css);
    // 🩸 옛 판은 `inter|roboto|system-ui` «서양 서체»만 봤다 — 이 저장소 템플릿이 쓰는
    //    Pretendard·Noto Sans KR 를 한 건도 못 물었다(양성 표본에서 확인).
    if (m && /inter|roboto|system-ui|pretendard|noto\s*sans|apple\s*sd\s*gothic|malgun|spoqa/i.test(m[1])) {
      push('display-font-mismatch', 'p0', { line: lineOf(css, m.index), evidence: m[0].slice(0, 90) },
        '씨앗이 세리프를 묶었는데 디스플레이가 하드코딩 산세리프다 — `var(--font-display)` 를 쓴다');
    }
  }

  // ⑤ 라운드 카드 + 색깔 좌측 보더 — ⛔ «같은 규칙 블록» 안에서만 본다
  for (const m of css.matchAll(/\{[^}]*\}/g)) {
    const b = m[0];
    // 🩸 2026-09-28 E0·E1: 두 판 모두 «커피콩 그림»(`border-radius: 50%` 타원 ⊕ 한쪽 선)에 걸렸다.
    //    카드 타일은 둥근 «모서리»지 타원이 아니다 — 30% 이상 퍼센트·`/` 타원 반경은 그림으로 보고 뺀다.
    const radius = /border-radius\s*:\s*([^;}]*)/.exec(b)?.[1] ?? '';
    const shape = radius.includes('/') || [...radius.matchAll(/(\d+(?:\.\d+)?)%/g)].some((p) => Number(p[1]) >= 30);
    if (/border-radius\s*:\s*(?!0)/.test(b) && !shape && /border-left\s*:\s*[^;]*(#|rgb|var\()/.test(b)) {
      push('rounded-card-left-accent', 'p0', { line: lineOf(css, m.index ?? 0), evidence: b.replace(/\s+/g, ' ').slice(0, 90) },
        '라운드 + 색 좌측 보더는 전형적 「AI 대시보드 타일」이다 — 둘 중 하나를 뺀다');
    }
  }

  // ⑥ 지어낸 지표
  const metric = INVENTED_METRIC.exec(html);
  if (metric) {
    push('invented-metric', 'p0', { line: lineOf(html, metric.index), evidence: metric[0] },
      '출처 없는 「10× faster」류는 쓰지 않는다 — 실제 출처를 대거나 표시된 자리표시자를 쓴다');
  }

  // ⑦ 채움말
  for (const f of FILLER) {
    push('filler-copy', 'p0', scan(html, f),
      '빈 절은 구성으로 푸는 디자인 문제다 — 말을 지어내 채우지 않는다');
  }

  // ── advisory (P1) — ⛔ 「위반」이 아니다 ──────────────────────────────────
  // 🩸 2026-09-08 실측: 옛 판은 «영어 절 이름»만 봤다. 같은 기성품 구성을 한글로 쓰면
  //    ***한 건도 안 물렸다***(영어 2건 ↔ 한글 1건). P0 셋에서 고친 그 뿌리가 여기에도 있었다.
  //    ⛔ 칸마다 «대안 목록»으로 본다 — 하나로 이으면 어느 언어에서든 반쪽만 맞는다.
  const SECTION_STEPS: ReadonlyArray<readonly string[]> = [
    ['hero', '소개', '히어로'],
    ['features', '기능', '특징'],
    ['pricing', '요금', '가격'],
    ['faq', '자주 묻는', '자주묻는', '질문'],
    ['cta', '시작하', '신청하', '문의하'],
  ];
  const lower = html.toLowerCase();
  const seq = SECTION_STEPS.map((alts) => alts[0]);
  if (SECTION_STEPS.every((alts) => alts.some((a) => lower.includes(a.toLowerCase())))) {
    findings.push({
      rule: 'stock-section-sequence', severity: 'advisory', line: null,
      evidence: seq.join(' → '),
      why: 'Hero→Features→Pricing→FAQ→CTA 를 변형 없이 그대로 쓰면 기성품으로 읽힌다',
    });
  }
  if (!/prefers-reduced-motion/i.test(css) && /@keyframes|transition\s*:/i.test(css)) {
    findings.push({
      rule: 'motion-without-reduced-motion', severity: 'advisory', line: null,
      evidence: '움직임은 있는데 `prefers-reduced-motion` 블록이 없다',
      why: '접근성 바닥이 뚫린다 — animation-discipline 이 요구하는 최소치다',
    });
  }

  // 같은 규칙·같은 줄의 중복을 접는다(같은 hex 가 여러 번 나오면 한 번만 말한다)
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const k = `${f.rule}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  return {
    findings: deduped,
    skipped,
    p0Count: deduped.filter((f) => f.severity === 'p0').length,
    advisoryCount: deduped.filter((f) => f.severity === 'advisory').length,
  };
}
