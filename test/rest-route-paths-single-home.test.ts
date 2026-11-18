import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as leaf from '../src/nexus/api/rest-route-paths.js';

/** ⛔⭐⭐⭐ **데몬과 PWA 가 공유하는 REST 경로는 «한 집»에서만 산다.**
 *
 *  📏 2026-08-22 실측(16차 `[F]`): 15차가 세운 자(`f12-sweep --bucket-b`)의 **희소성 상위 다섯이
 *  전부 라우트 경로**였다 — 데몬이 상수로 선언한 값을 다른 파일이 ***문자열로 베껴*** 쓰고 있었다.
 *  그중 하나는 **데몬 «안»**이었다(`http-server.ts` 의 디스패처가 `dist.ts` 의 상수를 안 썼다).
 *
 *  ⛔ **갈리면 조용하다** — 한쪽만 바꿔도 타입·시험이 안 깨지고 «404 로만» 드러난다.
 *  📏 그 부류(같은 계약이 여러 자리에 베껴져 하나만 자란 것)는 16차에 ***두 번 실제 결함이었다***
 *  (`#11050` PWA 빌드 정지 · `#11061` 위젯이 빈 화면). ⇒ 이번엔 터지기 전에 접었고, 이 자가 지킨다. */

const REPO = resolve(import.meta.dir, '..');
const LEAF = 'src/nexus/api/rest-route-paths.ts';

const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

/** 주석을 뺀 «코드 줄»만. ⛔ 계약은 코드에 있지 주석에 있지 않다.
 *  ⚠️ 한계 — 코드 «뒤»에 붙은 인라인 주석은 코드 줄로 센다. 그쪽으로 틀리면 «없는 위반»을 만드는데,
 *    그 방향의 오답은 사람이 곧바로 알아본다(반대 방향은 조용히 통과시킨다 — 그게 더 나쁘다). */
const codeLinesOf = (rel: string): string[] =>
  read(rel).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

/** 잎에서 오는 `import { … } from '…rest-route-paths…'` 문(여러 줄 포함) — 포맷 무관.
 *  📏 #38766 이 `http-server.ts` 의 import 를 여러 줄 + 큰따옴표로 재포맷했다 ⇒ «한 줄에 이름과 경로가 같이 있다»는
 *  가정은 포맷이지 계약이 아니었다. 계약(ⓐ 잎에서 import · ⓑ import 밖에서 사용)은 그대로 문다. */
const LEAF_IMPORT = /import\s+(?:type\s+)?\{(?<specs>[^}]*)\}\s*from\s*['"][^'"]*rest-route-paths(?:\.js)?['"]/g;
const leafImportsOf = (rel: string): { readonly names: readonly string[]; readonly body: string } => {
  const code = codeLinesOf(rel).join('\n');
  const names = [...code.matchAll(LEAF_IMPORT)].flatMap((m) =>
    (m.groups?.specs ?? '').split(',').map((spec) => spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()).filter(Boolean),
  );
  return { names, body: code.replace(LEAF_IMPORT, '') };
};

/** 이 잎의 값을 «쓰는» 쪽 — 그리고 ⭐ **각자 어느 상수를 쓰기로 했는지**.
 *
 *  ⛔📏 무인 리뷰 must-fix(2026-08-22 · PR #11096): 1차판은 소비자를 «파일 목록»으로만 두고
 *  `text.includes('rest-route-paths')` 로 확인했다. ⇒ ***주석 한 줄이나 안 쓰는 import 만으로 통과***한다.
 *  🔑 「공허하게 통과하는 것을 막는다」고 적은 검사가 «공허하게 통과할 수 있었다».
 *  ⇒ 이제 파일마다 «기대 상수»를 적고, 그 이름이 ⓐ잎에서 import 되고 ⓑ import 줄 «밖»에서 쓰이는지 문다. */
const CONSUMERS: ReadonlyArray<{ readonly file: string; readonly uses: readonly string[] }> = [
  { file: 'src/nexus/api/http-server.ts', uses: ['MANIFEST_PATH', 'IPA_PATH_PREFIX'] },
  { file: 'apps/pwa/src/lib/devices-api.ts', uses: ['DEVICES_PATH', 'TEMPLATE_CAPABILITY_PREVIEW_PATH'] },
  { file: 'apps/pwa/src/lib/idle-nudge-api.ts', uses: ['IDLE_NUDGE_PATH'] },
  { file: 'apps/pwa/src/lib/morning-showroom-api.ts', uses: ['MORNING_SHOWROOM_PATH'] },
  { file: 'apps/pwa/src/lib/fluent-chain-api.ts', uses: ['NEXT_FLUENT_DISPATCH_PATH'] },
];

/** 옛 이름을 계속 내보내는 «데몬 쪽» 모듈 — 기존 참조를 안 깨려고 re-export 로 남겼다.
 *
 *  ⛔📏 무인 리뷰 should-fix(PR #11096): 1차판 가드는 **PWA 소비자만** 봤다.
 *  ⇒ 데몬 쪽에서 누군가 `export const X = '/v1/…'` 를 «다시» 선언하면 계약이 조용히 갈리고
 *    그때는 두 값이 한동안 «우연히 같아» 아무 시험도 안 깨진다. 그래서 이쪽도 문다. */
const DECLARERS: ReadonlyArray<{ readonly file: string; readonly reexports: readonly string[] }> = [
  { file: 'src/nexus/api/devices.ts', reexports: ['DEVICES_PATH', 'TEMPLATE_CAPABILITY_PREVIEW_PATH'] },
  { file: 'src/nexus/api/dist.ts', reexports: ['MANIFEST_PATH', 'IPA_PATH_PREFIX'] },
  { file: 'src/nexus/api/idle-nudge.ts', reexports: ['IDLE_NUDGE_PATH'] },
  { file: 'src/nexus/api/morning-showroom.ts', reexports: ['MORNING_SHOWROOM_PATH'] },
  { file: 'src/nexus/api/next-fluent.ts', reexports: ['NEXT_FLUENT_DISPATCH_PATH'] },
];

describe('shared REST route paths live in one home', () => {
  it('exports a non-empty set of paths that all look like routes', () => {
    // ⭐ 분모 — 「전부 통과」가 「아무것도 안 봤다」와 구별되게 한다.
    const values = Object.values(leaf);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toMatch(/^\/v1\//);
  });

  it('stays dependency-free — a browser that imports it must not pull the daemon graph in', () => {
    // ⛔ 15차가 `mcp-route-path.ts` 를 잎으로 세운 이유가 이것이다. 같은 규율을 여기서 문다.
    //   📏 PWA 가 이 파일을 import 하므로, 여기에 의존성이 하나라도 생기면 그 그래프가 번들에 딸려 온다.
    // ⛔📏 무인 리뷰 should-fix: 1차판은 «정적 `import` 문»만 봤다 —
    //   `await import(...)` 나 `require(...)` 로 그래프를 끌어오는 길이 열려 있었다.
    //   ⇒ 잎의 계약은 「import 문이 없다」가 아니라 ***「어떤 의존성도 없다」***이므로 셋 다 문다.
    const offenders = codeLinesOf(LEAF).filter((line) =>
      /^\s*import\s/.test(line) || /\bimport\s*\(/.test(line) || /\brequire\s*\(/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it('no consumer copies a shared path as a bare string literal', () => {
    // ⛔ 이 단언이 깨지면 「시험이 까다롭다」가 아니라 ***「라우트가 갈릴 수 있게 됐다」***로 읽는다.
    //   갈린 뒤에는 타입도 시험도 안 깨지고 404 로만 드러난다.
    const paths = Object.values(leaf);
    const offenders: string[] = [];
    for (const { file } of CONSUMERS) {
      // ⛔📏 1차판은 파일 전체를 훑어 **주석 안의 백틱**(`` `/v1/devices` ``)을 위반으로 잡았다.
      //   ⇒ 「주석은 계약이 아니다」라고 스스로 적어 놓고 그것을 세고 있었다. 줄 단위로 뺀다.
      const codeLines = codeLinesOf(file);
      for (const path of paths) {
        for (const quote of ['\'', '"', '`']) {
          const literal = `${quote}${path}${quote}`;
          if (codeLines.some((line) => line.includes(literal))) offenders.push(`${file} → ${literal}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every daemon module re-exports from the leaf instead of re-declaring the value', () => {
    // ⛔⭐ 이 검사가 없으면 가드가 «한쪽만» 지킨다 — PWA 는 잎을 쓰는데 데몬이 다시 선언하면
    //   두 값이 한동안 «우연히 같아» 아무것도 안 깨지고, 갈린 날에만 404 로 드러난다.
    const offenders: string[] = [];
    for (const { file, reexports } of DECLARERS) {
      const codeLines = codeLinesOf(file);
      const fromLeaf = codeLines.filter((line) => line.includes('rest-route-paths'));
      for (const name of reexports) {
        if (!fromLeaf.some((line) => line.includes(name))) offenders.push(`${file} ⇒ ${name} not sourced from leaf`);
        // ⛔ 값을 «다시 선언»하면 그 순간 계약이 둘이 된다.
        if (codeLines.some((line) => new RegExp(`export\\s+const\\s+${name}\\s*=`).test(line))) {
          offenders.push(`${file} ⇒ ${name} re-declared locally`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every consumer imports its constants from the leaf AND actually uses them', () => {
    // ⛔⭐⭐ 앞 검사는 「문자열이 없다」만 본다. 파일이 그 경로를 «아예 안 쓰게» 바뀌어도 통과한다.
    //   ⇒ 「이 파일이 정말 잎의 «그 상수»를 쓰는가」를 따로 문다(15차 §4 ⑦: 반증이 이음매를 비켜 가면 안 된다).
    // ⛔📏 무인 리뷰 must-fix: 1차판은 `includes('rest-route-paths')` 였다 —
    //   ***주석 한 줄이나 안 쓰는 import 만으로 통과***했다. 그것이야말로 「공허한 통과」다.
    const offenders: string[] = [];
    for (const { file, uses } of CONSUMERS) {
      const { names, body } = leafImportsOf(file);
      for (const name of uses) {
        // ⓐ 잎에서 «가져오는가» — import 문(여러 줄 포함)의 지정자 목록에 그 이름이 있는가
        if (!names.includes(name)) offenders.push(`${file} ⇒ ${name} not imported from leaf`);
        // ⓑ import 문 «밖»에서 «쓰는가» — 안 쓰는 import 는 계약을 안 지킨다.
        else if (!new RegExp(`\\b${name}\\b`).test(body)) {
          offenders.push(`${file} ⇒ ${name} imported but never used`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
