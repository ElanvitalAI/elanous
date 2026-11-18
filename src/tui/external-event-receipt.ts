/**
 * ELN-EXTERNAL-EVENTS-BETWEEN-TURNS — the idle poll bound and the
 * zero-miss receipt. A poll that takes the event inside the bound is
 * on time. A later poll, or a ledger miss, is not a zero-miss receipt.
 */

import type { ExternalEventLedger, ExternalEventMissReport } from './external-event-ledger.js';
import { DEFAULT_SEAT_MAIL_POLL_MS } from './seat-mail-arrival.js';

/**
 * 판정 상한 = 폴링 주기 + 여유.
 * 주기의 정본은 seat-mail-arrival 의 DEFAULT_SEAT_MAIL_POLL_MS(15초) 하나다.
 * 여유는 그 주기의 삼분의 일(5초)이라 숫자 정본이 둘로 갈라지지 않는다.
 * 한 폴링이 주기 끝에 걸려도 다음 폴링이 받기 전이면 온시간이다.
 * 15초 정각은 주기 안이고, 상한(20초)을 넘기면 늦다.
 */
export const EXTERNAL_EVENT_POLL_SLACK_MS = DEFAULT_SEAT_MAIL_POLL_MS / 3;
export const EXTERNAL_EVENT_POLL_BOUND_MS = DEFAULT_SEAT_MAIL_POLL_MS + EXTERNAL_EVENT_POLL_SLACK_MS;

export interface ExternalEventLatency {
  id: string;
  /**
   * Milliseconds from the event existing to the poll that received it.
   * Null when the producer did not say when the event existed.
   */
  waitMs: number | null;
  /** False when the wait is unknown. Unknown is not on time. */
  withinBound: boolean;
}

export interface ExternalEventZeroMissReceipt {
  /**
   * True only when every ledger row is in the sample, every sample id is a
   * ledger row, every wait uses that row's receivedAt, and the turn-end tally
   * is empty.
   */
  ok: boolean;
  boundMs: number;
  latencies: readonly ExternalEventLatency[];
  late: readonly ExternalEventLatency[];
  /** Ledger row ids with no sample. These are misses even if the caller omitted them. */
  missingIds: readonly string[];
  /** Sample ids that are not ledger rows. A caller cannot invent a received event. */
  unknownIds: readonly string[];
  missed: ExternalEventMissReport;
}

export function externalEventLatency(input: {
  id: string;
  /** Absent means the producer does not know when the event existed. */
  occurredAt?: number;
  receivedAt: number;
  boundMs?: number;
}): ExternalEventLatency {
  const boundMs = input.boundMs ?? EXTERNAL_EVENT_POLL_BOUND_MS;
  if (input.occurredAt === undefined) return { id: input.id, waitMs: null, withinBound: false };
  const waitMs = input.receivedAt - input.occurredAt;
  return { id: input.id, waitMs, withinBound: waitMs >= 0 && waitMs <= boundMs };
}

/**
 * Delay from the ledger row, not from a caller-supplied receivedAt.
 * A row the ledger never received has no latency.
 */
export function externalEventLatencyFromLedger(
  ledger: ExternalEventLedger,
  input: { id: string; occurredAt?: number; boundMs?: number },
): ExternalEventLatency | null {
  const row = ledger.rows().find((item) => item.id === input.id);
  if (!row) return null;
  return externalEventLatency({
    id: row.id,
    occurredAt: input.occurredAt,
    receivedAt: row.receivedAt,
    boundMs: input.boundMs,
  });
}

/**
 * The number a seat can post. Wait is the ledger row's receivedAt minus
 * occurredAt. A ledger row absent from the sample is a miss, and a sample id
 * absent from the ledger is not a received event.
 */
export function externalEventZeroMissReceipt(input: {
  ledger: ExternalEventLedger;
  samples: readonly { id: string; occurredAt?: number }[];
  inFlightIds?: readonly string[];
  boundMs?: number;
}): ExternalEventZeroMissReceipt {
  const boundMs = input.boundMs ?? EXTERNAL_EVENT_POLL_BOUND_MS;
  const rows = input.ledger.rows();
  const rowIds = new Set(rows.map((row) => row.id));
  const sampleIds = new Set(input.samples.map((sample) => sample.id));
  const missingIds = rows.filter((row) => !sampleIds.has(row.id)).map((row) => row.id);
  const unknownIds = [...sampleIds].filter((id) => !rowIds.has(id));
  const latencies = input.samples.flatMap((sample) => {
    const latency = externalEventLatencyFromLedger(input.ledger, { ...sample, boundMs });
    return latency ? [latency] : [];
  });
  const late = latencies.filter((row) => !row.withinBound || row.waitMs === null || row.waitMs > boundMs);
  const missed = input.ledger.missed(input.inFlightIds);
  return {
    ok: late.length === 0
      && missingIds.length === 0
      && unknownIds.length === 0
      && missed.count === 0
      && latencies.length > 0,
    boundMs,
    latencies,
    late,
    missingIds,
    unknownIds,
    missed,
  };
}
