import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import type { TaPreflightEvidence } from './ta-preflight.js';

/**
 * TA-PREFLIGHT 증거 수집기 — 시범(canary) 런의 run 원장에서 조건 ①②의 «실측» 증거를 뽑는다. 순수 함수(읽기 전용).
 * 생산: self-implement-pod.ts 의 `pod-source-head-check`(① 자식 수신 HEAD)·`pod-image-digest`(② Pod 소비 digest).
 * 원장에 없거나 모양이 다르면 그 칸은 비운다 — 비어 있으면 검사기가 UNMEASURED 로 읽는다(추측·기본값 금지).
 * privateRepo 는 원장에 없는 사실이라 여기서 채우지 않는다.
 */
export interface CollectedPreflightEvidence {
  readonly source?: { requestedPin: string; childHead: string | null };
  readonly image?: { expectedDigest: string; observedDigest: string | null };
  /** 원장에 값이 «있는데» 형식이 틀린 칸 — 미관측(null)과 섞지 않는다. 값은 증거에 원값 일부로 그대로 실려 검사기가 FAIL 로 읽는다. */
  readonly malformed: readonly string[];
  readonly notes: readonly string[];
}

// 판정 표 용어(#38394 와 같음): 칸 × (있음 · 없음 · 형식 오류)
//   있음      → 값 그대로(검사기가 PASS/불일치 FAIL 판정)
//   없음      → 빈 칸/null  (검사기: UNMEASURED)
//   형식 오류 → 원값 일부(≤80자)를 그대로 싣고 malformed 에 적는다 (검사기: FAIL — 40자 hex·sha256:64hex 가 아님)
const HEX40 = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

type Cell = { kind: 'present'; value: string } | { kind: 'absent' } | { kind: 'malformed'; raw: string };

/** 칸 하나를 있음/없음/형식 오류로 가른다. null·undefined·빈 문자열만 «없음»; 그 밖에 형식이 안 맞으면(비문자열 포함) 형식 오류. */
function classify(value: unknown, valid: RegExp): Cell {
  if (value === null || value === undefined) return { kind: 'absent' };
  if (typeof value === 'string' && value.trim() === '') return { kind: 'absent' };
  const text = typeof value === 'string' ? value.trim().toLowerCase() : `${typeof value}:${JSON.stringify(value) ?? String(value)}`;
  return typeof value === 'string' && valid.test(text) ? { kind: 'present', value: text } : { kind: 'malformed', raw: text.slice(0, 80) };
}

function last(entries: readonly RunLedgerEntry[], event: string, accept: (data: Record<string, unknown>) => boolean = () => true): Record<string, unknown> | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.event === event && entry.data && typeof entry.data === 'object' && accept(entry.data)) return entry.data;
  }
  return null;
}

export function evidenceFromRunLedger(entries: readonly RunLedgerEntry[]): CollectedPreflightEvidence {
  const notes: string[] = [];
  const malformed: string[] = [];
  let source: CollectedPreflightEvidence['source'];
  let image: CollectedPreflightEvidence['image'];
  const flag = (field: string, raw: string): string => {
    malformed.push(field);
    notes.push(`형식 오류(malformed): ${field}=${JSON.stringify(raw)} — 미관측이 아니라 값이 있으나 형식이 틀림(검사기는 FAIL)`);
    return raw;
  };

  const head = last(entries, 'pod-source-head-check');
  if (!head) notes.push('원장에 pod-source-head-check 없음 — 조건① 미수집(commit 핀 발사가 아니었거나 자식이 끝나기 전)');
  else {
    const pin = classify(head.pinned, HEX40);
    const received = classify(head.received, HEX40);
    if (pin.kind === 'absent') notes.push('pod-source-head-check 에 요청 pin(pinned) 없음 — 조건① 미수집');
    else {
      const requestedPin = pin.kind === 'present' ? pin.value : flag('source.requestedPin', pin.raw);
      const childHead = received.kind === 'present' ? received.value : received.kind === 'malformed' ? flag('source.childHead', received.raw) : null;
      if (received.kind === 'absent') notes.push('미관측: source.childHead — 자식이 ELANOUS_POD_SOURCE commit 줄을 내지 않았다(검사기는 UNMEASURED)');
      source = { requestedPin, childHead };
    }
  }

  // 최종(final) 관측을 우선하고, 없으면 마지막 스냅샷 — 스냅샷은 Pod 가 아직 살아 있을 때의 중간값이다.
  const digest = last(entries, 'pod-image-digest', (data) => data.final === true) ?? last(entries, 'pod-image-digest');
  if (!digest) notes.push('원장에 pod-image-digest 없음 — 조건② 미수집');
  else {
    const pin = classify(digest.digestPin, DIGEST);
    const observed = classify(digest.digest, DIGEST);
    if (pin.kind === 'absent') notes.push('pod-image-digest 에 요청 pin(digestPin) 없음(이미지 ref 에 @sha256 이 없고 명시 pin 도 없음) — 조건② 미수집');
    else {
      const expectedDigest = pin.kind === 'present' ? pin.value : flag('image.expectedDigest', pin.raw);
      // 생산자는 imageID 가 있는데 sha256:64hex 로 끝나지 않으면 digest=null + digestUnavailable='nonstandard-image-id' 로 적는다 — 이건 «미관측»이 아니라 형식 오류다.
      const nonstandard = observed.kind === 'absent' && digest.digestUnavailable === 'nonstandard-image-id' && typeof digest.imageID === 'string' && digest.imageID.trim() !== '';
      const observedDigest = observed.kind === 'present' ? observed.value
        : observed.kind === 'malformed' ? flag('image.observedDigest', observed.raw)
        : nonstandard ? flag('image.observedDigest', String(digest.imageID).slice(0, 80)) : null;
      if (observed.kind === 'absent' && !nonstandard) notes.push('미관측: image.observedDigest — Pod imageID 에서 digest 를 읽지 못했다(검사기는 UNMEASURED)');
      image = { expectedDigest, observedDigest };
      if (digest.final !== true) notes.push('pod-image-digest 는 최종 관측이 아니라 중간 스냅샷이다');
    }
  }
  return { ...(source ? { source } : {}), ...(image ? { image } : {}), malformed, notes };
}

/** 증거 파일에 이미 있는 값이 우선 — 수집값은 빈 칸에만 채운다(사람이 준 증거를 조용히 덮지 않는다). */
export function mergeCollectedEvidence(base: TaPreflightEvidence, collected: CollectedPreflightEvidence): TaPreflightEvidence {
  return {
    ...base,
    ...(collected.source ? { source: { ...collected.source, ...base.source } } : {}),
    ...(collected.image ? { image: { ...collected.image, ...base.image } } : {}),
  };
}
