// TOKEN-BURN-BY-SEAT(0.3.33 P0 · OP #132084 배정) — llm.usage emit 에 자리(seat) 스탬프.
// 완료선(ROSTER-0333-RANKED #10): 자리·모델·시간별 토큰·비용 표(#39502 원장 기반) 30분 카드에.
// 실패 먼저(§35): 지금 logAgentTurnUsage 는 seat 을 안 싣는다 — 스탬프 없으면 이 시험은 RED.
// 출처: #39564/#132084 · ambientSeat 패턴 = src/els/control-cli.ts:60(ELANOUS_SEAT ?? SEAT env).
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { logAgentTurnUsage } from './llm.js';

// 새 export 는 네임스페이스 경유로만 참조한다(조상 base 에는 심볼이 없어 네임드 정적 import 면
// 모듈 로드 SyntaxError 로 죽는다 — llm-cost-ledger.test.ts 와 같은 관례).
import * as llmNs from './llm.js';

const fixtureUsage = { inputTokens: 10, outputTokens: 2 } as const;

function observeUsage(run: () => void): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    if (category === 'llm.usage') rows.push((data ?? {}) as Record<string, unknown>);
  });
  try { run(); } finally { log.mockRestore(); }
  return rows;
}

withEnv('emit stamps the ambient seat from ELANOUS_SEAT', { ELANOUS_SEAT: 'MOB-1' }, () => {
  const rows = observeUsage(() =>
    logAgentTurnUsage('fixture-model', { ...fixtureUsage }, { providerName: 'fixture-provider' }));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.seat).toBe('MOB-1');
});

withEnv('emit stamps the ambient seat from SEAT when ELANOUS_SEAT is absent', { SEAT: 'OP' }, () => {
  const rows = observeUsage(() =>
    logAgentTurnUsage('fixture-model', { ...fixtureUsage }, { providerName: 'fixture-provider' }));
  expect(rows[0]!.seat).toBe('OP');
});

withEnv('emit falls back to the /seats/<name> directory of cwd', { ELANOUS_SEAT: '', SEAT: '' }, () => {
  const prior = process.cwd();
  const fake = mkdtempSeats('MOB-9');
  process.chdir(fake);
  try {
    const rows = observeUsage(() =>
      logAgentTurnUsage('fixture-model', { ...fixtureUsage }, { providerName: 'fixture-provider' }));
    expect(rows[0]!.seat).toBe('MOB-9');
  } finally { process.chdir(prior); }
});

withEnv('emit omits seat when neither env nor a seats cwd exists — no fabricated label', { ELANOUS_SEAT: '', SEAT: '' }, () => {
  const prior = process.cwd();
  const plain = mkdtempPlain();
  process.chdir(plain);
  try {
    const rows = observeUsage(() =>
      logAgentTurnUsage('fixture-model', { ...fixtureUsage }, { providerName: 'fixture-provider' }));
    expect(rows[0]!.seat).toBeUndefined();
  } finally { process.chdir(prior); }
});

// ── helpers ──────────────────────────────────────────────────────────────────
type EnvPatch = Record<string, string>;

function withEnv(name: string, patch: EnvPatch, body: () => void): void {
  test(name, () => {
    const saved: Record<string, string | undefined> = {};
    const keys = Object.keys(patch);
    for (const k of keys) { saved[k] = process.env[k]; process.env[k] = patch[k]; }
    try { body(); } finally {
      for (const k of keys) {
        const v = saved[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
}

function mkdtempSeats(seat: string): string {
  // 외부 모듈 없이: tmp 디렉터리를 직접 만들어 /seats/<seat> 골격만 만든다.
  // 폴백은 «cwd 가 /seats/<이름> 안에 있다» 를 읽는다 — cwd 자체가 그 자리 디렉터리여야 한다.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'seat-stamp-'));
  const seatDir = join(root, 'seats', seat);
  mkdirSync(seatDir, { recursive: true });
  return seatDir;
}

function mkdtempPlain(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  return mkdtempSync(join(tmpdir(), 'seat-stamp-plain-'));
}

// (사용되지 않는 정적 참조 방지 — 네임스페이스 참조만 남긴다)
void llmNs;
