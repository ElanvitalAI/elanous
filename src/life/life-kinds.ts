/**
 * LIFE-KINDS (MK · 0.2.43 · RFC-harness-full-journey-as-graph §4a·§4c) —
 * 생애(life) 종류 · 종류별 «끝의 증거» · 반복 실행 시리즈.
 *
 * Situation: 생애 원장(§4a)은 걸음을 시간순으로 쌓지만, «이 생애가 어떤 종류의 일이고
 *   무엇이 있어야 끝인가»를 아는 단일 목록이 없었다. 개발(PR) · 실행(산출물) ·
 *   운영 조치(상태 측정) · 행정(증빙)이 각자 다른 곳에서 그 종결을 판단했다.
 * Answer: 종류 닫힌 목록(`LIFE_KINDS`)과 종류별 «끝의 증거»(`LIFE_KIND_SPECS`)를 한 곳에 두고,
 *   주어진 종류에 대해 필요한 증거와 충족 여부를 판정한다(`evaluateLifeEnd`).
 *   같은 종류의 반복 실행은 시리즈(`createLifeRunSeries`)로 순차 기록·조회한다 —
 *   시각은 주입된 시계(`now`)에서만 얻으므로 가짜 시계로 그대로 시험할 수 있다.
 *
 * ⛔ 이 모듈은 순수하다 — 파일·환경·네트워크를 건드리지 않는다(생산 배선 = `life-cli.ts`).
 */

/** 생애 종류의 닫힌 목록 — 순서는 표시 순서이기도 하다. */
export const LIFE_KINDS = ['dev', 'run', 'ops', 'admin'] as const;
export type LifeKind = (typeof LIFE_KINDS)[number];

/** 끝을 증명할 수 있는 증거의 닫힌 목록 — PR · 산출물 · 상태 측정 · 증빙. */
export const LIFE_END_EVIDENCE_KINDS = ['pr', 'artifact', 'state-measurement', 'proof'] as const;
export type LifeEndEvidenceKind = (typeof LIFE_END_EVIDENCE_KINDS)[number];

/** 종류 하나의 표시명과, 그 종류의 «끝»을 증명하는 데 필요한 증거 종류. */
export interface LifeKindSpec {
  kind: LifeKind;
  label: string;
  endsWith: readonly LifeEndEvidenceKind[];
}

/** §4c 의 네 종류 — 기능(개발)은 PR, 실행은 산출물, 운영 조치는 상태 측정, 행정은 증빙으로 끝난다. */
export const LIFE_KIND_SPECS: readonly LifeKindSpec[] = [
  { kind: 'dev', label: '개발', endsWith: ['pr'] },
  { kind: 'run', label: '실행 산출', endsWith: ['artifact'] },
  { kind: 'ops', label: '운영 조치', endsWith: ['state-measurement'] },
  { kind: 'admin', label: '행정', endsWith: ['proof'] },
];

const SPEC_BY_KIND: ReadonlyMap<LifeKind, LifeKindSpec> = new Map(LIFE_KIND_SPECS.map((spec) => [spec.kind, spec]));

export function isLifeKind(value: string): value is LifeKind {
  return (LIFE_KINDS as readonly string[]).includes(value);
}

export function isLifeEndEvidenceKind(value: string): value is LifeEndEvidenceKind {
  return (LIFE_END_EVIDENCE_KINDS as readonly string[]).includes(value);
}

export function lifeKindSpec(kind: LifeKind): LifeKindSpec {
  const spec = SPEC_BY_KIND.get(kind);
  if (!spec) throw new Error(`생애 종류가 아니다: ${String(kind)} — ${LIFE_KINDS.join('|')} 중 하나여야 한다`);
  return spec;
}

/** 주어진 종류의 «끝»을 증명하려면 있어야 하는 증거 종류 목록. */
export function requiredEndEvidence(kind: LifeKind): readonly LifeEndEvidenceKind[] {
  return lifeKindSpec(kind).endsWith;
}

/** 끝의 증거 한 건 — 종류와, 그것을 가리키는 참조(PR 번호·산출물 경로·측정 명령·증빙 id). */
export interface LifeEndEvidence {
  kind: LifeEndEvidenceKind;
  ref: string;
}

export interface LifeEndVerdict {
  kind: LifeKind;
  required: readonly LifeEndEvidenceKind[];
  /** 넘겨받은 증거 중 이 종류에 실제로 쓰인 것(빈 ref 는 세지 않는다). */
  present: readonly LifeEndEvidence[];
  missing: readonly LifeEndEvidenceKind[];
  satisfied: boolean;
}

function hasUsableRef(evidence: LifeEndEvidence): boolean {
  return typeof evidence.ref === 'string' && evidence.ref.trim().length > 0;
}

/**
 * 종류별 «끝» 판정 — 필요한 증거 종류마다 ref 가 있는 증거가 하나 이상 있어야 충족이다.
 * 필요한 종류가 아닌 증거는 `present` 에만 남고 판정을 바꾸지 않는다.
 */
export function evaluateLifeEnd(kind: LifeKind, evidence: readonly LifeEndEvidence[]): LifeEndVerdict {
  const required = requiredEndEvidence(kind);
  const present = evidence.filter((item) => hasUsableRef(item) && required.includes(item.kind));
  const missing = required.filter((requiredKind) => !present.some((item) => item.kind === requiredKind));
  return { kind, required, present, missing, satisfied: missing.length === 0 };
}

/** 반복 실행 시리즈의 한 칸 — 같은 종류의 몇 번째 실행인지(`seq`)와 그때의 끝 판정. */
export interface LifeRunSeriesEntry {
  seq: number;
  kind: LifeKind;
  /** 주입된 시계에서 얻은 ISO 시각. */
  at: string;
  note?: string;
  evidence: readonly LifeEndEvidence[];
  satisfied: boolean;
}

export interface LifeRunSeriesAppendInput {
  kind: LifeKind;
  note?: string;
  evidence?: readonly LifeEndEvidence[];
}

export interface LifeRunSeriesLookup {
  kind: LifeKind;
  seq: number;
}

export interface LifeRunSeries {
  /** 같은 종류의 다음 `seq` 로 한 칸을 덧붙인다(다른 종류의 seq 와 섞이지 않는다). */
  append(input: LifeRunSeriesAppendInput): LifeRunSeriesEntry;
  /** 종류를 주면 그 종류의 시리즈만, 안 주면 전체를 append 순서대로. */
  list(kind?: LifeKind): readonly LifeRunSeriesEntry[];
  /** 종류 + seq 로 한 칸을 찾는다 — 없으면 undefined. */
  lookup(query: LifeRunSeriesLookup): LifeRunSeriesEntry | undefined;
}

export interface LifeRunSeriesOptions {
  /** 시계 주입 — 가짜 시계로 시험한다. */
  now: () => Date;
  /** 이어받을 기존 시리즈(예: 파일에서 읽은 원장). */
  entries?: readonly LifeRunSeriesEntry[];
}

export function createLifeRunSeries(options: LifeRunSeriesOptions): LifeRunSeries {
  const entries: LifeRunSeriesEntry[] = [...(options.entries ?? [])].map((entry) => {
    lifeKindSpec(entry.kind);
    return { ...entry, evidence: [...entry.evidence] };
  });

  return {
    append(input) {
      lifeKindSpec(input.kind);
      const previous = entries.filter((entry) => entry.kind === input.kind);
      const seq = previous.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
      const evidence = [...(input.evidence ?? [])];
      const verdict = evaluateLifeEnd(input.kind, evidence);
      const entry: LifeRunSeriesEntry = {
        seq,
        kind: input.kind,
        at: options.now().toISOString(),
        ...(input.note === undefined ? {} : { note: input.note }),
        evidence,
        satisfied: verdict.satisfied,
      };
      entries.push(entry);
      return entry;
    },
    list(kind) {
      return kind === undefined ? entries.map((entry) => ({ ...entry })) : entries.filter((entry) => entry.kind === kind).map((entry) => ({ ...entry }));
    },
    lookup({ kind, seq }) {
      const found = entries.find((entry) => entry.kind === kind && entry.seq === seq);
      return found === undefined ? undefined : { ...found };
    },
  };
}
