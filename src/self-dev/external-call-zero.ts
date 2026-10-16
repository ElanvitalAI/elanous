// ── 외부 호출 0 모드 가드 — LLM·검색·크롤 외부 호출을 «거부하고 남긴다» ─────────────
//
// «외부 호출 0 모드»(external-call-zero mode)가 켜져 있으면 LLM·검색·크롤 외부 호출
// 시도는 전부 거부되고, 거부된 시도마다 감사 원장에 한 줄이 덧붙는다(타임스탬프 ·
// 호출 범주 · 호출자 맥락). 원장은 append-only — 이력은 «덧붙일 수만» 있고,
// 읽는 쪽이 고치거나 지울 수는 없다.
//
// 이 모듈은 순수 가드다. run-supervisor.ts 로의 배선(LLM/검색/크롤 시도를 이 가드로
// 돌리는 시임)은 이 정의를 소비하는 별도 의존 조각의 몫이다 — 여기서 운영 경로를
// 건드리지 않는 것은 의도된 경계다.

export const EXTERNAL_CALL_CATEGORIES = ['llm', 'search', 'crawl'] as const;

export type ExternalCallCategory = (typeof EXTERNAL_CALL_CATEGORIES)[number];

/** 거부된 외부 호출 시도 한 건 — 감사 원장의 한 줄. */
export interface ExternalCallAuditEntry {
  /** 0부터 매 거부 시도마다 하나씩 — 같은 원장에서 재사용되지 않는다. */
  readonly seq: number;
  /** 시각(ISO 8601). */
  readonly at: string;
  /** 시도한 외부 표면(llm | search | crawl). */
  readonly category: ExternalCallCategory;
  /** 호출자 맥락 — 누가(어느 파일·함수·지점) 외부 호출을 청했나. */
  readonly caller: string;
}

export interface ExternalCallZeroVerdict {
  readonly denied: boolean;
  /** 거부되어 원장에 덧붙은 줄 — 거부된 시도에만 있다. */
  readonly entry?: ExternalCallAuditEntry;
}

export interface ExternalCallZeroOptions {
  /** true = 외부 호출 0 모드. 기본 false — 평소 동작(호출 통과 · 기록 없음). */
  readonly enabled?: boolean;
  /** 시험용 시계 주입 — 운영은 벽시계를 쓴다. */
  readonly now?: () => Date;
}

export class ExternalCallZeroGuard {
  private readonly zeroMode: boolean;
  private readonly clock: () => Date;
  private readonly entries: ExternalCallAuditEntry[] = [];

  constructor(options: ExternalCallZeroOptions = {}) {
    this.zeroMode = options.enabled ?? false;
    this.clock = options.now ?? (() => new Date());
  }

  /** 외부 호출 0 모드가 켜져 있는가. */
  get enabled(): boolean {
    return this.zeroMode;
  }

  /**
   * 외부 호출 시도를 가드로 돌린다. 켜진 모드에서는 모든 llm/search/crawl 시도를
   * 거부하고 시도마다 감사 원장에 한 줄을 덧붙인다. 꺼진 모드는 시도를 그대로
   * 통과시키고 아무것도 기록하지 않는다.
   */
  attempt(category: ExternalCallCategory, caller: string): ExternalCallZeroVerdict {
    if (!this.zeroMode) return { denied: false };
    const entry: ExternalCallAuditEntry = Object.freeze({
      seq: this.entries.length,
      at: this.clock().toISOString(),
      category,
      caller,
    });
    this.entries.push(entry);
    return { denied: true, entry };
  }

  /** Append-only 읽기 뷰 — 얼린 스냅숏. 읽는 쪽은 이력을 못 고친다. */
  ledger(): readonly ExternalCallAuditEntry[] {
    return Object.freeze([...this.entries]);
  }
}
