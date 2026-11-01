// ── PTY 에 «써 넣은» 이력 (관측용 · 판정 아님) ──────────────────────────────────
//
// ⛔⭐⭐⭐ **왜 이것이 필요한가** (`[S]` 원장 `RUN-S25` · `[T]` 리뷰 2026-08-07):
//   PTY 에 써 넣은 문장이 자식의 화면 버퍼에 에코되고, 부모의 완료 판정
//   (`findCompletionMarkerLine`)이 그것을 ***자식의 완료 선언***으로 읽는다.
//   ⇒ 「거짓 성공」의 둘째 채널이다.
//
// ⛔ **막지 않는다** — 마커 규칙을 조이면 «진짜 완료를 놓치는» 반대 손해가 더 크고
//   (`completion-marker.ts` 머리말이 이미 경고한다), 써 넣는 것 자체는 정상 조작이다
//   (`CLAUDE.md` 가 `elanous pty text` 를 처방한다). ⇒ 제1원칙대로 **관측을 먼저** 세운다.
//
// ⭐⭐ **「외부」의 뜻** — ***자식이 «낸» 것이 아니라 «받은» 것***이다.
//   자식은 이 함수를 부르지 않는다(자식 출력은 adapter `onData` 로 들어온다).
//   그러므로 `handle.write` 를 지나는 모든 바이트가 여기 세어진다:
//     ⓐ 크로스-프로세스 `elanous pty text`(IPC → `handle.write`)
//     ⓑ **같은 프로세스의 감독 autoAssist** ⓒ `PtyShellSend` 툴
//   ⛔⭐ ⓑ 가 결정적이다 — `[S]` 리뷰가 잡았다. 종전 판은 계기가 **IPC 층에만** 있어
//     ***정작 「위조 채널을 여는 당사자」가 될 감독이 계기 밖***이었다.
//
// ⚠️ **프로세스 수명 한정**이다. 재시작하면 0 이고, 그것이 「써 넣은 적 없다」를 뜻하지 «않는다».
//   내구 기록은 `elanous logs --category pty.arbiter` 가 갖는다.

/** ⛔⭐ 상한 — 수명 훅이 못 닿는 경우(이벤트 유실·비정상 종료)의 **최종 방어**.
 *  장수 owner(데몬)는 PTY 를 계속 만든다. 훅만 믿으면 «한 번 새면 영영» 샌다. */
const MAX_TRACKED_PTYS = 512;

const writes = new Map<string, { count: number; lastAt: number; lastActor: string | null; accessMode?: 'read' | 'write' | 'auto' }>();

export function notePtyAccessMode(ptyId: string, accessMode: 'read' | 'write' | 'auto'): void {
  const prev = writes.get(ptyId);
  writes.delete(ptyId);
  writes.set(ptyId, { count: prev?.count ?? 0, lastAt: prev?.lastAt ?? 0, lastActor: prev?.lastActor ?? null, accessMode });
  while (writes.size > MAX_TRACKED_PTYS) {
    const oldest = writes.keys().next();
    if (oldest.done) break;
    writes.delete(oldest.value);
  }
}

export function ptyWriteControlState(ptyId: string): { accessMode: 'read' | 'write' | 'auto'; lastWriter: 'agent' | 'human' | null } | undefined {
  const rec = writes.get(ptyId);
  if (!rec?.accessMode) return undefined;
  const lastWriter = rec.lastActor === 'agent' || rec.lastActor === 'human' ? rec.lastActor : null;
  return { accessMode: rec.accessMode, lastWriter };
}

/** 성공한 쓰기 1건을 기록한다. ⛔ 거부·실패는 세지 않는다(자식이 «본» 것만 세야 수가 뜻을 갖는다). */
export function noteExternalWrite(ptyId: string, actor: string, now = Date.now()): void {
  const prev = writes.get(ptyId);
  // 재삽입으로 **삽입 순서를 갱신**한다 — 아래 축출이 「가장 오래 안 쓰인 것」을 버리게.
  writes.delete(ptyId);
  writes.set(ptyId, { count: (prev?.count ?? 0) + 1, lastAt: now, lastActor: actor, ...(prev?.accessMode ? { accessMode: prev.accessMode } : {}) });
  while (writes.size > MAX_TRACKED_PTYS) {
    const oldest = writes.keys().next();
    if (oldest.done) break;
    writes.delete(oldest.value);
  }
}

/**
 * 이 PTY 가 «받은» 쓰기 이력. 없으면 `undefined` — 호출자가 그 절을 생략할 수 있게.
 *
 * ⚠️⭐ **`externalWrites` 는 「쓰기 «호출» 수」이지 「조작 수」가 아니다**(`[S]` 실측 2026-08-07):
 *   `elanous pty text <ref> "…" --enter` **한 번**도 본문과 `\r` 을 따로 써서 **2** 가 된다.
 *   ⛔ 이 수로 *"사람이 몇 번 개입했나"* 를 읽으면 틀린다 — 세는 것은 ***자식이 몇 번 받았나***다.
 *   ⭐ 그리고 그것이 이 관측의 목적에 맞다: 에코는 **쓰기마다** 일어나므로 위조 표면은 호출 수를 따른다.
 */
export function externalWriteProvenance(ptyId: string, now = Date.now()): { externalWrites: number; externalWriteAgoMs: number; externalWriteActor: string } | undefined {
  const rec = writes.get(ptyId);
  if (!rec || rec.lastActor === null) return undefined;
  return { externalWrites: rec.count, externalWriteAgoMs: Math.max(0, now - rec.lastAt), externalWriteActor: rec.lastActor };
}

/** PTY 가 사라지면 버린다 — 수명 훅(`registry` 의 `exit`·`unregistered`)이 부른다. */
export function forgetExternalWriteProvenance(ptyId: string): void {
  writes.delete(ptyId);
}

/** 테스트 격리 — 프로세스 전역 맵을 비운다. */
export function resetExternalWriteProvenanceForTesting(): void {
  writes.clear();
}
