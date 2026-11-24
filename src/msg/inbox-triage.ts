import type { MsgStore } from './msg-store.js';

/**
 * 우편함 분류(triage) — MAILBOX-HYGIENE-AUTO 칸.
 * 미읽음을 «방치(unsupervised)» 와 실제로 처리할 수 있는 범주로 나눠
 * 어떤 자리의 우편함이 왜 미읽음을 쌓아 두는지 원장 수준에서 드러낸다.
 * 분류 우선순위: superseded > expired > (고아 우편함이면 전부 unsupervised)
 * > kind 버킷(request/decision/alert/report/digest) > unsupervised.
 * V1 범위: 직접 수신자만 (ALL·group:* 제외).
 */

export interface TriageCounts {
  unsupervised: number;
  superseded: number;
  expired: number;
  request: number;
  decision: number;
  alert: number;
  report: number;
  digest: number;
  other: number;
}

export interface TriageRow {
  recipient: string;
  unread: number;
  orphan: boolean;
  counts: TriageCounts;
}

export interface TriageTotals {
  recipients: number;
  unread: number;
}

export interface UnreadRow {
  id: number;
  recipient: string;
  sender: string;
  kind: string | null;
  expires_at: string | null;
  supersedes: number | null;
}

const KIND_BUCKETS = ['request', 'decision', 'alert', 'report', 'digest'] as const;

function emptyCounts(): TriageCounts {
  return { unsupervised: 0, superseded: 0, expired: 0, request: 0, decision: 0, alert: 0, report: 0, digest: 0, other: 0 };
}

export function triageTotals(rows: TriageRow[]): TriageTotals {
  return {
    recipients: rows.length,
    unread: rows.reduce((sum, row) => sum + row.unread, 0),
  };
}

export interface TriageOptions {
  now: Date;
  withTotals?: boolean;
}

export function triageMailbox(
  store: MsgStore,
  options: TriageOptions & { withTotals: true },
): { rows: TriageRow[]; totals: TriageTotals };
export function triageMailbox(store: MsgStore, options: TriageOptions): TriageRow[];
export function triageMailbox(
  store: MsgStore,
  options: TriageOptions,
): TriageRow[] | { rows: TriageRow[]; totals: TriageTotals } {
  const rows = store.listUnreadRows();
  const supersededIds = new Set<number>();
  for (const row of rows) {
    if (row.supersedes != null) supersededIds.add(row.supersedes);
  }

  const byRecipient = new Map<string, { unread: number; counts: TriageCounts }>();
  for (const row of rows) {
    const recipient = row.recipient;
    if (recipient === 'ALL' || recipient.startsWith('group:')) continue;
    const orphan = !store.hasCursor(recipient);
    const entry = byRecipient.get(recipient) ?? { unread: 0, counts: emptyCounts() };
    entry.unread += 1;
    if (supersededIds.has(row.id)) {
      entry.counts.superseded += 1;
    } else if (row.expires_at != null && new Date(row.expires_at).getTime() <= options.now.getTime()) {
      entry.counts.expired += 1;
    } else if (orphan) {
      entry.counts.unsupervised += 1;
    } else {
      const kind = row.kind ?? '';
      if ((KIND_BUCKETS as readonly string[]).includes(kind)) {
        entry.counts[kind as (typeof KIND_BUCKETS)[number]] += 1;
      } else {
        entry.counts.unsupervised += 1;
      }
    }
    byRecipient.set(recipient, entry);
  }

  const triage: TriageRow[] = [];
  for (const [recipient, entry] of [...byRecipient.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    triage.push({ recipient, unread: entry.unread, orphan: !store.hasCursor(recipient), counts: entry.counts });
  }

  if (options.withTotals) {
    return { rows: triage, totals: triageTotals(triage) };
  }
  return triage;
}
