// ── 결함 주입 심 — «자격 만료» (grok 구독) ──────────────────────────────────
//
// 🚨 왜 이것이 있나 (SIM-VERIFY-KIT 둘째 심 · 2026-10-12)
//   «만료가 가까운 grok 구독으로 Pod 를 띄움» 은 운영에서 그 시각이 오기를 기다려야 났다
//   (10-12 node-b · 만료 32분 전 발사 → 헛발사 · AUT-GROK-CRED-EXPIRY-NO-LAUNCH #26465).
//   이 심은 임시 HOME 에 만료 시각만 정한 자격 파일을 두고 «시계»와 «호스트 갱신 결과»만 바꿔 그 순간을 일으킨다.
//
// ⛔ 흉내 내지 않는다: 디스패처가 보는 grokLaunchReadiness 와 Pod 발사 계획이 보는 podGrokSubscriptionUsable 을
//    그대로 부른다. 바꾸는 것은 자격 파일 위치(임시 HOME) · 시계(now) · 갱신 결과(refresh) 뿐이다 — CLI·네트워크 없음.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrokRefreshOutcome } from '../grok/credential.js';
import { POD_GROK_MIN_VALIDITY_MS, grokLaunchReadiness, podGrokSubscriptionUsable, podGrokSkippedLine } from '../task-orchestrator/surfaces/self-implement-pod.js';

export interface CredExpiryScenario {
  /** 발사 시각 기준 만료까지 남은 시간(ms) — 음수면 이미 만료. */
  readonly expiresInMs: number;
  /** 호스트 갱신(`grok models`) 결과 — 'refreshed' 면 만료를 extendToMs 만큼 늘린다. */
  readonly refresh: GrokRefreshOutcome | 'threw';
  /** 'refreshed' 일 때 새 만료까지 남은 시간(ms). */
  readonly extendToMs?: number;
}

export interface CredExpiryObservation {
  readonly scenario: CredExpiryScenario;
  /** 디스패처 읽기 전용 판정(갱신 없음). */
  readonly readiness: ReturnType<typeof grokLaunchReadiness>;
  /** 발사 계획 판정(갱신 한 번 시도 뒤). */
  readonly usable: ReturnType<typeof podGrokSubscriptionUsable>;
  /** 발사 화면에 나갈 한 줄(빠졌을 때만). */
  readonly launchLine: string | null;
  /** 판정이 남긴 관측 줄. */
  readonly logs: ReadonlyArray<{ category: string; event: string; data: Record<string, unknown> }>;
}

/** 'refreshed' 에서 extendToMs 를 안 주면 쓰는 새 만료까지의 시간(가정값 · 표에 «→12h00m» 으로 보인다). */
export const DEFAULT_EXTEND_MS = 12 * 3600_000;

function writeAuth(home: string, expiresAtMs: number): void {
  mkdirSync(join(home, '.grok'), { recursive: true });
  writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::client': { key: 'sim-access', expires_at: new Date(expiresAtMs).toISOString(), refresh_token: 'sim-refresh' },
  }));
}

/** 한 시나리오를 임시 HOME 에서 돌리고 지운다. */
export function simCredExpiry(scenario: CredExpiryScenario): CredExpiryObservation {
  const home = mkdtempSync(join(tmpdir(), 'ux-sim-cred-expiry-'));
  try {
    const now = Date.now();
    writeAuth(home, now + scenario.expiresInMs);
    const readiness = grokLaunchReadiness({ home, env: {} as NodeJS.ProcessEnv });
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const usable = podGrokSubscriptionUsable({
      home, env: {} as NodeJS.ProcessEnv,
      refresh: () => {
        if (scenario.refresh === 'threw') throw new Error('sim: grok CLI threw');
        if (scenario.refresh === 'refreshed') writeAuth(home, Date.now() + (scenario.extendToMs ?? DEFAULT_EXTEND_MS));
        return scenario.refresh;
      },
      log: (category, event, data) => { logs.push({ category, event, data }); },
    });
    return { scenario, readiness, usable, launchLine: usable.usable ? null : podGrokSkippedLine(usable), logs };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** 기본 훑기 — 10-12 node-b 사건(만료 32분 전)을 갱신 결과 넷으로, 그리고 경계(최소 유효 시간 앞뒤)를. */
export function credExpirySweep(): CredExpiryObservation[] {
  const min = 60_000;
  return [
    simCredExpiry({ expiresInMs: 12 * 3600_000, refresh: 'unchanged' }),
    simCredExpiry({ expiresInMs: POD_GROK_MIN_VALIDITY_MS + 5 * min, refresh: 'unchanged' }),
    simCredExpiry({ expiresInMs: POD_GROK_MIN_VALIDITY_MS - 5 * min, refresh: 'unchanged' }),
    simCredExpiry({ expiresInMs: 32 * min, refresh: 'unchanged' }),
    simCredExpiry({ expiresInMs: 32 * min, refresh: 'refreshed' }),
    simCredExpiry({ expiresInMs: 32 * min, refresh: 'refreshed', extendToMs: 60 * min }),
    simCredExpiry({ expiresInMs: 32 * min, refresh: 'failed' }),
    simCredExpiry({ expiresInMs: 32 * min, refresh: 'threw' }),
    simCredExpiry({ expiresInMs: -10 * min, refresh: 'no-credential' }),
  ];
}

/** CLI 한 화면 — 시나리오마다 한 줄. */
export function renderCredExpiry(rows: readonly CredExpiryObservation[]): string[] {
  const hm = (ms: number) => `${Math.floor(ms / 3600_000)}h${String(Math.floor((ms % 3600_000) / 60_000)).padStart(2, '0')}m`;
  const fmt = (ms: number) => (ms < 0 ? `만료+${hm(-ms)}` : hm(ms));
  return [
    `cred-expiry · grok 구독 · 최소 유효 ${fmt(POD_GROK_MIN_VALIDITY_MS)}`,
    ...rows.map((r) => {
      const ready = r.readiness.ready ? 'ready' : `not-ready(${r.readiness.reason})`;
      const use = r.usable.usable ? 'usable' : `dropped(${r.usable.reason})`;
      const ext = r.scenario.refresh === 'refreshed' ? `(→${fmt(r.scenario.extendToMs ?? DEFAULT_EXTEND_MS)})` : '';
      return `  만료까지 ${fmt(r.scenario.expiresInMs).padStart(9)} · 갱신 ${(r.scenario.refresh + ext).padEnd(18)} → 디스패처 ${ready.padEnd(20)} · 발사 ${use}`;
    }),
  ];
}
