#!/usr/bin/env bun
// ── elanous.ai 출시 알림 명단 — 하루 한 번 텔레그램 정리 (대표 2026-09-28) ─────────────────
//
// 명단 원천 = Resend 오디언스(사이트 `api/confirm.js` 가 «확인 링크를 누른» 주소만 올린다 · 더블 옵트인).
// 자격 = Elanous 비밀 저장소 `resend-api-key` · `resend-audience-id`(값을 출력·로그하지 않는다).
// 상태 = `<state>/conatus/waitlist_digest_state.json` — 지난 보고 때 본 연락처 id 목록(«새로 온 사람»을 가른다).
//
// 보고: 전체 명단 수 · 어제 보고 뒤 새로 확인된 주소(목록) · 구독 해지 수. 새 사람이 없어도 하루 한 번 수는 보낸다.
// ⛔ 조회 실패도 알린다(«못 쟀다»를 조용히 넘기지 않는다).
//
// cron: 0 9 * * *  (KST 09:00 · `scripts/cron-run.ts` 로 감싼다)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WaitlistContact { id: string; email: string; created_at?: string; unsubscribed?: boolean }

export interface DigestDeps {
  fetchContacts: () => Promise<WaitlistContact[]>;
  readState: () => { seen: string[]; lastAt?: string } | null;
  writeState: (s: { seen: string[]; lastAt: string }) => void;
  send: (text: string) => boolean;
  now?: () => Date;
}

export function formatDigest(contacts: readonly WaitlistContact[], seen: ReadonlySet<string>, firstRun: boolean): string {
  const active = contacts.filter((c) => !c.unsubscribed);
  const unsub = contacts.length - active.length;
  const fresh = firstRun ? [] : active.filter((c) => !seen.has(c.id))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  const lines = [
    `📮 **elanous.ai 출시 알림 명단** — 전체 **${active.length}**명${unsub ? ` · 해지 ${unsub}` : ''}`,
  ];
  if (firstRun) lines.push('(첫 보고 — 지금까지의 명단을 기준으로 삼습니다. 내일부터 새로 온 분을 따로 보여 드립니다.)');
  else if (fresh.length === 0) lines.push('어제 보고 뒤 새로 확인된 분: 없음');
  else {
    lines.push(`어제 보고 뒤 새로 확인된 분: **${fresh.length}**명`);
    for (const c of fresh.slice(0, 30)) lines.push(`  • ${c.email}${c.created_at ? ` · ${kst(c.created_at)}` : ''}`);
    if (fresh.length > 30) lines.push(`  … 외 ${fresh.length - 30}명`);
  }
  return lines.join('\n');
}

function kst(iso: string): string {
  const d = new Date(iso.replace(' ', 'T').replace(/(\+00)?$/, iso.includes('+') || iso.endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ') + ' KST';
}

export async function runWaitlistDigest(deps: DigestDeps): Promise<{ sent: boolean; total: number; fresh: number }> {
  const now = (deps.now ?? (() => new Date()))();
  let contacts: WaitlistContact[];
  try {
    contacts = await deps.fetchContacts();
  } catch (err) {
    const reason = err instanceof Error ? err.message.replace(/re_[A-Za-z0-9_]+/g, '***').slice(0, 160) : String(err).slice(0, 160);
    deps.send(`⚠️ **elanous.ai 출시 알림 명단 조회 실패** — 오늘 정리를 못 보냅니다.\n사유: \`${reason}\``);
    return { sent: false, total: 0, fresh: 0 };
  }
  const prev = deps.readState();
  const seen = new Set(prev?.seen ?? []);
  const text = formatDigest(contacts, seen, prev === null);
  const freshCount = prev === null ? 0 : contacts.filter((c) => !c.unsubscribed && !seen.has(c.id)).length;
  const sent = deps.send(text);
  // 발송이 실패하면 상태를 전진시키지 않는다 — 다음 번에 같은 «새로 온 분»을 다시 보낸다.
  if (sent) deps.writeState({ seen: contacts.map((c) => c.id), lastAt: now.toISOString() });
  return { sent, total: contacts.filter((c) => !c.unsubscribed).length, fresh: freshCount };
}

async function resendContacts(apiKey: string, audienceId: string): Promise<WaitlistContact[]> {
  const res = await fetch(`https://api.resend.com/audiences/${encodeURIComponent(audienceId)}/contacts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
  const body = await res.json() as { data?: WaitlistContact[] };
  return Array.isArray(body.data) ? body.data : [];
}

export async function main(): Promise<void> {
  const { ensureCronNodePath } = await import('../src/domains/cron-path.js');
  ensureCronNodePath();
  const { registerStandaloneLogSink } = await import('../src/domains/standalone-log-sink.js');
  try { await registerStandaloneLogSink('waitlist-daily-digest'); } catch { /* 관측 실패가 보고를 막지 않는다 */ }
  const { getSecret } = await import('../src/nexus/config/secrets/index.js');
  const { sendOutbound } = await import('../src/domains/outbound-alert.js');
  const { elanousStateRoot } = await import('../src/autopilot/state-paths.js');
  const { debug } = await import('../src/debug/log.js');
  const statePath = join(elanousStateRoot(), 'conatus', 'waitlist_digest_state.json');
  const apiKey = getSecret('resend-api-key');
  const audienceId = getSecret('resend-audience-id');
  const result = await runWaitlistDigest({
    fetchContacts: () => {
      if (!apiKey || !audienceId) return Promise.reject(new Error('비밀 저장소에 resend-api-key · resend-audience-id 가 없다'));
      return resendContacts(apiKey, audienceId);
    },
    readState: () => {
      if (!existsSync(statePath)) return null;
      try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
    },
    writeState: (s) => { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(s)); },
    send: (text) => sendOutbound(text, 'report'),
  });
  debug.log('waitlist.digest', 'reported', result);
  console.log(`[waitlist-daily-digest] sent=${result.sent} total=${result.total} fresh=${result.fresh}`);
}

if (import.meta.main) await main();
