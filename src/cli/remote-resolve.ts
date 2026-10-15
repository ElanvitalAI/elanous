// CLI · `elanous` no-arg default remote resolve (Track 4.C · 2026-05-07)
//
// `elanous` 무인자 entry resolution:
//   1. `--local` flag                → force local NEXUS spawn (skip 모든 remote)
//   2. `--remote <name>`              → 그 bookmark 사용 (없으면 error)
//      `-r` (값 없음)                 → default bookmark (없으면 connect 안내)
//   3. ELANOUS_REMOTE env 가 set 된 경우  → 기존 ELANOUS_REMOTE 경로 (legacy compat)
//   4. remotes.json 의 default bookmark → 그 bookmark 사용
//   5. else                           → local
//
// ⛔⭐ `-r` 은 `--remote` 의 «완전한» 별칭이 아니다 — ***값을 먹지 않는다.***
//     `elanous -r` = default 북마크. 이름을 대려면 긴 형태 `--remote <name>`.
//     근거는 아래 readRemoteFlag 머리말(4R 리뷰 지적: 문법이 «데이터»에 달리면 안 된다).
// 외울 명령 = `elanous -r` + 처음 1회 `elanous nexus connect <host> --default`.

import { existsSync, readFileSync } from 'node:fs';
import { RemotesStore, type RemoteEntry } from './remotes.js';

export const DEFAULT_REMOTE_CONNECT_HINT = 'elanous nexus connect <host> --default';

/** 「세션을 이어 하려던 것」으로 보이는 모양.
 *  📏 **실물로 좁혔다**(리뷰 지적 · 2026-09-01): `~/.elanous/sessions/` 의 파일명은
 *  전부 ***완전한 UUID***다(`0000e49c-f9e8-4117-9d5f-795e57b541e9.jsonl`).
 *  ⛔ 옛 판은 `session-[A-Za-z0-9]` 까지 물어서 `session-home` 같은 «평범한 이름»을
 *     resume 안내로 막았다 — 잡으려던 것보다 넓었다.
 *  ⇒ 이제 UUID «하나»만 문다. 그 밖은 전부 조용히 bare `-r` 이다. */
const LOOKS_LIKE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RemoteResolution =
  | { kind: 'local'; reason: 'flag' | 'no-bookmark' | 'no-default' }
  | { kind: 'env'; reason: 'elanous-remote-set' }
  | { kind: 'remote'; name: string; entry: RemoteEntry; token: string | undefined; reason: 'flag' | 'default-bookmark' };

export interface ResolveRemoteAttachOpts {
  /** Original argv (before commander parse). */
  rawArgs: readonly string[];
  /** Override the bookmark store (tests). */
  store?: RemotesStore;
  /** Override env reader (tests). */
  envRemote?: string | undefined;
}

export function resolveRemoteAttach(opts: ResolveRemoteAttachOpts): RemoteResolution {
  const { rawArgs } = opts;
  if (hasFlag(rawArgs, '--local')) {
    return { kind: 'local', reason: 'flag' };
  }
  const store = opts.store ?? new RemotesStore();
  const remoteFlag = readRemoteFlag(rawArgs);
  if (remoteFlag.present) {
    if (remoteFlag.value.length === 0) {
      return resolveDefaultBookmark(store, 'flag');
    }
    const entry = store.getRemote(remoteFlag.value);
    if (!entry) {
      throw new Error(
        `--remote ${remoteFlag.value}: unknown bookmark. Run \`elanous nexus list\` to see available remotes.`,
      );
    }
    return {
      kind: 'remote',
      name: remoteFlag.value,
      entry,
      token: readToken(entry),
      reason: 'flag',
    };
  }
  const envRemote = (opts.envRemote ?? process.env.ELANOUS_REMOTE ?? '').trim();
  if (envRemote.length > 0) {
    return { kind: 'env', reason: 'elanous-remote-set' };
  }
  const defaultEntry = store.getDefaultRemote();
  if (!defaultEntry) {
    return { kind: 'local', reason: 'no-default' };
  }
  return namedDefault(store, defaultEntry, 'default-bookmark');
}

function resolveDefaultBookmark(
  store: RemotesStore,
  reason: 'flag' | 'default-bookmark',
): RemoteResolution {
  const defaultEntry = store.getDefaultRemote();
  if (!defaultEntry) {
    throw new Error(
      `no default remote bookmark. Run \`${DEFAULT_REMOTE_CONNECT_HINT}\` to set one.`,
    );
  }
  return namedDefault(store, defaultEntry, reason);
}

function namedDefault(
  store: RemotesStore,
  defaultEntry: RemoteEntry,
  reason: 'flag' | 'default-bookmark',
): RemoteResolution {
  const list = store.listRemotes();
  const defaultName = list.find((r) => r.isDefault)?.name ?? '?';
  return {
    kind: 'remote',
    name: defaultName,
    entry: defaultEntry,
    token: readToken(defaultEntry),
    reason,
  };
}

/** Strip `--local`, `--remote <name>`, and `-r` from rawArgs.
 *  The flags are consumed by `resolveRemoteAttach` before commander
 *  parses, so they must not survive into commander's argv (it would
 *  error 'unknown option').
 *
 *  ⛔⭐ `readRemoteFlag` 와 ***같은 규칙***이어야 한다 — 갈리면 한쪽이 먹고
 *  다른 쪽이 굶는다(그 상태가 이 판의 원래 버그였다). 규칙은 둘뿐이다:
 *  ① 루트 «선행» 플래그만 본다  ② 값을 먹는 것은 `--remote` 뿐이다. */
export function stripRemoteFlags(rawArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const tok = rawArgs[i];
    if (tok === '--local') continue;
    if ((tok === '--remote' || tok === '-r') && isLeadingFlag(rawArgs, i)) {
      if (tok === '--remote') {
        const next = rawArgs[i + 1];
        // 값이 없거나 플래그면 readRemoteFlag 가 이미 throw 한다. 여기서는
        // 「있으면 같이 지운다」만 한다 — 없는 것을 지우려 들지 않는다.
        if (next !== undefined && !next.startsWith('-')) i += 1;
      }
      continue;
    }
    if (tok !== undefined) out.push(tok);
  }
  return out;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

/** argv 의 «첫» 루트 선행 `--remote` / `-r`.
 *  `-r` → 항상 `{present:true, value:''}` (default 북마크).
 *  `--remote` → 값을 요구하고, 없으면 throw. */
/** ⛔⭐ `-r` 은 이 저장소에서 «이미» 쓰이던 짧은 이름이었다 —
 *  루트 대시보드가 argv 를 손으로 훑어 `--resume` 의 별칭으로 받았다
 *  (`src/index.ts` 의 resume 탐색기 두 줄).
 *
 *  📏 그 별칭을 «떼기로» 한 근거(2026-09-01 실측):
 *  ```
 *  commander option 선언        없음 — argv 를 직접 훑는 두 줄뿐
 *  `elanous --help` 노출          없음
 *  docs/scripts/test/.rules     `elanous -r <x>` 사용 0건
 *                               (grep 에 걸린 것은 전부 `rg -r`·`cp -r`·`read -r`)
 *  `--resume` (긴 형태)         58개 파일 — ***이쪽이 진짜 표면이고 그대로 둔다***
 *  ```
 *  ⇒ ***플래그 하나에 뜻 하나.*** `-r` 은 언제나 원격 북마크다.
 *
 *  ⛔⭐ **그리고 `-r` 은 «값을 먹지 않는다».** (4R 리뷰 지적을 받아 고쳤다.)
 *  📏 처음 판은 「뒤 토큰이 «실제 북마크»면 값, 아니면 서브커맨드」였다. 그러면
 *     ***같은 명령줄이 remotes.json 의 «내용»에 따라 다른 뜻이 된다*** —
 *     사람이 배울 수도, 시험이 고정할 수도 없는 계약이다. 그래서 뺐다.
 *
 *  ```
 *  elanous -r                 원격 default 북마크
 *  elanous -r attach          default 북마크 + `attach` 는 «서브커맨드»로 흐른다
 *  elanous --remote <name>    원격 named 북마크 (값 필수 — main 의 기존 계약)
 *  elanous --resume <x>       resume (그대로)
 *  elanous -r <UUID>          ⚠️ ***전환 안내로 거부*** — 아래 「전환 정책」 참조
 *  ```
 *
 *  ## 전환 정책 (한시적 · 리뷰 지적으로 «명시»한다)
 *  ⚠️ 위 마지막 줄은 「`-r` 은 값을 안 받는다」의 «예외처럼» 보인다. 아니다 —
 *  ***값으로 «받지» 않는다. 거부한다.*** 그래도 특별 취급인 건 맞아서 여기 적는다.
 *  ```
 *  대상   `-r` 뒤에 «완전한 UUID» 가 온 경우 «하나»뿐이다(세션 파일명의 실제 모양).
 *  행동   붙지 않고 exit 1 ⊕ `--resume` 로 가라고 말한다.
 *  이유   `-r` 이 예전에 `--resume` 의 숨은 별칭이었다. 안내가 없으면 그 손버릇은
 *         「엉뚱한 원격에 붙은 뒤 unknown command」로 나타나 원인을 못 찾는다.
 *  해제   이 별칭을 아는 사람이 없어지면 지운다. 지워도 그 자리는 「값 없는 -r ⊕
 *         UUID 는 서브커맨드」가 되어 commander 가 스스로 말한다 — 계약은 안 깨진다.
 *  ```
 *  🔒 그리고 ***이 예외가 넓어지지 않게*** 시험이 「안 무는 이름들」을 같이 고정한다. */
/** ⛔⭐ **전역 선처리는 «루트 선행 플래그»만 본다.**
 *  📏 안 그러면 다른 명령의 `-r` 을 «탈취»한다 — 실측:
 *  ```
 *  ["autopilot","link","A","B","-r","friend"]
 *    전:  flag={present:true} · strip=[...,"friend"]   ⛔ commander 가 -r 을 못 보고
 *                                                          --relation 이 조용히 기본값으로 떨어진다
 *    후:  flag={present:false} · strip=[원본 그대로]     ✅
 *  ```
 *  `src/index.ts` 의 옛 resume 탐색기가 이미 같은 규칙을 주석으로 말하고 있었다:
 *  *"Only a leading launch flag is owned here."* ⇒ 그 규칙을 여기서도 쓴다.
 *  ⊕ 서브커맨드 자기 `-r` 은 «그 명령이» 처리한다(예: `attach` 는 bookmarkAttachDefaults). */
/** ⭐⭐ **루트에서 «값을 받는» 플래그 — 선행 구간을 끊지 않는 것들.**
 *
 *  🩸 이 상수는 «한계를 합리화하다가» 생겼다. 처음엔 *"각 플래그의 arity 는 commander 만
 *  아니 `elanous --config-dir /x -r` 은 원리상 못 잡는다"* 라고 쓰고 그것을 시험으로 «고정»했다.
 *  ⛔ 리뷰가 그것을 ***Goodhart*** 라 불렀고 «맞다» — 수용기준 미달을 검증으로 포장한 것이다.
 *
 *  📏 그래서 세어 봤다: 루트 `program` 이 선언하는 옵션은 ***넷***이고 값을 받는 것은
 *  ***`--config-dir <dir>` 하나***뿐이다(`--test` 는 불리언이고 `--test=<dir>` 는 `=` 형태라
 *  모호함이 없다 · `-V`/`-h` 도 불리언). ⇒ ***열거 가능하다.*** 못 하는 게 아니었다.
 *
 *  ⚠️ 늙을 수 있는 목록이라 ***시험이 감시한다*** — `src/index.ts` 의 루트 옵션 선언을
 *  읽어 `<값>` 을 받는 것이 전부 여기 있는지 확인한다(`root value-taking flags are enumerated`).
 *  ⇒ 루트에 값 받는 플래그를 더하면 그 시험이 «먼저» 깨진다. */
// ⭐ `--name <name>` = 대시보드 TUI 별명(dashboard-name-flag.ts) — 값이 다음 토큰이라 `elanous --name op -r` 의 `-r` 이 루트로 남게 센다.
export const ROOT_FLAGS_TAKING_VALUE = new Set(['--remote', '--config-dir', '--name']);

/** 이 토큰이 루트 «선행 플래그 구간» 안에 있나 — 즉 전역 선처리가 소유하나.
 *  ⛔ 없으면 다른 명령의 `-r` 을 «탈취»한다(`autopilot link … -r friend`).
 *
 *  🩸 그리고 ***`--` 는 플래그가 아니라 «옵션의 끝»이다***(리뷰 지적 · 실물 재현).
 *  `--` 도 `-` 로 시작하니 옛 판은 그것을 플래그로 세었고, 그래서
 *  `elanous -- -r` 의 위치 인자 `-r` 을 «원격 플래그로 탈취»했다
 *  (실측: "attaching to remote: probe" 를 찍었다). `--` 뒤는 전부 위치 인자다. */
function isLeadingFlag(args: readonly string[], index: number): boolean {
  for (let i = 0; i < index; i += 1) {
    const prior = args[i]!;
    // ⛔ 옵션 종료자 — 여기서 «전역 선처리를 끝낸다».
    if (prior === '--') return false;
    if (prior.startsWith('-')) continue;
    // ⭐ 값을 받는 루트 플래그의 «자기 값»은 선행 구간을 안 끊는다.
    if (i > 0 && ROOT_FLAGS_TAKING_VALUE.has(args[i - 1]!)) continue;
    return false;
  }
  return true;
}

export function readRemoteFlag(args: readonly string[]): { present: boolean; value: string } {
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    if (tok !== '--remote' && tok !== '-r') continue;
    if (!isLeadingFlag(args, i)) continue;
    const next = args[i + 1];

    if (tok === '-r') {
      // ⛔ `-r` 은 ***절대 값을 먹지 않는다.*** 그래서 `elanous -r attach` 의
      //    `attach` 는 서브커맨드로 그대로 흐른다.
      // 🩹 다만 옛 손버릇 하나는 «말해 준다» — `-r` 은 예전에 루트에서
      //    `--resume` 의 숨은 별칭이었다. 세션 id 모양이 오면 조용히
      //    default 원격에 붙지 않고 갈 곳을 알린다.
      if (next !== undefined && LOOKS_LIKE_SESSION_ID.test(next)) {
        throw new Error(
          `-r ${next}: \`-r\` 은 이제 «원격 북마크»이고 값을 받지 않습니다.\n`
          + '  세션을 이어 하려면 `--resume <id>` 를 쓰십시오.\n'
          + `  원격 이름을 대려면 \`--remote <name>\`, 목록은 \`elanous nexus list\`.`,
        );
      }
      return { present: true, value: '' };
    }

    // 긴 형태는 값을 «요구»한다 (main 의 기존 계약 그대로).
    if (next === undefined || next.startsWith('-')) {
      throw new Error('--remote requires a bookmark name (e.g. `elanous --remote mbp`).');
    }
    return { present: true, value: next };
  }
  return { present: false, value: '' };
}

function readToken(entry: RemoteEntry): string | undefined {
  if (!existsSync(entry.token_file)) return undefined;
  try {
    const v = readFileSync(entry.token_file, 'utf-8').trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Convert a bookmark entry's `acp_url` (ws://...) to the env var that
 *  resolveRemoteTarget understands. */
export function bookmarkToElanousRemote(entry: RemoteEntry): string {
  // Already ws-formed; resolveRemoteTarget passes through.
  // ⛔⭐ **조용히 떨어지지 않는다.** remotes.json 은 사람이 고칠 수 있는 파일이라
  //    `acp_url` 이 빠질 수 있다. 그러면 «타입은 string 인데 런타임은 undefined»가 된다.
  //    📏 실측으로 밟았다(2026-09-01) — 화면엔 "attaching to remote: probe" 가 찍히고
  //       실제로는 로컬 unix 소켓으로 붙었다. ***도구가 거짓말을 한다.***
  //
  //  ## 회귀 호환성 근거 (리뷰가 «별도 PR 로 분리하거나 근거를 대라» 해서 적는다)
  //  📏 이 함수의 «제품» 호출자는 ***둘***이다(전수: `git grep bookmarkToElanousRemote`):
  //  ```
  //  bookmarkAttachDefaults → host   → 호출부가 `bookmarkHost ? …` 로 읽는다  ⇒ falsy = 조용히 «누락»
  //  src/index.ts:11397              → process.env.ELANOUS_REMOTE = <undefined>
  //                                    (Bun 은 그 키를 «지운다» — Node 의 "undefined" 문자열화와 다르다.
  //                                     실측: `process.env.X = undefined` → typeof undefined)
  //                                                                        ⇒ 역시 조용히 «누락»
  //  ```
  //  ⇒ ***「로컬 fallback」은 «정책»이 아니라 «검사 안 한 타입»의 사고였다.***
  //     두 자리 모두 값을 «쓰지 않고 버렸을» 뿐, 어느 쪽도 그 falsy 를 «읽어 분기»하지 않는다.
  //     ⇒ 이 throw 로 «잃는 동작이 없다». 얻는 것은 「거짓말 대신 이름」이다.
  //  📌 그리고 이 판이 `-r` 이라는 «새 쉬운 문»을 여는 판이라, 그 문으로 들어온 사람이
  //     가장 먼저 만날 실패가 «조용한 오접속»이면 안 된다 — 그래서 여기에 둔다.
  const url = entry.acp_url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(
      `remote bookmark ${entry.host}: acp_url 이 비어 있습니다 (remotes.json 손상).\n`
      + `  \`elanous nexus connect ${entry.host}\` 로 다시 등록하십시오.`,
    );
  }
  return url;
}

/** Bookmark values to feed `resolveRemoteTarget` as host / token-file
 *  defaults. Explicit `--url`/`--host` and `--token`/`--token-file` on
 *  the caller win because they are applied first. */
export function bookmarkAttachDefaults(entry: RemoteEntry): { host: string; tokenFile: string } {
  return {
    host: bookmarkToElanousRemote(entry),
    tokenFile: entry.token_file,
  };
}
