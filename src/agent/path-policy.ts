// ── 파일 경로 보안 정책 단일 출처 — turn 조립기 통일 Phase 4b (2026-07-22) ──
//
// 코딩코어 fs-tool(Read/Edit/Write/Grep)이 서피스마다 다른 경로 보안을 각자 구현하던 것을 단일
// 정책 축으로. 조사(4b 검토)가 밝힌 실제 드리프트 = 출력 shape 가 아니라 **경로 해석+보안**:
//   - native(skills/tools): getSessionCwd resolve, 가드 없음 (= permissive)
//   - daemon(daemon-tools): resolveSafe(cwd-앵커 + credential deny-list) (= strict)
//   - ⚠️ telegram/discord 는 원격 입력인데 native(무가드) 사용 → .ssh/.env 열람 가능 갭
//
// 대표 결정(2026-07-22): 보안 path-policy 만 통합(출력 shape 무접촉) + telegram/discord=strict.
// 이 모듈이 단일 정책 출처 — 각 서피스는 자기 트러스트에 맞는 PathPolicy 를 fs-tool dispatch 에 전달.
//
// strict/anchored 는 daemon path-guard 의 검증된 원시(resolveSafe/anchoredResolve)를 재사용(재발명0·
// 보안 로직 단일 출처). permissive 는 native 현행과 동일(~ 확장 + relative→cwd·무제한).

import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { anchoredResolve, resolveSafe, SENSITIVE_GLOBS } from '../boot/daemon-tools/path-guard.js';

/** 서피스 트러스트별 경로 보안 정책.
 *  - permissive: ~ 확장 + relative→cwd·무제한(로컬 CLI·셸 동급 신뢰).
 *  - anchored:   cwd-탈출 차단(symlink 포함)·deny-list 없음(중간 강도).
 *  - strict:     cwd-앵커 + credential deny-list(원격 신뢰불가 — daemon/telegram/discord). */
export type PathPolicy = 'permissive' | 'anchored' | 'strict';

/** input 을 cwd 기준으로 해석하되 policy 로 보안 강도를 고른다. strict/anchored 위반 시
 *  ToolSafetyError throw. permissive 는 해석만(제한 없음). daemon 의 검증된 원시를 재사용. */
export function resolvePathWithPolicy(input: string, cwd: string, policy: PathPolicy): string {
  // ~ 를 먼저 펼친다 — strict/anchored 는 펼친 뒤에도 cwd-앵커·deny-list 가 그대로 막는다.
  const expanded = expandHomePath(input);
  if (policy === 'strict') return resolveSafe(expanded, cwd);      // cwd-앵커 + deny-list
  if (policy === 'anchored') return anchoredResolve(expanded, cwd); // cwd-앵커만
  // permissive — native 현행과 동일: ~ 확장 후 relative→cwd, 제한 없음.
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/** 맨 앞 `~` · `~/…` 를 지금 사용자의 홈 디렉토리로 펼친다(셸과 같은 뜻).
 *  모델이 `~/…` 를 그대로 넘기면 rg·fs 는 `<cwd>/~/…` 로 읽어 실패한다(Grep/Glob/ListDir).
 *  `~user/…` 는 펼치지 않는다 — 다른 사용자 홈을 추측하면 엉뚱한 디렉토리(예: 홈 옆 `tmp`)를 읽는다. 원문 그대로 둔다. */
export function expandHomePath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('~')) return input;
  if (input !== '~' && input[1] !== '/' && input[1] !== '\\') return input;
  const home = process.env.HOME || homedir();
  if (!home) return input;
  const rest = input.slice(1);
  return rest ? join(home, rest) : home;
}

/** Grep(strict) 이 재귀 검색에서 자격증명/키 파일을 배제할 rg exclude glob 인자 시퀀스
 *  (`-g !.env -g !*.pem …`). SENSITIVE_GLOBS 단일 출처 재사용(Phase 4b PR3). */
export function sensitiveRgExcludeArgs(): string[] {
  return SENSITIVE_GLOBS.flatMap((g) => ['-g', `!${g}`]);
}
