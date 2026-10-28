import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeReceiptKey,
  describeGateReceiptDecline,
  gateEnvFingerprint,
  gateLockfileHash,
  gateReceiptSelfKey,
  GATE_RECEIPT_SCHEMA,
  loadGateReceipts,
  saveGateReceipt,
  type GateReceipt,
  type GateReceiptIdentity,
} from './gate-receipt-registry.js';

const sha = (ch: string) => ch.repeat(40);
const headAt = (i: number) => 'a'.repeat(36) + i.toString(16).padStart(4, '0');

const identity = (over: Partial<GateReceiptIdentity> = {}): GateReceiptIdentity => ({
  headCommit: sha('a'),
  baseCommit: sha('c'),
  bunVersion: '1.2.19',
  lockfileHash: 'f'.repeat(64),
  radiusFiles: ['src/feature.test.ts'],
  checks: ['isolation-gate', 'nexus-build', 'test-interference:with-neighbours', 'typecheck@' + sha('b')],
  envFingerprint: 'e'.repeat(64),
  ...over,
});

const receipt = (over: { identity?: Partial<GateReceiptIdentity> } & Partial<Omit<GateReceipt, keyof GateReceiptIdentity>> = {}): GateReceipt => {
  const { identity: identityOver, ...rowOver } = over;
  const rowIdentity = identity(identityOver);
  const verdict = rowOver.verdict ?? 'passed';
  return {
    ...rowIdentity,
    schema: GATE_RECEIPT_SCHEMA,
    key: computeReceiptKey(rowIdentity, verdict),
    verdict,
    savedAt: '2026-10-27T23:27:00.000Z',
    ...rowOver,
  };
};

describe('computeReceiptKey — 한 측정·한 판정만 같은 key 를 받는다', () => {
  test('같은 입력·같은 판정은 같은 key, radius/checks 정렬 순서는 무관하다', () => {
    const straight = computeReceiptKey(identity(), 'passed');
    expect(computeReceiptKey(identity(), 'passed')).toBe(straight);
    expect(computeReceiptKey(identity({
      radiusFiles: ['src/z.test.ts', 'src/a.test.ts', 'src/z.test.ts'],
      checks: ['typecheck@' + sha('b'), 'isolation-gate'],
    }), 'passed')).toBe(computeReceiptKey(identity({
      radiusFiles: ['src/a.test.ts', 'src/z.test.ts'],
      checks: ['isolation-gate', 'typecheck@' + sha('b')],
    }), 'passed'));
    expect(computeReceiptKey(identity({ radiusFiles: ['src/only.test.ts'] }), 'passed')).not.toBe(straight);
  });

  test.each([
    ['headCommit', () => identity({ headCommit: sha('f') })],
    ['baseCommit', () => identity({ baseCommit: sha('e') })],
    ['bunVersion', () => identity({ bunVersion: '1.2.20' })],
    ['lockfileHash', () => identity({ lockfileHash: '0'.repeat(64) })],
    ['radiusFiles', () => identity({ radiusFiles: ['src/other.test.ts'] })],
    ['checks', () => identity({ checks: ['isolation-gate'] })],
    ['envFingerprint', () => identity({ envFingerprint: 'd'.repeat(64) })],
  ])('%s 가 하나라도 바뀌면 key 가 바뀐다', (_field, drifted) => {
    expect(computeReceiptKey(drifted(), 'passed')).not.toBe(computeReceiptKey(identity(), 'passed'));
  });

  test('판정이 다른 영수증은 같은 측정이어도 다른 key 를 받는다', () => {
    const probe = identity();
    expect(new Set(['passed', 'failed', 'unmeasured'].map((verdict) => computeReceiptKey(probe, verdict as GateReceipt['verdict']))).size).toBe(3);
  });

  test('40자 hex 가 아닌 head/base 로는 영수증을 만들 수 없다', () => {
    expect(() => computeReceiptKey(identity({ headCommit: 'abc' }), 'passed')).toThrow('40 hex');
    expect(() => computeReceiptKey(identity({ baseCommit: 'A'.repeat(41) }), 'passed')).toThrow('40 hex');
  });
});

describe('gateReceiptSelfKey — 원본 영수증 없이 통과 판정 금지', () => {
  test('온전한 행은 자기 key 로 다시 계산된다; 위조된 행은 어긋난다', () => {
    const coherent = receipt();
    expect(gateReceiptSelfKey(coherent)).toBe(coherent.key);
    const forged: GateReceipt = { ...coherent, radiusFiles: ['src/never-measured.test.ts'] };
    expect(gateReceiptSelfKey(forged)).not.toBe(forged.key);
  });
});

describe('loadGateReceipts — 결손·손상은 빈 등록부로 복구한다', () => {
  test('없는 파일·깨진 JSON·배열·빈 객체는 전부 빈 등록부다', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-receipt-load-'));
    try {
      expect(loadGateReceipts(join(root, 'absent.json'))).toEqual({});
      writeFileSync(join(root, 'torn.json'), '{"a": {"schema": 1, "ke');
      expect(loadGateReceipts(join(root, 'torn.json'))).toEqual({});
      writeFileSync(join(root, 'array.json'), '[]');
      expect(loadGateReceipts(join(root, 'array.json'))).toEqual({});
      writeFileSync(join(root, 'empty.json'), '{}');
      expect(loadGateReceipts(join(root, 'empty.json'))).toEqual({});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('모양이 어긋난 행과 맵 키와 어긋난 행은 버리고 온전한 행만 남긴다', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-receipt-rows-'));
    const path = join(root, 'gate-receipts.json');
    try {
      const good = receipt();
      const badVerdict = { ...receipt({ identity: { headCommit: sha('b') } }), verdict: 'unknown' as never };
      const badSchema = { ...receipt({ identity: { headCommit: sha('d') } }), schema: 2 };
      const filedKey = receipt({ identity: { headCommit: sha('e') } });
      writeFileSync(path, JSON.stringify({
        [good.key]: good,
        [badVerdict.key]: badVerdict,
        [badSchema.key]: badSchema,
        [filedKey.key]: { ...filedKey, key: 'f'.repeat(64) },
      }));
      expect(loadGateReceipts(path)).toEqual({ [good.key]: good });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('saveGateReceipt — 지속 등록부에 원자적으로 병합 기록한다', () => {
  test('key 가 필드와 맞지 않는 행은 쓰기 단계에서 거절한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-receipt-write-'));
    const path = join(root, 'gate-receipts.json');
    try {
      const coherent = receipt();
      const forged: GateReceipt = { ...coherent, key: computeReceiptKey(identity({ headCommit: sha('9') }), 'passed') };
      expect(() => saveGateReceipt(path, forged)).toThrow('does not match its own fields');
      expect(loadGateReceipts(path)).toEqual({});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('병합은 다른 key 를 지우지 않고, 없던 부모 디렉터리를 만들고, 다시 읽힌다', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-receipt-merge-'));
    const path = join(root, 'nested', 'dir', 'gate-receipts.json');
    try {
      const first = receipt();
      const second = receipt({ identity: { headCommit: sha('7') } });
      saveGateReceipt(path, first);
      saveGateReceipt(path, second);
      const registry = loadGateReceipts(path);
      expect(Object.keys(registry).sort()).toEqual([first.key, second.key].sort());
      expect(registry[first.key]).toEqual(first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('동시 쓰기·원자성: 병렬 저장 중에도 파일은 항상 온전한 JSON이고 모든 영수증이 남는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-receipt-atomic-'));
    const path = join(root, 'gate-receipts.json');
    try {
      const rows = Array.from({ length: 60 }, (_, i) => receipt({
        identity: { headCommit: headAt(i), radiusFiles: [`src/file-${i}.test.ts`] },
      }));
      let done = false;
      let torn = 0;
      const poller = (async () => {
        while (!done) {
          try { JSON.parse(readFileSync(path, 'utf8')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') torn += 1; }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })();
      await Promise.all(Array.from({ length: 6 }, (_, writer) => (async () => {
        for (let i = writer; i < rows.length; i += 6) {
          saveGateReceipt(path, rows[i]!);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })()));
      done = true;
      await poller;
      expect(torn).toBe(0);
      expect(Object.keys(loadGateReceipts(path)).sort()).toEqual(rows.map((row) => row.key).sort());
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('describeGateReceiptDecline — 거절 사유가 어긋난 축을 이름으로 댄다', () => {
  const probe = identity();
  test('빈 등록부', () => {
    expect(describeGateReceiptDecline(probe, {})).toBe('gate receipt registry empty');
  });
  test('같은 head/base 의 영수증이 없다(결손)', () => {
    const stored = receipt({ identity: { headCommit: sha('7') } });
    expect(describeGateReceiptDecline(probe, { [stored.key]: stored })).toContain(`no receipt for head ${sha('a').slice(0, 12)}`);
  });
  test('실패 판정의 영수증', () => {
    const failed = receipt({ verdict: 'failed' });
    expect(describeGateReceiptDecline(probe, { [failed.key]: failed })).toContain('verdict=failed');
  });
  test('측정불가 판정의 영수증', () => {
    const unmeasured = receipt({ verdict: 'unmeasured' });
    expect(describeGateReceiptDecline(probe, { [unmeasured.key]: unmeasured })).toContain('verdict=unmeasured');
  });
  test('환경 지문 불일치', () => {
    const stored = receipt({ identity: { envFingerprint: 'd'.repeat(64) } });
    expect(describeGateReceiptDecline(probe, { [stored.key]: stored })).toContain('env fingerprint differs');
  });
  test('Bun/lockfile 불일치', () => {
    const stored = receipt({ identity: { bunVersion: '9.9.9' } });
    expect(describeGateReceiptDecline(probe, { [stored.key]: stored })).toContain('bun/lockfile differs');
  });
  test('radius 파일 집합 불일치', () => {
    const stored = receipt({ identity: { radiusFiles: ['src/other.test.ts'] } });
    expect(describeGateReceiptDecline(probe, { [stored.key]: stored })).toContain('changed-file radius differs');
  });
  test('불완전 — 현재 측정 범위를 다 커버하지 못한다', () => {
    const partial = receipt({ identity: { checks: [...identity().checks].filter((check) => check !== 'nexus-build') } });
    expect(describeGateReceiptDecline(probe, { [partial.key]: partial })).toContain('receipt does not cover: nexus-build');
  });
  test('검사 집합이 아예 다른 영수증', () => {
    const stored = receipt({ identity: { checks: ['expose'] } });
    expect(describeGateReceiptDecline(probe, { [stored.key]: stored })).toContain('receipt checks differ');
  });
});

describe('gateEnvFingerprint — 실행 환경 지문', () => {
  test('같은 환경은 같은 지문, fake-LLM 스위치가 다르면 다른 지문', () => {
    expect(gateEnvFingerprint(process.env)).toBe(gateEnvFingerprint(process.env));
    const flipped = { ...process.env, ELANOUS_TEST_FAKE_LLM: process.env.ELANOUS_TEST_FAKE_LLM === '0' ? '1' : '0' };
    expect(gateEnvFingerprint(flipped)).not.toBe(gateEnvFingerprint(process.env));
  });
});

describe('gateLockfileHash — 후보가 실제로 실행한 lockfile 식별값', () => {
  test('lockfile 이 없으면 absent, 내용이 곧 지문이다', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-receipt-lockfile-'));
    try {
      expect(gateLockfileHash(root)).toBe('absent');
      writeFileSync(join(root, 'bun.lock'), '# lock v1\n');
      const first = gateLockfileHash(root);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(root, 'bun.lock'), '# lock v2\n');
      expect(gateLockfileHash(root)).not.toBe(first);
      expect(gateLockfileHash(join(root, 'absent-dir'))).toBe('absent');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
