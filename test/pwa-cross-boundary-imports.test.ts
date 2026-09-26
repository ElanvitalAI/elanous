import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** ⛔⭐⭐⭐ 2026-08-21 실측(`[F]` 15차): ***`main` 의 PWA 빌드가 깨져 있었다.***
 *
 *  ```
 *  Module not found: Can't resolve '../../../../src/tool-runtime/mcp-route-path.js'
 *  ```
 *  `bun test` 는 전부 초록이었다 — bun 이 `.js` → `.ts` 를 풀어 주기 때문이다.
 *  ⛔ webpack(Next) 은 «안 푼다». ⇒ 시험이 원리상 못 잡는 자리였고, 데몬은 옛 번들을 계속 서빙했다.
 *
 *  📏 그리고 내가 근거로 삼은 「선례」는 ***죽은 코드***였다 —
 *  빌드 그래프에 없는 죽은 코드는 빌드의 선례가 아니다. ⭐ 실제로 도는 선례는 확장자가 «없다».
 *
 *  ⇒ 그래서 이 시험이 그 규칙을 문다. ⛔ 빌드를 돌리지 않고도(수십 초) 같은 답을 낸다. */

const PWA_SRC = resolve(import.meta.dir, '../apps/pwa/src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** 모듈 지정자가 «어떤 문법으로» 오든 잡는다.
 *
 *  ⛔📏 무인 리뷰 must-fix(2026-08-21 · PR #10887): 1차판은 ***작은따옴표 정적 `from` 만*** 봤다.
 *  ⇒ 큰따옴표·`export … from`·동적 `import()` 로 `.js` 가 다시 들어오면 ***통과하면서 빌드는 깨진다.***
 *  ⭐ 그래서 「어떤 구문인가」로 좁히지 않고 ***「저장소 src 를 가리키는 «따옴표 안» 문자열」***을 센다 —
 *    이 경계를 지나는 지정자는 어떤 구문에서든 그 모양이기 때문이다. */
const CROSS_BOUNDARY_SPECIFIER = /['"`]((?:\.\.\/)+src\/[^'"`]+)['"`]/g;

/** 저장소 `src/` 를 가리키는 상대 import 중 ***번들러가 닿는*** 것.
 *
 *  ⛔ 시험 파일은 «뺀다» — 앱 코드가 그것을 import 하지 않으므로 webpack 그래프에 «없고»,
 *  거기서는 `bun` 의 리졸버가 `.js` → `.ts` 를 풀어 준다. 실제로 1차판이 그 둘을 오탐했다.
 *  ⭐ 「빌드가 깨지나」를 묻는 자가 「빌드가 안 보는 파일」을 세면 그 답은 거짓이다. */
function crossBoundaryImports(): { file: string; specifier: string }[] {
  const found: { file: string; specifier: string }[] = [];
  for (const file of sourceFiles(PWA_SRC)) {
    if (/\.(test|spec)\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CROSS_BOUNDARY_SPECIFIER)) {
      found.push({ file: relative(resolve(import.meta.dir, '..'), file), specifier: match[1]! });
    }
  }
  return found;
}

describe('PWA → repo src imports must be resolvable by the bundler, not only by bun', () => {
  it('never carries a .js extension — webpack does not map it back to .ts', () => {
    const offenders = crossBoundaryImports().filter((entry) => entry.specifier.endsWith('.js'));
    // ⛔ 이 단언이 깨지면 「시험이 까다롭다」가 아니라 ***「PWA 빌드가 깨졌다」***로 읽는다.
    //   그 상태에서는 `nexus build` 가 실패하고 데몬은 «옛 번들»을 계속 서빙한다.
    expect(offenders.map((entry) => `${entry.file} → ${entry.specifier}`)).toEqual([]);
  });

  it('measures a denominator, so a green result cannot mean the sweep found nothing to look at', () => {
    // ⭐ 퇴화 검사 — 이 경계를 지나는 import 가 0이면 위 단언은 «아무것도» 안 잰 것이다.
    expect(crossBoundaryImports().length).toBeGreaterThan(0);
  });

  it('catches the specifier whatever syntax carries it — not only a single-quoted static from', () => {
    // ⛔📏 무인 리뷰 must-fix: 1차판 정규식은 이 넷 중 «하나»만 봤다. 그 틈으로 `.js` 가 다시 들어오면
    //   시험은 통과하고 빌드는 깨진다. ⇒ 네 구문을 모두 같은 자가 잡는지 여기서 문다.
    const carriers = [
      `import { X } from '../../src/a.js';`,
      `import { X } from "../../src/a.js";`,
      `export { X } from '../../src/a.js';`,
      `const m = await import('../../src/a.js');`,
    ];
    for (const line of carriers) {
      const hits = [...line.matchAll(new RegExp(CROSS_BOUNDARY_SPECIFIER.source, 'g'))].map((m) => m[1]);
      expect(hits).toEqual(['../../src/a.js']);
    }
  });
});
