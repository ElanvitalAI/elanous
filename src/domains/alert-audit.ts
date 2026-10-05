// 대표에게 가는 알림·브리핑 전수 재고 (ALERT-AUDIT).
//
// «전달 ok» 는 발송 시도 기록이다. 도착은 배송 원장의 채널 ok 한 건뿐이다.
// 발송 설정이 꺼져 있으면 시도 기록만 남고 도착은 0건이 된다 — 그 칸을
// claimed-without-arrival 로 표시한다. 같은 내용이 둘 이상의 채널·봇에
// 도착하면 overlap, 레지스트리에 있는데 아무도 안 보내면 gap.

import type { ScheduleRow } from './schedule-registry.js';
import type { DeliveryRow } from '../nexus/outbound/delivery-ledger.js';

export type AlertSenderKind = 'loop' | 'cron' | 'script';
export type AlertMark = 'claimed-without-arrival' | 'overlap' | 'gap' | 'overlap-unknown' | 'none';

export interface AlertSenderRef {
  kind: AlertSenderKind;
  id: string;
}

export interface AlertRegistrySender {
  kind: AlertSenderKind;
  id: string;
  /** 대표에게 보내는 알림·브리핑이면 true. false 는 대조 모집단에서 빠진다. */
  representative: boolean;
  what: string;
  when: string;
  channel: string;
  bot: string;
  /** 같은 내용으로 겹치는지 가르는 키. 비면 겹침은 미상이다. */
  contentKey?: string;
}

export interface AlertClaim {
  sender: AlertSenderRef;
  what: string;
  when: string;
  channel: string;
  bot: string;
  contentKey?: string;
  /** «전달 ok» 류의 발송 기록. 도착 증거가 아니다. */
  recordedOk: boolean;
  /** 발송 기록 시각. 도착이 없을 때 표의 «언제»는 이 시각이다. */
  at?: string;
}

export interface AlertArrival {
  sender: AlertSenderRef;
  what: string;
  channel: string;
  bot: string;
  contentKey?: string;
  /** 채널이 실제로 받았다고 원장에 남은 시각. */
  arrivedAt: string;
  ok: boolean;
}

export interface AlertAuditInput {
  registry: readonly AlertRegistrySender[];
  /** 크론 레지스트리. representative 크론 발신자가 여기 없으면 누락이다. */
  crons: readonly Pick<ScheduleRow, 'id' | 'name' | 'cron' | 'command' | 'enabled'>[];
  /** 루프 레지스트리 id. representative 루프 발신자가 여기 없으면 누락이다. */
  loops: readonly { id: string }[];
  claims: readonly AlertClaim[];
  arrivals: readonly AlertArrival[];
}

export interface AlertAuditRow {
  who: string;
  senderKind: AlertSenderKind;
  senderId: string;
  what: string;
  when: string;
  channel: string;
  bot: string;
  lastArrivedAt: string | null;
  marks: AlertMark[];
}

export interface AlertAudit {
  rows: AlertAuditRow[];
  /** 레지스트리 representative 발신자 중 크론·루프 대조에서 빠진 수. 스크립트는 대조 대상이 아니다. */
  missingFromRegistry: number;
  missingSenders: AlertSenderRef[];
  claimedWithoutArrival: AlertAuditRow[];
  overlaps: AlertAuditRow[];
  gaps: AlertAuditRow[];
  /** contentKey 를 모르는 도착이 있어 겹침을 판정하지 못한 행. */
  overlapUnknown: AlertAuditRow[];
  verdict: 'pass' | 'fail';
}

export interface DeliveryArrivalView {
  sender: AlertSenderRef;
  what: string;
  channel: string;
  bot: string;
  contentKey?: string;
}

const MARK_ORDER: AlertMark[] = ['claimed-without-arrival', 'overlap', 'gap', 'overlap-unknown'];

function senderKey(sender: AlertSenderRef): string {
  return `${sender.kind}:${sender.id}`;
}

/** 세 표시(+미상)를 MARK_ORDER 순으로 남긴다. none 은 표시가 없을 때만. */
export function markOrder(marks: readonly AlertMark[]): AlertMark[] {
  const ordered = MARK_ORDER.filter(mark => marks.includes(mark));
  return ordered.length ? ordered : ['none'];
}

function knownContentKey(item: { contentKey?: string }): string | null {
  const key = item.contentKey?.trim();
  return key ? key : null;
}

function latestIso(values: readonly string[]): string | null {
  const finite = values.filter(value => Number.isFinite(Date.parse(value)));
  if (!finite.length) return null;
  return finite.reduce((best, value) => Date.parse(value) > Date.parse(best) ? value : best);
}

function marksOf(row: { claimedWithoutArrival: boolean; overlap: boolean; gap: boolean; overlapUnknown: boolean }): AlertMark[] {
  return markOrder([
    ...(row.claimedWithoutArrival ? ['claimed-without-arrival' as const] : []),
    ...(row.overlap ? ['overlap' as const] : []),
    ...(row.gap ? ['gap' as const] : []),
    ...(row.overlapUnknown ? ['overlap-unknown' as const] : []),
  ]);
}

/** 배송 원장에서 ok 채널만 도착으로 읽는다. 실패 채널·빈 채널은 도착이 아니다. */
export function arrivalsFromDeliveries(
  rows: readonly DeliveryRow[],
  view: (row: DeliveryRow) => DeliveryArrivalView | null,
): AlertArrival[] {
  const arrivals: AlertArrival[] = [];
  for (const row of rows) {
    let channels: Array<{ type?: unknown; ok?: unknown; bot?: unknown }> = [];
    try { channels = JSON.parse(row.channels) as typeof channels; } catch { channels = []; }
    const mapped = view(row);
    if (!mapped) continue;
    const okChannels = channels.filter(channel => channel.ok === true);
    if (!okChannels.length) continue;
    const bots = [...new Set(okChannels.map(channel => typeof channel.bot === 'string' && channel.bot ? channel.bot : mapped.bot))];
    for (const bot of bots) {
      arrivals.push({
        sender: mapped.sender,
        what: mapped.what,
        channel: mapped.channel,
        bot,
        ...(mapped.contentKey ? { contentKey: mapped.contentKey } : {}),
        arrivedAt: row.ts,
        ok: true,
      });
    }
  }
  return arrivals;
}

/** 발신자 전수를 한 장으로 접는다. 판정은 누락 0 이고, 세 표시는 행에 남는다. */
export function auditAlerts(input: AlertAuditInput): AlertAudit {
  const cronIds = new Set(input.crons.map(row => row.id));
  const loopIds = new Set(input.loops.map(row => row.id));
  const representative = input.registry.filter(sender => sender.representative);
  const missingSenders = representative.filter(sender => {
    if (sender.kind === 'cron') return !cronIds.has(sender.id);
    if (sender.kind === 'loop') return !loopIds.has(sender.id);
    return false;
  }).map(sender => ({ kind: sender.kind, id: sender.id }));

  const arrivalsBySender = new Map<string, AlertArrival[]>();
  for (const arrival of input.arrivals) {
    if (!arrival.ok) continue;
    const key = senderKey(arrival.sender);
    const list = arrivalsBySender.get(key) ?? [];
    list.push(arrival);
    arrivalsBySender.set(key, list);
  }
  const claimsBySender = new Map<string, AlertClaim[]>();
  for (const claim of input.claims) {
    const key = senderKey(claim.sender);
    const list = claimsBySender.get(key) ?? [];
    list.push(claim);
    claimsBySender.set(key, list);
  }

  const overlapKeys = new Set<string>();
  const byContent = new Map<string, Set<string>>();
  for (const arrival of input.arrivals) {
    if (!arrival.ok) continue;
    const key = knownContentKey(arrival);
    if (!key) continue;
    const routes = byContent.get(key) ?? new Set<string>();
    routes.add(`${arrival.channel}|${arrival.bot}`);
    byContent.set(key, routes);
    if (routes.size >= 2) overlapKeys.add(key);
  }

  const rows: AlertAuditRow[] = representative.map(sender => {
    const key = senderKey(sender);
    const arrivals = arrivalsBySender.get(key) ?? [];
    const claims = claimsBySender.get(key) ?? [];
    const recordedOk = claims.some(claim => claim.recordedOk);
    const claimedWithoutArrival = recordedOk && arrivals.length === 0;
    const gap = !recordedOk && arrivals.length === 0;
    const registryKey = knownContentKey(sender);
    const arrivalKeys = arrivals.map(arrival => arrival.contentKey !== undefined ? knownContentKey(arrival) : registryKey);
    const claimKeys = claims.map(claim => claim.contentKey !== undefined ? knownContentKey(claim) : registryKey);
    const overlap = arrivalKeys.some(contentKey => contentKey !== null && overlapKeys.has(contentKey));
    const overlapUnknown = !overlap && (
      arrivals.some((_, index) => arrivalKeys[index] === null)
      || (arrivals.length === 0 && claims.some((_, index) => claimKeys[index] === null && claims[index]?.recordedOk))
    );
    const last = latestIso(arrivals.map(arrival => arrival.arrivedAt));
    const recorded = claims.find(claim => claim.recordedOk) ?? claims[0];
    const channel = arrivals[0]?.channel ?? recorded?.channel ?? sender.channel;
    const bot = arrivals[0]?.bot ?? recorded?.bot ?? sender.bot;
    const what = arrivals[0]?.what ?? recorded?.what ?? sender.what;
    const when = last ?? recorded?.at ?? recorded?.when ?? sender.when;
    return {
      who: `${sender.kind}:${sender.id}`,
      senderKind: sender.kind,
      senderId: sender.id,
      what,
      when,
      channel,
      bot,
      lastArrivedAt: last,
      marks: marksOf({ claimedWithoutArrival, overlap, gap, overlapUnknown }),
    };
  }).sort((a, b) => a.who.localeCompare(b.who) || a.what.localeCompare(b.what));

  const claimedWithoutArrival = rows.filter(row => row.marks.includes('claimed-without-arrival'));
  const overlaps = rows.filter(row => row.marks.includes('overlap'));
  const gaps = rows.filter(row => row.marks.includes('gap'));
  const overlapUnknown = rows.filter(row => row.marks.includes('overlap-unknown'));
  return {
    rows,
    missingFromRegistry: missingSenders.length,
    missingSenders,
    claimedWithoutArrival,
    overlaps,
    gaps,
    overlapUnknown,
    verdict: missingSenders.length === 0 ? 'pass' : 'fail',
  };
}

/** 한 장의 표. 세 표시가 비면 «없음» 과 그 근거를 표 아래에 적는다. */
export function formatAlertAudit(audit: AlertAudit): string {
  const header = '| 누가 | 무엇을 | 언제 | 채널 | 봇 | 마지막 도착 | 표시 |';
  const rule = '| --- | --- | --- | --- | --- | --- | --- |';
  const body = audit.rows.map(row => {
    const marks = markOrder(row.marks).filter(mark => mark !== 'none').join(', ') || 'none';
    const arrived = row.lastArrivedAt ?? '없음';
    return `| ${row.who} | ${row.what} | ${row.when} | ${row.channel} | ${row.bot} | ${arrived} | ${marks} |`;
  });
  const lines = [header, rule, ...body, '', `대조 누락: ${audit.missingFromRegistry}`, `판정: ${audit.verdict}`];
  const note = (label: string, found: readonly AlertAuditRow[], emptyReason: string) => {
    if (found.length) lines.push(`${label}: ${found.map(row => row.who).join(', ')}`);
    else lines.push(`${label}: 없음 — ${emptyReason}`);
  };
  note('보낸다고 기록됐는데 도착 증거가 없는 것', audit.claimedWithoutArrival, 'recordedOk 인 발신자마다 도착이 있다');
  if (audit.overlapUnknown.length) {
    lines.push(`겹치는 것: 미상 — contentKey 를 모르는 도착이 있어 겹침을 판정하지 않음 (${audit.overlapUnknown.map(row => row.who).join(', ')})`);
  } else {
    note('겹치는 것', audit.overlaps, '같은 contentKey 가 둘 이상의 채널·봇에 도착한 적이 없다');
  }
  note('아무도 안 보내는 것', audit.gaps, 'representative 발신자는 모두 발송 기록이 있거나 도착이 있다');
  return `${lines.join('\n')}\n`;
}
