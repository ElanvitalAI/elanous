// SEAT-FOREIGN-PR-PUSH-GUARD — 남의 PR 가지 push 거부 (OP #134088 · 0.3.34 P1-3)
//
// 2026-11-23 하루에 다른 자리의 PR 가지로 push 한 개입이 7건 관측됐다(CC-1×3·CC-2·
// MVP-B·POOL-4·HAND-ELN). 기존 `elanous git push` 관문(`guardPushOwnership`)은 남의
// PR 가지를 «감사 행과 함께 경고하고 통과»시켰다 — 경고는 막지 못한다.
//
// 해소: 결정 코어를 이 공유 모듈에 두고 «eln git/pr 명령 경로» — `git push` 관문과 `eln pr`
// 의 push 페이즈(`pushLiveConflictMerge`) — 가 같은 규칙을 쓴다.
//   ① 호출 자리(ELANOUS_TRACK)의 가지 접두어(`mob1/…`)면 자기 가지 — 허용
//   ② PR 의 `delegates:<호출자리>` 위임 라벨이 있으면 주인 위임 — 허용
//   ③ PR 작성 자리(`seat:` 라벨)가 호출 자리면 자기 PR — 허용
//   ④ 나머지(가지 접두어·PR 자리가 다른 자리) — 거부(영어 문구). git 경로는
//      `--force-owner` 로 명시적 우회만 허용하고 감사 행을 남긴다.
//
// 출처: OP #134088 배정 문구(«eln git/pr 명령 경로» · «주인 위임 표식이 있으면 허용»).
// #39756 수리2: land 원격 워커(`runPrLandRemoteGit`) 배선을 철회했다 — 워커 입력에는 PR
// 라벨이 없어 `delegates:` 위임 표식을 존중할 수 없다(위임받은 격리 land 착지를 거부하는
// 잠복 결함). 관측 27 fail(b08b69b3ad 검증 우주)은 환경(댕글링 node_modules 심볼릭 링크)
// 요인으로 base/head fail 집합이 동일했고 정상 링크에서 base 75/0 · head 78/0 — 출처:
// 하위 분류 원문 ~/.elanous/data/agent-results/c52e6ea1-cbf3-4f5c-8146-8c889e49a133.txt
// (TC-H-CC-1 msg:134814 교차 배달 회신).
//
// 출처: 자리 패턴 `/^[A-Z][A-Z0-9-]{1,11}$/` — git-cli.ts 호출-자리 해석과 동일 규칙.

const SEAT_ID = /^[A-Z][A-Z0-9-]{1,11}$/u;
const SEAT_LABEL = /^seat:([A-Z][A-Z0-9-]{1,11})$/u;
const DELEGATE_LABEL = /^delegates:([A-Z][A-Z0-9-]{1,11})$/u;

/** GitHub 가 공급하는 라벨 목록 그대로(`[{ name }]`, 부재 가능). */
export type PushOwnershipLabels = readonly ({ name?: string } | null)[] | undefined;

/** 호출 자리 — `ELANOUS_TRACK`/`ELANOUS_HARNESS_SEAT`, 없으면 `…/seats/<자리>` 경로 조각. */
export function callingSeatFromEnv(cwd: string = process.cwd()): string | undefined {
  const fromEnv = [process.env.ELANOUS_TRACK, process.env.ELANOUS_HARNESS_SEAT]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && SEAT_ID.test(value)));
  if (fromEnv) return fromEnv;
  const parts = cwd.split(/[\\/]+/);
  const seatIndex = parts.lastIndexOf('seats');
  const fromPath = seatIndex >= 0 ? parts[seatIndex + 1] : undefined;
  return fromPath && SEAT_ID.test(fromPath) ? fromPath : undefined;
}

/** 자리 → 가지 접두어: `MOB-1` → `mob1`(소문자화·하이픈 제거 — 실측 가지 `mob1/…`). */
export function seatPrefixOfSeat(seat: string): string {
  return seat.toLowerCase().replace(/-/g, '');
}

/** 가지 접두어: `mob1/cell` → `mob1`, `refs/heads/mob1/cell` → `mob1`, `main` → undefined. */
export function seatPrefixOfBranch(branch: string): string | undefined {
  const ref = branch.replace(/^refs\/heads\//u, '');
  return /^([a-z0-9]+)\//u.exec(ref)?.[1];
}

/** PR 소유 자리 라벨(`seat:MOB-1`). */
export function seatLabelOf(labels: PushOwnershipLabels): string | undefined {
  for (const item of labels ?? []) {
    const match = SEAT_LABEL.exec(item?.name ?? '');
    if (match) return match[1];
  }
  return undefined;
}

/** 주인 위임 라벨(`delegates:MOB-1`)이 위임한 자리들(여러 개 가능). */
export function delegatedSeatsOf(labels: PushOwnershipLabels): string[] {
  const seats: string[] = [];
  for (const item of labels ?? []) {
    const match = DELEGATE_LABEL.exec(item?.name ?? '');
    if (match) seats.push(match[1]!);
  }
  return seats;
}

export type PushSeatOwnership =
  | { kind: 'allow'; reason?: string }
  | { kind: 'refuse'; reason: string };

/** 가지 접두어·PR 작성 자리 ↔ 호출 자리 대조 — 자기/위임/주인이면 허용, 남의 것이면 거부 사유. */
export function decidePushSeatOwnership(input: {
  callingSeat: string | undefined;
  branch: string;
  ownerSeat?: string | undefined;
  delegatedTo?: readonly string[];
}): PushSeatOwnership {
  const callingSeat = input.callingSeat?.trim();
  if (!callingSeat) return { kind: 'allow', reason: 'calling seat is unavailable' };
  if (input.delegatedTo?.includes(callingSeat)) return { kind: 'allow', reason: `owner delegated this PR to seat ${callingSeat}` };
  if (input.ownerSeat === callingSeat) return { kind: 'allow', reason: `own PR (seat:${callingSeat})` };
  if (input.ownerSeat) {
    return { kind: 'refuse', reason: `branch ${input.branch} belongs to PR owner seat ${input.ownerSeat}; calling seat is ${callingSeat}` };
  }
  const prefix = seatPrefixOfBranch(input.branch);
  const ownPrefix = seatPrefixOfSeat(callingSeat);
  if (prefix && prefix !== ownPrefix) {
    return { kind: 'refuse', reason: `branch ${input.branch} has prefix '${prefix}' that does not match calling seat ${callingSeat} (own prefix '${ownPrefix}/')` };
  }
  return { kind: 'allow', reason: 'no seat ownership signal contradicts the calling seat' };
}

/** 거부 문구(영어) — 사람 화면·감사 행에 그대로 쓴다. */
export function foreignPushRefusal(input: { callingSeat: string | undefined; branch: string; ownerSeat?: string | undefined }): string {
  const caller = input.callingSeat ?? '(unavailable)';
  const owned = input.ownerSeat ? ` owned by seat ${input.ownerSeat}` : '';
  return `push owner guard refused: push to branch ${input.branch}${owned} is another seat's branch; calling seat ${caller} may push its own '${seatPrefixOfSeat(caller)}/' branches, its own PRs, or PRs labeled 'delegates:${caller}'; use --force-owner to override with an audit record`;
}