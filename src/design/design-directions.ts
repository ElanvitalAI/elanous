// 방향은 테마 레지스트리 또는 번들 디자인 시스템의 토큰에서 도출한다.
// 테마의 기존 목록과 선언 형식은 유지하고, 시스템 토큰 값은 이 파일에 복제하지 않는다.
// B2 규칙집은 제약을, DESIGN.md 의 방향 선언은 선택을 담는다.

import type { ThemeTokens } from '../theme/tokens.js';
import { THEME_REGISTRY } from '../themes/index.js';
import { readSectionItems } from './design-doc.js';
import { libraryDir } from './design-library.js';
import { defaultDesignSystemsDir, listDesignSystems, type DesignSystem } from './design-systems.js';

/** `DESIGN.md` 안에서 방향을 선언하는 절. */
export const DIRECTION_HEADING = '## Design direction';

export interface DesignDirection {
  /** 테마 이름 또는 디자인 시스템 id 그대로. */
  id: string;
  /** 사람이 고를 때 보는 한 줄. */
  label: string;
  /** 왜 이것을 고르나 — 톤 설명. */
  mood: string;
  /** 이 방향이 어두운 바탕인가. */
  isDark: boolean;
  /** 파스텔(채도를 낮춘) 계열인가. */
  isPastel: boolean;
  /** 미리보기에 쓸 대표 색 — 테마 또는 시스템 토큰에서 가져온다. */
  swatch: { text: string; accent: string; muted: string; bg?: string; fg?: string };
  /** 방향의 출처. 없으면 테마 레지스트리다(기존 여섯). */
  source?: 'theme' | 'document' | 'design-system';
  /** 라이브러리 커스텀 시스템만 `Custom`. 번들·테마는 비운다. */
  category?: 'Custom';
  /** 시스템/문서 방향의 서체. 터미널 테마는 서체를 정하지 않는다. */
  typography?: { display: string | null; body: string | null };
}

/** 어둡기·파스텔 두 축에서 톤 문장을 만든다.
 *
 *  ⛔ 테마마다 손으로 쓴 설명을 두지 않는다 — 테마가 늘면 그 설명이 «빠진 채» 남고,
 *  그것이 이 저장소가 반복해서 만든 「만들고 안 잇는다」의 가장 작은 판이다. */
function moodFor(theme: ThemeTokens): string {
  const ground = theme.isDark ? 'dark ground' : 'light ground';
  const tone = theme.isPastel ? 'soft, low-saturation accents' : 'saturated, high-contrast accents';
  return `${ground} · ${tone}`;
}

/** 등록된 테마에서 방향 목록을 «도출»한다.
 *
 *  `registry` 는 시험이 주입한다. 기본값은 정본 `THEME_REGISTRY` 하나뿐이다. */
export function listDesignDirections(
  registry: ReadonlyArray<ThemeTokens> = THEME_REGISTRY,
): DesignDirection[] {
  return registry.map((theme) => ({
    id: theme.name,
    label: theme.name,
    mood: moodFor(theme),
    isDark: theme.isDark === true,
    isPastel: theme.isPastel === true,
    swatch: {
      text: theme.colors.text,
      accent: theme.colors.accent,
      muted: theme.colors.muted,
    },
  }));
}

export function listAllDesignDirections({
  systemsDir = defaultDesignSystemsDir(),
  librarySystemsDir,
}: { systemsDir?: string; librarySystemsDir?: string } = {}): DesignDirection[] {
  const themes = listDesignDirections();
  const themeIds = new Set(themes.map((theme) => theme.id));
  const bundled = listDesignSystems(systemsDir).filter((system) => !themeIds.has(system.id));
  const bundledIds = new Set(bundled.map((system) => system.id));
  const library = listDesignSystems(librarySystemsDir ?? libraryDir())
    .filter((system) => !themeIds.has(system.id) && !bundledIds.has(system.id));
  return [
    ...themes,
    ...[...bundled, ...library].map(directionFromSystem),
  ];
}

function directionFromSystem(system: DesignSystem): DesignDirection {
  return {
    id: system.id,
    label: system.name,
    mood: system.summary,
    isDark: (luminance(system.swatch.bg) ?? 255) < 128,
    isPastel: false,
    swatch: { bg: system.swatch.bg, fg: system.swatch.fg, text: system.swatch.fg, accent: system.swatch.accent, muted: system.swatch.fg },
    typography: { display: system.fonts.display, body: system.fonts.body },
    source: 'design-system',
    ...(system.category === 'Custom' ? { category: 'Custom' as const } : {}),
  };
}

export interface DirectionDeclaration {
  /** `DESIGN.md` 가 선언한 방향. 절이 없거나 비면 null. */
  declared: string | null;
  /** 선언은 있는데 등록된 방향에 «없는» 경우 그 이름. 없으면 null.
   *  ⭐ `declared` 와 나눠 두는 이유는 design-check 과 같다 —
   *  「선언 안 했다」와 「선언했는데 못 찾겠다」는 다른 상태이고
   *  둘을 한 값으로 접으면 렌더가 그것을 다시 가를 수 없다. */
  unavailable: string | null;
}

/** `DESIGN.md` 문서에서 선언된 방향을 읽는다.
 *
 *  ⛔ 절에 여러 줄이 있으면 «첫 줄»만 쓴다 — 방향은 하나다. 여러 개를 허용하면
 *  「어느 것이 이기나」라는 답 없는 물음이 생긴다. */
export function parseDeclaredDirection(
  document: string,
  available: ReadonlyArray<DesignDirection> = listDesignDirections(),
): DirectionDeclaration {
  const first = readSectionItems(document, DIRECTION_HEADING)[0] ?? null;
  if (first === null) return { declared: null, unavailable: null };
  const known = available.some((d) => d.id === first);
  return { declared: first, unavailable: known ? null : first };
}

/** 문서에 방향 선언을 쓰거나 바꾼다. 문서 «전체»를 돌려준다.
 *
 *  ⛔ 파일을 읽거나 쓰지 않는다 — 순수 함수라 호출자가 경로 규칙(어느 저장소의
 *  DESIGN.md 인가)을 소유한다. 그 규칙은 `#11793`·`#11930` 이 이미 정했고
 *  여기서 다시 정하면 세 번째 답이 생긴다. */
export function writeDeclaredDirection(document: string, directionId: string): string {
  return writeDirectionEntries(document, directionId, []);
}

export function writeDeclaredSystemDirection(document: string, directionId: string, sourceCommit: string): string {
  return writeDirectionEntries(document, directionId, [
    'tokens: design/system/tokens.css',
    sourceCommit === 'custom'
      ? `source: custom@${directionId}`
      : `source: open-design@${sourceCommit.slice(0, 10)}`,
  ]);
}

function writeDirectionEntries(document: string, directionId: string, details: readonly string[]): string {
  const entries = [`- ${directionId}`, ...details.map((detail) => `- ${detail}`)];
  const lines = document.split(/\r?\n/);
  const start = lines.indexOf(DIRECTION_HEADING);

  if (start === -1) {
    // 절이 없다 — 문서 끝에 붙인다. 앞 문서의 마지막 빈 줄은 보존한다.
    const trimmed = document.replace(/\s*$/, '');
    return `${trimmed}\n\n${DIRECTION_HEADING}\n\n${entries.join('\n')}\n`;
  }

  // 절이 있다 — 그 절만 갈아 끼운다(다른 절은 손대지 않는다).
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith('#')) end += 1;
  const rest = lines.slice(end);
  const head = lines.slice(0, start + 1);
  return [...head, '', ...entries, '', ...rest].join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── 웹 레퍼런스를 «방향»으로 ────────────────────────────────────────────────
//
// 🩸 계기(2026-09-08 실측): 위 여섯은 «전부 터미널 색 스킴»이고 `DesignDirection` 엔
//    서체 칸이 아예 없었다. ⇒ ***웹 레퍼런스에서 뽑은 디자인은 elanous 의 「방향」이 될 수 «없었다».***
//    그런데 `scripts/webclone/extract-design.ts` 는 실제 사이트에서 팔레트·서체·모션·대비 쌍을
//    담은 `DESIGN.md` 를 «이미» 낸다. 빠진 것은 그 산출을 방향으로 «읽는 다리» 하나뿐이었다.
//
// ⛔ 이 함수도 색값을 «적지 않는다» — 문서가 말한 값만 옮긴다(이 파일의 머리말 규율).

// 시스템의 간격·모션 값은 선택 시 복사하는 DESIGN.md 와 tokens.css 에 보존된다.
// 웹 추출 방향은 해당 값을 사용하는 소비자가 생길 때 별도 필드로 확장한다.

/** 왜 방향을 «못» 만들었나. ⛔ 「null」 하나로 접으면 「팔레트가 없다」와 「역할을 못 봤다」가 같아진다. */
export type DirectionRefusal =
  | 'empty-id'
  | 'no-palette'
  /** 팔레트는 있는데 «관측된 대비 쌍»이 없다 — 역할 색을 토큰 이름으로 되짚지 못한 문서다. */
  | 'no-observed-pairs'
  /** 쌍은 있는데 세 칸(글자·강조·보조)을 다 못 채웠다. */
  | 'incomplete-swatch';

export interface DirectionAttempt {
  readonly direction: DesignDirection | null;
  readonly refusal: DirectionRefusal | null;
}

/**
 * 추출된 `DESIGN.md` 에서 방향 하나를 만든다. 못 만들면 **null** — ⛔ 빈 방향을 만들지 않는다.
 *
 * ⭐⭐ **기전은 「이름」이 아니라 「관측된 대비 쌍」이다**(2026-09-08 개정).
 *   🩸 첫 판은 토큰 «이름»에서 `ink`·`accent`·`muted` 를 찾았다. 본 적 없는 사이트 셋에 대 보니:
 *      · MDN(색 45개) → 이름이 `--color-blue-50` 같은 «척도»라 ***null***
 *      · Vercel(색 177개) → 이름은 맞았는데 값이 «엉망»이었다(글자=분홍 · 강조=거의 흰색)
 *   ⇒ ***이름은 문서가 스스로 붙인 «신고»고, 대비 쌍은 렌더된 역할에서 «관측»된 것이다.***
 *      이 저장소가 오늘 종일 배운 것과 같은 축이라, 관측 쪽을 쓴다.
 *
 * ⛔ 이 함수도 색값을 «적지 않는다» — 문서가 말한 값만 옮긴다(이 파일 머리말 규율).
 */
export function directionFromDesignMd(
  document: string,
  id: string,
  read: (doc: string, heading: string) => string[] = readSectionItems,
): DesignDirection | null {
  return attemptDirectionFromDesignMd(document, id, read).direction;
}

/** 위와 같되 «왜 못 만들었나»를 같이 준다. */
export function attemptDirectionFromDesignMd(
  document: string,
  id: string,
  read: (doc: string, heading: string) => string[] = readSectionItems,
): DirectionAttempt {
  const trimmedId = id.trim();
  if (trimmedId === '') return { direction: null, refusal: 'empty-id' };

  // `- --ink: #172d24` (기계용 블록). ⛔ 사람이 읽는 표는 «안» 읽는다 — 파서가 이 형태만 준다.
  const palette = new Map<string, string>();
  for (const item of read(document, '## Palette')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/i.exec(item);
    if (m) palette.set(m[1], m[2]);
  }
  if (palette.size === 0) return { direction: null, refusal: 'no-palette' };

  // ⭐ 관측된 쌍 — `- --ink on --ground`
  const pairs: Array<{ fg: string; bg: string }> = [];
  for (const item of read(document, '## Contrast pairs')) {
    const m = /^\s*(--[a-z0-9-]+)\s+on\s+(--[a-z0-9-]+)\s*$/i.exec(item);
    if (m && palette.has(m[1]) && palette.has(m[2])) pairs.push({ fg: m[1], bg: m[2] });
  }
  if (pairs.length === 0) return { direction: null, refusal: 'no-observed-pairs' };

  const text = pairs[0].fg;
  const ground = pairs[0].bg;

  // 강조 = «바탕» 중 페이지 바탕에서 밝기가 가장 먼 것. ⛔ 못 찾으면 다른 글자색으로 물러선다.
  const groundL = luminance(palette.get(ground));
  let accent: string | null = null;
  let best = -1;
  for (const p of pairs) {
    if (p.bg === ground) continue;
    const l = luminance(palette.get(p.bg));
    if (l === null || groundL === null) continue;
    const d = Math.abs(l - groundL);
    if (d > best) { best = d; accent = p.bg; }
  }
  const otherFgs = pairs.map((p) => p.fg).filter((f) => f !== text);
  if (accent === null) accent = otherFgs[0] ?? null;
  const muted = otherFgs.find((f) => f !== accent) ?? otherFgs[0] ?? null;

  // ⛔ 셋이 «서로 다른 값»이어야 스와치다. 같은 값 둘을 나란히 놓으면
  //    「강조와 보조를 못 가렸다」가 「가렸다」처럼 «보인다»(실측: MDN 이 그 모양이었다).
  const distinct = new Set([text, accent, muted].filter((x): x is string => x !== null)
    .map((n) => palette.get(n)));
  if (accent === null || muted === null || distinct.size < 3) {
    return { direction: null, refusal: 'incomplete-swatch' };
  }

  const fonts = new Map<string, string>();
  for (const item of read(document, '## Typography')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/i.exec(item);
    if (m) fonts.set(m[1], m[2]);
  }
  const font = (...needles: string[]): string | null => {
    for (const n of needles) {
      for (const [name, value] of fonts) if (name.includes(n)) return value;
    }
    return null;
  };

  return {
    direction: {
      id: trimmedId,
      label: trimmedId,
      mood: 'extracted from a web reference',
      isDark: groundL !== null && groundL < 128,
      isPastel: false,
      swatch: {
        text: palette.get(text)!,
        accent: palette.get(accent)!,
        muted: palette.get(muted)!,
      },
      source: 'document',
      typography: { display: font('display', 'serif', 'heading'), body: font('sans', 'body', 'text') },
    },
    refusal: null,
  };
}

/** hex 의 밝기. ⛔ 못 풀면 null — 0 이나 검정으로 «몰지» 않는다. */
function luminance(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(x, 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

