// ── 🎨👁️ 「화면에서 craft 를 «잰다»」 — 첫 계산기 (대비) ──────────────────────
//
// ⛔⭐ 왜 있나: 이 저장소의 디자인 판정은 «세 층»인데 셋째가 비어 있었다
//   ① 선언 층  design-check      「규칙집을 «선언»했나」          ✅ 돈다
//   ② 토큰 층  measureContrast   「색 쌍이 규칙을 지키나」        ✅ 시험 안에서 돈다
//   ③ 렌더 층  ***없었다***       「«실제 화면»이 규칙을 지키나」
//   📄 근거 = 내부 문서 `RFC-design-integration-from-rulebooks-to-a-judging-eye-2026-08-25` §2
//
// 🔑 그리고 실측해 보니 ③ 의 «재료»가 전부 있었다(2026-08-25):
//   `pty snapshot --ansi`  셀 전경 SGR      📏 표본 하나에서 38;2 ***69건***
//   OSC 11 배경 질의 보조는 당시의 실험 재료였으나 제품 호출 없이 제거됐다.
//   `measureContrast`      WCAG 2.x 비율     (src/theme/contrast.ts)
//   ⇒ ***없던 것은 그 셋을 «잇는» 자 하나***다. 이 파일이 그것이다.
//
// ⛔⭐⭐ 재구현 금지 — 대비 «계산»은 `measureContrast` 가 정본이다. 여기서 다시 쓰면
//   그 순간 「같은 질문에 자가 둘」이 된다(이 저장소가 2026-08-25 하루에 세 번 데인 형태).
//
// ⚠️ 그리고 이 계산기가 «답하지 못하는» 것은 §「주장하지 않는 것」에 이름으로 적어 뒀다.

import { measureContrast, WCAG_NORMAL_TEXT_CONTRAST_RATIO } from '../theme/contrast.js';

/** 한 색 — SGR 이 truecolor(`38;2;r;g;b`)로만 준 것을 담는다.
 *
 *  ⛔ 팔레트 색(`30-37`·`90-97`·`38;5;n`)은 «담지 않는다» — 그 숫자가 어느 RGB 인지는
 *  터미널 테마가 정하고, 스냅샷에는 그 정보가 «없다». 추측하면 그 순간 자가 틀린다.
 *  ⇒ 그런 셀은 `unresolved` 로 «세어» 낸다(§ 아래) — 「못 잰 것」을 「통과」와 섞지 않는다. */
export interface Rgb { readonly r: number; readonly g: number; readonly b: number }

/** 같은 색 속성이 이어지는 «글자 묶음» 하나. */
export interface ScreenRun {
  readonly text: string;
  readonly foreground: Rgb | null;
  /** null = 명시 배경이 없다 ⇒ 터미널 «기본 배경»에 기댄다. */
  readonly background: Rgb | null;
}

export interface ContrastFinding {
  readonly text: string;
  readonly foreground: Rgb;
  readonly background: Rgb;
  readonly ratio: number;
}

export interface ScreenContrastReport {
  /** 잰 묶음 수(공백만인 것은 제외 — 글자가 없으면 대비가 뜻이 없다). */
  readonly measured: number;
  /** 🚨 문턱 미만인 묶음. */
  readonly findings: readonly ContrastFinding[];
  /** 장식 글리프만인 묶음 — 대비 분모에서는 빼되, 숨기지 않고 따로 센다. */
  readonly decorative: number;
  /** ⛔ 「못 잰 것」 — 전경이 truecolor 가 «아니어서» 판정 불가.
   *
   *  ⭐ 이 필드가 이 보고서의 핵심 계약이다. 0 이 아니면 `findings: []` 를
   *  「깨끗하다」로 읽으면 «안 된다» — 「그만큼 «안 봤다»」이다. */
  readonly unresolved: number;
  /** 판정에 쓴 문턱(기본 WCAG 2.x 보통 글자). */
  readonly threshold: number;
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** SGR 파라미터 열을 «순서대로» 소화해 전경·배경을 갱신한다.
 *
 *  ⛔ 한 이스케이프에 여러 파라미터가 온다(`0;38;2;1;2;3`). 그래서 «인덱스를 옮겨가며»
 *  읽는다 — 정규식으로 `38;2` 만 뽑으면 `48;2;38;2;…` 같은 열에서 틀린다. */
function applySgr(params: readonly number[], state: { fg: Rgb | null; bg: Rgb | null }): void {
  for (let i = 0; i < params.length; i += 1) {
    const code = params[i];
    if (code === 0) { state.fg = null; state.bg = null; continue; }
    if (code === 39) { state.fg = null; continue; }
    if (code === 49) { state.bg = null; continue; }
    if ((code === 38 || code === 48) && params[i + 1] === 2) {
      const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
      const rgb = [r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
        ? { r: r!, g: g!, b: b! }
        : null;
      if (code === 38) state.fg = rgb; else state.bg = rgb;
      i += 4;
      continue;
    }
    // ⛔ 팔레트 색은 «RGB 를 모른다» — null 로 두어 unresolved 로 세어지게 한다.
    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) { state.fg = null; continue; }
    if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) { state.bg = null; continue; }
    if ((code === 38 || code === 48) && params[i + 1] === 5) { // 38;5;n 팔레트
      if (code === 38) state.fg = null; else state.bg = null;
      i += 2;
    }
  }
}

/** ANSI 화면 텍스트를 «색 묶음»으로 가른다. */
export function parseScreenRuns(ansi: string): ScreenRun[] {
  const runs: ScreenRun[] = [];
  const state: { fg: Rgb | null; bg: Rgb | null } = { fg: null, bg: null };
  let cursor = 0;

  const push = (text: string): void => {
    if (text.length > 0) runs.push({ text, foreground: state.fg, background: state.bg });
  };

  SGR_PATTERN.lastIndex = 0;
  for (let match = SGR_PATTERN.exec(ansi); match !== null; match = SGR_PATTERN.exec(ansi)) {
    push(ansi.slice(cursor, match.index));
    const raw = match[1] ?? '';
    // ⚠️ `ESC[m` 은 `ESC[0m` 과 같다(빈 파라미터 = 0). 안 그러면 리셋을 놓친다.
    applySgr(raw === '' ? [0] : raw.split(';').map((p) => Number(p === '' ? 0 : p)), state);
    cursor = match.index + match[0].length;
  }
  push(ansi.slice(cursor));
  return runs;
}

/** 화면 묶음들의 대비를 «잰다».
 *
 *  @param defaultBackground 터미널 «기본» 배경. 명시 배경이 없는 셀이 여기 기댄다.
 *    📌 실측(2026-08-25): 한 표본에서 명시 배경(`48;2`)은 ***7건***인데 전경은 ***69건***이었다.
 *    ⇒ ***대부분의 셀이 이 값에 기댄다*** — 그래서 이 인자가 «선택»이 아니라 필수다.
 *    ⛔ 모르면 `null` 을 준다. 그러면 그 셀들은 `unresolved` 로 «세어진다»(통과로 세지 않는다). */
export function measureScreenContrast(
  runs: readonly ScreenRun[],
  defaultBackground: Rgb | null,
  threshold: number = WCAG_NORMAL_TEXT_CONTRAST_RATIO,
  defaultForeground: Rgb | null = null,
): ScreenContrastReport {
  const findings: ContrastFinding[] = [];
  let measured = 0;
  let decorative = 0;
  let unresolved = 0;

  for (const run of runs) {
    // 글자가 없으면 대비가 뜻이 없다 — 분모에서 뺀다.
    if (run.text.trim().length === 0) continue;
    if (/^[\u2500-\u257F\u2580-\u259F]+$/.test(run.text.trim())) { decorative += 1; continue; }

    const foreground = run.foreground ?? defaultForeground;
    const background = run.background ?? defaultBackground;
    if (foreground === null || background === null) { unresolved += 1; continue; }

    const ratio = measureContrast(toHex(foreground), toHex(background));
    if (ratio === null) { unresolved += 1; continue; }

    measured += 1;
    if (ratio < threshold) {
      findings.push({ text: run.text, foreground, background, ratio });
    }
  }

  return { measured, findings, decorative, unresolved, threshold };
}
