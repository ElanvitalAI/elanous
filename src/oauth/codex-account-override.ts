// 호출 범위 codex 계정 override — 지출 관문이 «고른 행» 을 process.env 를 바꾸지 않고 호출 단위로 전한다. (LLM-AUTO-PROVIDER-E2E)
//
// ⛔ 전역 env(ELANOUS_CODEX_ACCOUNT) 임시 변경 금지: 동시 호출에서 A(team) 중 B(default) 가 끼면 A 가 default 로 가고,
//    끝나는 순서에 따라 env 가 영구 잔존한다. AsyncLocalStorage 는 «그 호출의 async 흐름 안» 에서만 보인다.
// 우선순위(기존 «env 명시 > pin > 회전» 존중): 관문 override 는 «명시 env 가 없을 때만» 적용되고, 있으면 pin·회전보다 먼저 이긴다.
//   근거: 사람이 ELANOUS_CODEX_ACCOUNT 로 명시한 계정은 «사람 의도» 이므로 관문(자동 선택)이 덮지 않는다. 관문의 선택은 명시가 없는
//   자동 구간에서 회전·pin 의 «자동 판정» 을 대신하는 것이라 pin·회전보다 앞에 둔다(고르고 나서 다시 회전하면 선택이 뒤집힌다).

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ readonly account: string }>();

/** 이 호출 범위(fn 의 async 흐름)에서만 codex 계정 이름을 account 로 고정한다. process.env 는 건드리지 않는다. */
export function withCodexAccountOverride<T>(account: string, fn: () => T): T {
  return store.run({ account }, fn);
}

/** 현재 호출 범위의 관문 선택 계정(없으면 undefined). */
export function currentCodexAccountOverride(): string | undefined {
  return store.getStore()?.account;
}

/** 로깅·태그용 «이 호출의 유효 계정 이름» — 명시 env > 관문 override. */
export function effectiveCodexAccountName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.ELANOUS_CODEX_ACCOUNT?.trim();
  return explicit ? explicit : currentCodexAccountOverride();
}
