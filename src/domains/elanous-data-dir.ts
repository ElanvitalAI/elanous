// 데이터 루트 단일 해석기 — 중립 이름 (2026-09-22)
//
// 구현은 여기. 디스크 경로 문자열과 해석 순서(env → 심링크 → dated 폴백)는
// `conatus-data-dir.ts` 가 만들던 것과 한 글자도 같다. 옛 이름
// `conatusDataDir` · `conatusPath` 는 호환 export 로 남긴다.
//
// 왜 생겼나: `~/.elanous/conatus/**` 경로가 **69지점에 하드코딩**돼 있었고, 올바른
// 헬퍼(`conatus-panel.ts:31 conatusDataDir`)가 이미 있었는데 **1곳만** 그걸 썼다.
// 타임존 사태(`src/time/format.ts` 참조)와 정확히 같은 구조 — 계약이 있어도 전파할
// 통로가 없으면 각자 하드코딩한다.
//
// 무엇이 터졌나: `test/morning-report.test.ts` 가 "부작용 없이(upload:false)"라고
// 주석에 적어두고 실제로는 **운영 `regime.db` 에 쓰고 실시간 시장 API 를 호출**했다.
// `upload:false` 는 S3 만 막고 DB 쓰기는 그대로였다. 실증: 그 테스트 2개만 돌려도
// `macro_snapshots` 의 `created_at` 이 갱신된다(01:52:54 → 01:59:50). 남은 흔적은
// `as_of='2026-07-05'`(테스트 픽스처 날짜) 행과 `regime_vector` 의 동일 픽스처.
//
// 이 레포에서 test→운영 누출은 이번이 **네 번째**다 — PTY 매니페스트(#5246) ·
// 세션 스토어(#5252) · `process.env.TZ` 오염 · 여기. 그래서 개별 수리가 아니라
// **해석기에 안전망**을 둔다(#5252 `sessionRoot()` 와 동형).

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 데이터 루트 (중립 이름).
 *
 *  우선순위: `CONATUS_DATA_DIR`(기존 노브·파리티 격리) → `ELANOUS_STATE_DIR`/conatus →
 *  **NODE_ENV=test 리다이렉트** → `~/.elanous/conatus`.
 *
 *  ⚠️ 테스트 리다이렉트가 `~/.elanous` 기본값보다 **앞**에 있다. 격리를 잊은 테스트가
 *  운영 시장 데이터를 오염시키는 걸 막는 게 목적이고, 명시 노브(앞의 둘)는 그대로
 *  존중한다. skip 이 아니라 redirect 인 이유: 이 DB 들은 read-back 이 있어 skip 하면
 *  의미가 깨진다(#5252 와 같은 판단). */
export function elanousDataDir(): string {
  const explicit = process.env.CONATUS_DATA_DIR?.trim();
  if (explicit) return explicit;

  const stateDir = process.env.ELANOUS_STATE_DIR?.trim();
  if (stateDir) return join(stateDir, 'conatus');

  if (process.env.NODE_ENV === 'test') return testFallbackDir();

  return join(homedir(), '.elanous', 'conatus');
}

/** 격리를 안 건 테스트 런의 폴백 루트 — 프로세스(pid) 스코프라 같은 런 안에서는
 *  read-back 이 일관된다. 첫 사용 시 1회만 관측을 남겨 "어느 테스트가 규율을
 *  빠뜨렸나"를 추적 가능하게 한다(조용한 폴백은 또 다른 침묵이다). */
let testFallbackRoot: string | undefined;
function testFallbackDir(): string {
  if (testFallbackRoot) return testFallbackRoot;
  testFallbackRoot = join(tmpdir(), `elanous-test-conatus-${process.pid}`);
  // ⚠️ 디렉토리를 **반드시 만든다**. 안 만들면 `new Database(path)` 가 "unable to open
  // database file" 로 실패하고, 호출부들이 fail-soft 라 그걸 삼켜 "안전한 것처럼"
  // 보인다 — 실제로는 리다이렉트가 아니라 그냥 안 쓰는 것이고, read-back 이 필요한
  // 테스트는 조용히 깨진다. (초안이 정확히 이 상태였고 probe 로 잡았다.)
  try { mkdirSync(testFallbackRoot, { recursive: true }); }
  catch { /* 생성 실패해도 아래 관측은 남긴다 */ }
  try {
    const diagnostic = (globalThis as typeof globalThis & {
      __elanous_mss_diagnostic_logger__?: { log: (category: string, event: string, data: Record<string, unknown>) => void };
    }).__elanous_mss_diagnostic_logger__;
    const observation = {
      pid: process.pid,
      root: testFallbackRoot,
      why: 'NODE_ENV=test without CONATUS_DATA_DIR/ELANOUS_STATE_DIR',
    };
    if (diagnostic?.log) diagnostic.log('conatus.data-dir', 'test-root-redirect', observation);
    else process.emitWarning(JSON.stringify(observation), { code: 'CONATUS_TEST_ROOT_REDIRECT' });
  } catch { /* 관측 실패가 격리를 막지 않는다 */ }
  return testFallbackRoot;
}

/** 데이터 루트 하위 경로 (중립 이름). 하드코딩 대신 이걸 쓴다. */
export function elanousDataPath(...parts: string[]): string {
  return join(elanousDataDir(), ...parts);
}

/** 호환 export — 옛 이름. 디스크 경로·해석 순서는 `elanousDataDir` 과 같다. */
export function conatusDataDir(): string {
  return elanousDataDir();
}

/** 호환 export — 옛 이름. `elanousDataPath` 와 같은 문자열. */
export function conatusPath(...parts: string[]): string {
  return elanousDataPath(...parts);
}
