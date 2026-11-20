/**
 * [PWA-INTAKE-N1-N5A-N6A] self-review r3 mustFix — 데몬 health 탐침 세대 가드.
 *
 * DaemonProvider 가 /v1/health 탐침 결과를 daemonAvailable 로 반영할 때 쓴다.
 *   - probe(): 탐침 1회. 세대(seq)를 올리고 시작한다 — 그 사이 더 새 세대가
 *     생기면(다음 탐침·invalidateSync) 그 응답은 폐기한다. 15초 주기 탐침이
 *     겹쳐도 «먼저 시작한 탐침의 늦은 성공»이 «나중 탐침의 실패»를 덮지 않는다.
 *   - invalidateSync(): 설정(baseUrl·token)이 바뀐 «순간» 호출. 즉시 false 로
 *     보고하고 진행 중인 모든 탐침을 파기한다 — useEffect 까지 미루면 바뀐
 *     설정의 첫 렌더에 이전 true 가 남아 제출 버튼이 켜진다(r3 mustFix).
 *
 * React 상태에 얽히지 않는 순수 로직이라 bun test 로 직접 시험한다
 * (daemon-health.test.ts — RED 원문: seat-state/MOB-1/evidence/pwa-intake-r3-1120/).
 */
export interface DaemonHealthClientLike {
  health(): Promise<{ ok: boolean }>;
}

export class DaemonHealthController {
  private seq = 0;

  constructor(
    private readonly client: DaemonHealthClientLike,
    private readonly report: (available: boolean) => void,
  ) {}

  /** 현재 세대(시험·디버그용). */
  get generation(): number {
    return this.seq;
  }

  /** 설정 변경 등 — 즉시 미가용(false) 보고 + 진행 중 탐침 전부 파기. */
  invalidateSync(): void {
    this.seq += 1;
    this.report(false);
  }

  /** health 탐침 1회. 시작하며 세대를 올린다 — 그 응답 전에 더 새 세대가 생기면 폐기. */
  probe(): void {
    const seq = ++this.seq;
    void this.client
      .health()
      .then((r) => {
        if (seq === this.seq) this.report(Boolean(r.ok));
      })
      .catch(() => {
        if (seq === this.seq) this.report(false);
      });
  }
}
