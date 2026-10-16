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
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const BOT = '8799226199:AAE9zA3sqjmurLLFwATRQ-LOEyp4Av1LaYw';
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
