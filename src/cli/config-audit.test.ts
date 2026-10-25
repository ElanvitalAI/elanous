/**
 * CFG-STORE2 — config 감사 이력 첫 칸 계약 (0.2.29 · 2026-10-14).
 *
 * 전부 temp 픽스처 뿌리 — 실 ~/.elanous 미접촉. 핵심 계약:
 *   1. 판정 신호: 바꾼 키·이전 값·다음 값·by 가 «한 행»으로 남는다(src/index.ts config set/unset 호출부가 쓴다)
 *   2. 비밀 키 값은 '<masked>' 로 적힌다 — 저장 파일 어디에도 원문이 없다(경로 마디 ⊕ 값 모양 ⊕ 객체 속 키)
 *   3. unset 은 next=NULL 로 남는다 · 이력은 그 키만 · 여러 행은 시간 오름차순
 *   4. by 해석 — 명시 by > ELANOUS_TRACK > 런 id 환경 변수 > 'cli'
 *   5. 읽기는 없는 db 파일을 만들지 않는다
 */
import { afterEach, describe, expect, it, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliConfigAuditDevice } from '../ux-sim/cli-config-audit-device.js';
import { MASK, readConfigHistory, recordConfigChange } from './config-audit.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cfg-audit-'));
  roots.push(root);
  return { root, dbPath: join(root, 'config-changes.db') };
}

/** ELANOUS_TRACK 을 잠시 바꿔 돌리고 원상 복구 — 앰비언트 자리 값과 무관하게 만든다. */
function withTrack<T>(value: string | undefined, fn: () => T): T {
  const oldTrack = process.env.ELANOUS_TRACK;
  if (value === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = value;
  try { return fn(); } finally { if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack; }
}

describe('config audit (CFG-STORE2)', () => {
  it('판정 신호 — 바꾼 키·이전 값·다음 값·by 가 한 행으로 남는다', () => {
    const f = fixture();
    const row = withTrack('UX', () => recordConfigChange({ key: 'harness.podPool', prev: 'pool-a@a:40', next: 'pool-b@b:25', why: 'config set' }, f.dbPath));
    expect(row.by).toBe('UX');
    const history = readConfigHistory('harness.podPool', f.dbPath);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      key: 'harness.podPool', prev: '"pool-a@a:40"', next: '"pool-b@b:25"', by: 'UX', why: 'config set',
    });
    expect(Number.isNaN(Date.parse(history[0]!.at))).toBe(false);
  });

  it('비밀 키 값은 <masked> 로 적힌다 — 저장 파일에 원문이 없다', () => {
    const f = fixture();
    const SECRET_PREV = 'sk-prev-AAAAAAAAAAAAAAAAAAAA';
    const SECRET_NEXT = 'sk-next-BBBBBBBBBBBBBBBBBBBB';
    const HOOK = 'https://discord.com/api/webhooks/123456/abcDEFsecretPart';
    recordConfigChange({ key: 'llm.apiKey', prev: SECRET_PREV, next: SECRET_NEXT, by: 'OP', why: 'config set' }, f.dbPath);
    recordConfigChange({ key: 'notify.url', prev: HOOK, next: 'https://example.com/x', by: 'OP', why: 'config set' }, f.dbPath);
    const apiKey = readConfigHistory('llm.apiKey', f.dbPath);
    expect(apiKey).toHaveLength(1);
    expect(apiKey[0]!.prev).toBe(MASK);
    expect(apiKey[0]!.next).toBe(MASK);
    const notify = readConfigHistory('notify.url', f.dbPath);
    expect(notify[0]!.prev).toBe(MASK);
    expect(notify[0]!.next).toBe('"https://example.com/x"');
    const raw = readFileSync(f.dbPath, 'utf-8');
    for (const secret of [SECRET_PREV, SECRET_NEXT, HOOK, 'abcDEFsecretPart']) expect(raw).not.toContain(secret);
  });

  it('객체 속 비밀 키(botToken)도 가린다 — maskDeep 재사용', () => {
    const f = fixture();
    const BOT = '123456:TEST_FAKE_TOKEN';
    const masked = '[{"name":"main","botToken":"<masked>"}]';
    const row = recordConfigChange({ key: 'notify.routes', prev: [], next: [{ name: 'main', botToken: BOT }], by: 'TC' }, f.dbPath);
    expect(row.next).toBe(masked);
    expect(readConfigHistory('notify.routes', f.dbPath)[0]!.next).toBe(masked);
    expect(readFileSync(f.dbPath, 'utf-8')).not.toContain(BOT);
  });

  it('unset — next=NULL 로 남는다 · 이력은 그 키만 · 여러 행은 시간 오름차순', () => {
    const f = fixture();
    recordConfigChange({ key: 'llm.codexQuotaPolicy', prev: 'credits', next: 'rate', by: 'TC', why: 'config set' }, f.dbPath);
    recordConfigChange({ key: 'llm.codexQuotaPolicy', prev: 'rate', by: 'TC', why: 'config unset' }, f.dbPath);
    recordConfigChange({ key: 'harness.repo', prev: 'a/b', next: 'c/d', by: 'TC' }, f.dbPath);
    const history = readConfigHistory('llm.codexQuotaPolicy', f.dbPath);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ prev: '"credits"', next: '"rate"' });
    expect(history[1]).toMatchObject({ prev: '"rate"', next: null, why: 'config unset' });
    expect(history.map((r) => r.next)).toEqual(['"rate"', null]);
    expect(readConfigHistory('harness.repo', f.dbPath)).toHaveLength(1);
  });

  it('by 해석 — 명시 by > ELANOUS_TRACK > 런 id 환경 변수 > cli', () => {
    const f = fixture();
    const names = ['ELANOUS_RUN_ID', 'HARNESS_RUN_ID', 'RUN_ID'] as const;
    const saved: Array<[string, string | undefined]> = names.map((n) => [n, process.env[n]]);
    for (const n of names) delete process.env[n];
    try {
      withTrack('MK', () => recordConfigChange({ key: 'llm.model', prev: 'a', next: 'b', by: 'OP' }, f.dbPath));
      expect(readConfigHistory('llm.model', f.dbPath).at(-1)!.by).toBe('OP');
      withTrack('MK', () => recordConfigChange({ key: 'llm.model', prev: 'b', next: 'c' }, f.dbPath));
      expect(readConfigHistory('llm.model', f.dbPath).at(-1)!.by).toBe('MK');
      process.env.ELANOUS_RUN_ID = 'run-a39c557e-4255-46fd-abb1-853dfe049178';
      withTrack(undefined, () => recordConfigChange({ key: 'llm.model', prev: 'c', next: 'd' }, f.dbPath));
      expect(readConfigHistory('llm.model', f.dbPath).at(-1)!.by).toBe('run-a39c557e-4255-46fd-abb1-853dfe049178');
      delete process.env.ELANOUS_RUN_ID;
      withTrack(undefined, () => recordConfigChange({ key: 'llm.model', prev: 'd', next: 'e' }, f.dbPath));
      expect(readConfigHistory('llm.model', f.dbPath).at(-1)!.by).toBe('cli');
    } finally {
      for (const [n, v] of saved) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    }
  });

  it('읽기는 없는 db 파일을 만들지 않는다', () => {
    const f = fixture();
    expect(readConfigHistory('llm.provider', f.dbPath)).toEqual([]);
    expect(existsSync(f.dbPath)).toBe(false);
  });

  it(':memory: 는 기록과 조회가 같은 연결을 써 한 행을 되읽는다', () => {
    const key = `test.memory.${crypto.randomUUID()}`;
    recordConfigChange({ key, prev: 'before', next: 'after', by: 'UX' }, ':memory:');
    expect(readConfigHistory(key, ':memory:')).toMatchObject([
      { key, prev: '"before"', next: '"after"', by: 'UX' },
    ]);
  });
});

// ── CFG-STORE2-HISTORY-REVERT · 실 CLI set/unset → history → revert 한 바퀴 ──────────────
// 무대: ux-sim config 감사 장치(src/ux-sim/cli-config-audit-device.ts) — 격리 config 뿌리 위에서
// 실 CLI(`src/index.ts` 의 config 명령 트리)를 그대로 부른다. 값·감사 행은 CLI 가 만든 것만 본다.
describe('CFG-STORE2-HISTORY-REVERT: 실 CLI set/unset→history→revert 한 바퀴', () => {
  test('되돌린 값이 이전 값과 일치하고 감사 행은 append 로만 늘어난다', async () => {
    const device = createCliConfigAuditDevice();
    try {
      expect((await device.set('llm.model', 'model-a')).exitCode).toBe(0);
      expect((await device.set('llm.model', 'model-b')).exitCode).toBe(0);
      expect(device.value('llm.model')).toBe('model-b');

      const history = await device.history('llm.model');
      expect(history.exitCode).toBe(0);
      expect(history.stdout).toContain('"model-a" → "model-b"');

      const before = device.ledger('llm.model');
      expect(before).toHaveLength(2);
      expect(before.at(-1)).toMatchObject({ prev: '"model-a"', next: '"model-b"' });

      const revert = await device.revert('llm.model');
      expect(revert.exitCode).toBe(0);
      expect(device.value('llm.model')).toBe('model-a');

      const after = device.ledger('llm.model');
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.at(-1)).toMatchObject({ prev: '"model-b"', next: '"model-a"', why: 'config revert' });

      const replayed = await device.history('llm.model');
      expect(replayed.stdout).toContain('"model-b" → "model-a"');
      expect(replayed.stdout).toContain('why=config revert');
    } finally {
      device.dispose();
    }
  }, 20_000);

  test('unset 을 되돌리면 지워졌던 값이 살아난다', async () => {
    const device = createCliConfigAuditDevice();
    try {
      expect((await device.set('ui.theme', 'dark')).exitCode).toBe(0);
      expect((await device.unset('ui.theme')).exitCode).toBe(0);
      expect(device.value('ui.theme')).toBeUndefined();

      expect((await device.revert('ui.theme')).exitCode).toBe(0);
      expect(device.value('ui.theme')).toBe('dark');
      expect(device.ledger('ui.theme').at(-1)).toMatchObject({ prev: null, next: '"dark"', why: 'config revert' });
    } finally {
      device.dispose();
    }
  }, 20_000);

  test('비밀 값은 set·history·revert 어디에도 원문으로 나오지 않는다', async () => {
    const device = createCliConfigAuditDevice();
    const first = 'sk-revert-secret-aaaaaaaa';
    const second = 'sk-revert-secret-bbbbbbbb';
    try {
      const setFirst = await device.set('llm.apiKey', first);
      expect(setFirst.exitCode).toBe(0);
      expect(setFirst.stdout).not.toContain(first);
      const setSecond = await device.set('llm.apiKey', second);
      expect(setSecond.exitCode).toBe(0);
      expect(setSecond.stdout).not.toContain(second);

      const history = await device.history('llm.apiKey');
      expect(history.exitCode).toBe(0);
      expect(history.stdout).toContain(MASK);
      expect(history.stdout).not.toContain(first);
      expect(history.stdout).not.toContain(second);

      // 이전 값이 가려져 있으면 원문을 모른다 — 가린 값을 되쓰지 않고 거부하고, 현재 값은 그대로 둔다.
      const revert = await device.revert('llm.apiKey');
      expect(revert.exitCode).toBe(1);
      const revertOutput = `${revert.stdout}${revert.stderr}`;
      expect(revertOutput).toContain(MASK);
      expect(revertOutput).not.toContain(first);
      expect(revertOutput).not.toContain(second);
      expect(device.value('llm.apiKey')).toBe(second);
      expect(device.ledger('llm.apiKey')).toHaveLength(2);
      expect(device.ledgerText()).not.toContain(first);
      expect(device.ledgerText()).not.toContain(second);
    } finally {
      device.dispose();
    }
  }, 20_000);

  test('배열·객체 «속» 에 중첩된 가림 자는 값으로 되쓰지 않고 거부한다(조용한 오염 금지)', async () => {
    const device = createCliConfigAuditDevice();
    const SECRET = ['sk-nested-fallback-AAAAAAAAAAAAAAAAAAAAAAAA', 'https://discord.com/api/webhooks/123456/abcDEFsecretPart'];
    try {
      // 최상위 값이 문자열이 아니라 «배열» — 원장에는 ["***MASK***", …] 처럼 속에 가림 자가 남는다.
      expect((await device.set('llm.fallbackChain', SECRET)).exitCode).toBe(0);
      expect((await device.set('llm.fallbackChain', ['openai'])).exitCode).toBe(0);
      expect(device.value('llm.fallbackChain')).toEqual(['openai']);

      const before = device.ledger('llm.fallbackChain');
      expect(before).toHaveLength(2);
      expect(before.at(-1)!.prev).toContain(MASK);
      expect(before.at(-1)!.prev).not.toBe(MASK); // 최상위 문자열 비교로는 안 걸리는 모양

      const revert = await device.revert('llm.fallbackChain');
      expect(revert.exitCode).toBe(1);
      const out = `${revert.stdout}${revert.stderr}`;
      expect(out).toContain(MASK);
      expect(out).toContain('원문 복원 불가');
      for (const secret of SECRET) expect(out).not.toContain(secret);

      // 값은 그대로 · 원장도 그대로(새 행 0) — MASK 리터럴이 실제 config 값이 되지 않았다.
      expect(device.value('llm.fallbackChain')).toEqual(['openai']);
      expect(JSON.stringify(device.value('llm'))).not.toContain(MASK);
      expect(device.ledger('llm.fallbackChain')).toEqual(before);
    } finally {
      device.dispose();
    }
  }, 20_000);

  test('이력 없는 키의 revert 는 실패하고 config 를 건드리지 않는다', async () => {
    const device = createCliConfigAuditDevice();
    try {
      expect((await device.set('ui.locale', 'ko')).exitCode).toBe(0);
      const revert = await device.revert('ui.colorMode');
      expect(revert.exitCode).toBe(1);
      expect(`${revert.stdout}${revert.stderr}`).toContain('감사 이력 없음');
      expect(device.value('ui.locale')).toBe('ko');
    } finally {
      device.dispose();
    }
  }, 20_000);

  test('llm 정책·계정 상한·폴백 체인·podPool·harness.authorOnPod 가 같은 원장 경로로 기록·복원된다', async () => {
    // 두 번째 칸이 undefined 면 «unset» — harness.authorOnPod 는 직렬화가 명시 true 만 켜므로
    // 끄는 조작이 곧 unset 이다(기존 user-config 계약 그대로).
    const domains: readonly (readonly [string, string, unknown, unknown, string])[] = [
      ['llm-policy', 'llm.missionRouting', 'auto', 'manual', 'llm'],
      ['account-limits', 'account.monthlyUsdCap', 20, 40, 'account'],
      ['fallback-chain', 'llm.fallbackChain', ['a'], ['b'], 'llm'],
      ['pod-pool', 'harness.podPool', 'pool-a', 'pool-b', 'harness'],
      ['author-on-pod', 'harness.authorOnPod', true, undefined, 'harness'],
    ];
    for (const [domain, key, first, second, root] of domains) {
      const device = createCliConfigAuditDevice();
      try {
        expect((await device.set(key, first)).exitCode).toBe(0);
        if (second === undefined) expect((await device.unset(key)).exitCode).toBe(0);
        else expect((await device.set(key, second)).exitCode).toBe(0);

        const history = await device.history(key);
        expect(history.exitCode).toBe(0);
        expect(history.stdout).toContain(`[${domain}]`);

        expect((await device.revert(key)).exitCode).toBe(0);
        expect(device.value(key)).toEqual(first);
        expect(device.value(root)).toBeDefined();
        const rows = device.ledger(key);
        expect(rows).toHaveLength(3);
        expect(rows.at(-1)).toMatchObject({ why: 'config revert', next: JSON.stringify(first) });
      } finally {
        device.dispose();
      }
    }
  }, 45_000);
});
