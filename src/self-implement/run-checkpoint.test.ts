import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKPOINT_SCHEMA_ID,
  CHECKPOINT_SCHEMA_VERSION,
  buildCheckpointBundle,
  bundleSha256,
  checkpointPath,
  readCheckpoint,
  sha256Hex,
  writeCheckpoint,
} from './run-checkpoint.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'run-checkpoint-test-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const runId = 'run-01234567-89ab-4cde-8f01-23456789abcd';
const facts = {
  runId,
  goalText: '대상 경로: src/self-implement/run-checkpoint.ts',
  verdictStatus: 'passed',
  salvageBranchSha: 'abc123',
  sessionTranscript: 'user: hi\nelanous: hello',
  roundCards: [{ id: 'card-1' }, { id: 'card-2' }],
  evidenceResult: 'EVIDENCE: [requested] …\nRESULT: 0 fail',
  undeliveredSupervisorDirectives: ['지시 1', '지시 2'],
  childModel: 'grok-4.6',
  tokensUsed: 1234,
  recordedAt: '2026-10-15T00:00:00.000Z',
};

describe('run-checkpoint/v1 스키마 형태', () => {
  test('판 번호·전 필드가 문면 그대로 담긴다', () => {
    const bundle = buildCheckpointBundle(facts);
    expect(bundle.schema).toBe(CHECKPOINT_SCHEMA_ID);
    expect(bundle.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect(bundle.runId).toBe(runId);
    expect(bundle.goalText).toBe(facts.goalText);
    expect(bundle.verdictStatus).toBe('passed');
    expect(bundle.salvageBranchSha).toBe('abc123');
    expect(bundle.sessionTranscript).toContain('hello');
    expect(bundle.roundCards).toHaveLength(2);
    expect(bundle.evidenceResult).toContain('RESULT:');
    expect(bundle.undeliveredSupervisorDirectives).toEqual(['지시 1', '지시 2']);
    expect(bundle.childModel).toBe('grok-4.6');
    expect(bundle.tokensUsed).toBe(1234);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('생략 필드는 null(«미확인»)로 담기고, 빈 값과 구별된다', () => {
    const bundle = buildCheckpointBundle({ runId, goalText: 'g', verdictStatus: 'unknown' });
    expect(bundle.salvageBranchSha).toBeNull();
    expect(bundle.sessionTranscript).toBeNull();
    expect(bundle.roundCards).toBeNull();
    expect(bundle.evidenceResult).toBeNull();
    expect(bundle.undeliveredSupervisorDirectives).toBeNull();
    const empty = buildCheckpointBundle({
      runId, goalText: 'g', verdictStatus: 'unknown',
      sessionTranscript: '', roundCards: [], evidenceResult: '', undeliveredSupervisorDirectives: [],
    });
    expect(empty.roundCards).toEqual([]);
    expect(empty.sessionTranscript).toBe('');
    expect(empty.sha256).not.toBe(bundle.sha256);
    // 미확인(null)·빈 값 둘 다 기록 후 읽기에서 그대로 왕복한다
    const dir = join(tmpRoot, 'run-checkpoint-unknown');
    writeCheckpoint(bundle, dir);
    expect(readCheckpoint(runId, dir)).toEqual(bundle);
    writeCheckpoint(empty, dir);
    expect(readCheckpoint(runId, dir)).toEqual(empty);
    expect(bundle.childModel).toBeNull();
    expect(bundle.tokensUsed).toBeNull();
  });

  test('runId 가 normalizeRunId 산출 집합을 벗어나면 거부한다(정규화하지 않는다)', () => {
    expect(() => buildCheckpointBundle({ runId: '../escape', goalText: 'g', verdictStatus: 'x' })).toThrow();
    expect(() => checkpointPath('../escape', tmpRoot)).toThrow();
  });
});

describe('sha256 전 필드 포함', () => {
  test('sha256 은 자기를 제외한 전 필드에 걸친다 — 필드가 바뀌면 다이제스트도 바뀐다', () => {
    const bundle = buildCheckpointBundle(facts);
    expect(bundle.sha256).toBe(bundleSha256(bundle));
    const altered = buildCheckpointBundle({ ...facts, tokensUsed: 4321 });
    expect(altered.sha256).not.toBe(bundle.sha256);
    // 배열 원소 순서도 다이제스트에 담긴다
    const reordered = buildCheckpointBundle({
      ...facts, roundCards: [...facts.roundCards].reverse(),
    });
    expect(reordered.sha256).not.toBe(bundle.sha256);
  });

  test('sha256 을 뺀 필드를 하나씩 바꾸면 다이제스트가 모두 달라진다(전 필드 포함 반증)', () => {
    const base = buildCheckpointBundle(facts);
    // 필드마다 «다른 값» — 해시에서 하나라도 빠지면 그 필드만 다이제스트가 같아져 실패한다.
    const altered: Record<string, unknown> = {
      schema: 'run-checkpoint/v9',
      schemaVersion: 9,
      runId: 'run-other',
      goalText: '다른 골',
      verdictStatus: 'failed',
      salvageBranchSha: 'def456',
      sessionTranscript: 'user: bye',
      roundCards: [{ id: 'card-9' }],
      evidenceResult: 'RESULT: 1 fail',
      undeliveredSupervisorDirectives: ['지시 9'],
      childModel: 'gpt-6-sol',
      tokensUsed: 9999,
      recordedAt: '2026-10-16T00:00:00.000Z',
    };
    const fields = Object.keys(base).filter((key) => key !== 'sha256');
    // 묶음의 필드 목록과 시험의 변경 목록이 같아야 한다 — 새 필드가 생기면 여기서 걸린다.
    expect([...fields].sort()).toEqual(Object.keys(altered).sort());
    const digests = new Set<string>([base.sha256]);
    for (const key of fields) {
      expect(altered[key]).not.toEqual((base as unknown as Record<string, unknown>)[key]);
      const changed = { ...base, [key]: altered[key] } as typeof base;
      const digest = bundleSha256(changed);
      expect({ key, same: digest === base.sha256 }).toEqual({ key, same: false });
      digests.add(digest);
    }
    expect(digests.size).toBe(fields.length + 1);
  });

  test('sha256Hex 는 정렬된 키 직렬화로 재현성이 있다', () => {
    expect(sha256Hex({ b: 1, a: 2 })).toBe(sha256Hex({ a: 2, b: 1 }));
  });
});

describe('writeCheckpoint 왕복', () => {
  test('기록한 경로를 돌려주고 readCheckpoint 로 sha256 검증과 함께 왕복한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint');
    const bundle = buildCheckpointBundle(facts);
    const path = writeCheckpoint(bundle, dir);
    expect(path).toBe(checkpointPath(runId, dir));
    expect(path.endsWith(`${runId}.checkpoint.json`)).toBe(true);
    const roundTripped = readCheckpoint(runId, dir);
    expect(roundTripped).toEqual(bundle);
    // 같은 사실을 다시 조립하면 같은 sha256 — 스냅샷이 판정 가능하다
    expect(buildCheckpointBundle(facts).sha256).toBe(bundle.sha256);
  });

  test('sha256 이 어긋난 묶음은 읽기에서 거부한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-tamper');
    const bundle = buildCheckpointBundle(facts);
    writeCheckpoint(bundle, dir);
    expect(readCheckpoint(runId, dir).goalText).toBe(bundle.goalText);
    const before = readFileSync(checkpointPath(runId, dir), 'utf8');
    const tampered = { ...bundle, goalText: '위조 문면' } as typeof bundle;
    // 무효 묶음은 «쓰기»에서 거부하고, 기존 스냅샷은 그대로 남는다(임시 파일도 남지 않는다).
    expect(() => writeCheckpoint(tampered, dir)).toThrow(/sha256 mismatch/);
    expect(readFileSync(checkpointPath(runId, dir), 'utf8')).toBe(before);
    expect(readCheckpoint(runId, dir).goalText).toBe(bundle.goalText);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('판이 다른 묶음은 쓰기에서 거부한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-schema');
    const bundle = buildCheckpointBundle(facts);
    const wrong = { ...bundle, schema: 'run-checkpoint/v0' } as unknown as typeof bundle;
    expect(() => writeCheckpoint(wrong, dir)).toThrow(/unknown checkpoint schema/);
  });
});

describe('판 번호·필드·runId 검증', () => {
  const rehash = (b: Record<string, unknown>) => {
    const { sha256: _omit, ...rest } = b;
    return { ...rest, sha256: sha256Hex(rest) };
  };
  const plant = (dir: string, name: string, body: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.checkpoint.json`), JSON.stringify(body), 'utf8');
  };

  test('schemaVersion 이 다르면 해시가 맞아도 쓰기·읽기 모두 거부한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-version');
    const bumped = rehash({ ...buildCheckpointBundle(facts), schemaVersion: 2 }) as never;
    expect(() => writeCheckpoint(bumped, dir)).toThrow(/unsupported checkpoint schemaVersion/);
    plant(dir, runId, bumped);
    expect(() => readCheckpoint(runId, dir)).toThrow(/unsupported checkpoint schemaVersion/);
  });

  test('필수 필드가 빠지거나 타입이 틀리면 해시가 맞아도 읽기에서 거부한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-fields');
    const { goalText: _drop, ...partial } = buildCheckpointBundle(facts);
    plant(dir, runId, rehash({ ...partial, tokensUsed: '1234' }));
    expect(() => readCheckpoint(runId, dir)).toThrow(/invalid checkpoint fields: goalText, tokensUsed/);
  });

  test('미확인 필드 키가 아예 없으면(undefined) 거부한다 — null 만 «미확인»이다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-missing-key');
    const { roundCards: _drop, ...partial } = buildCheckpointBundle(facts);
    plant(dir, runId, rehash(partial));
    expect(() => readCheckpoint(runId, dir)).toThrow(/invalid checkpoint fields: roundCards/);
  });

  test('디스크 파일을 변조하면 읽기에서 sha256 불일치로 거부한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-disk-tamper');
    const path = writeCheckpoint(buildCheckpointBundle(facts), dir);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...onDisk, evidenceResult: 'RESULT: 위조' }), 'utf8');
    expect(() => readCheckpoint(runId, dir)).toThrow(/sha256 mismatch/);
  });

  test('다른 런의 묶음이 이 runId 자리에 있으면 거부한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-runid');
    const other = buildCheckpointBundle({ ...facts, runId: 'run-other' });
    plant(dir, runId, other);
    expect(() => readCheckpoint(runId, dir)).toThrow(/checkpoint runId mismatch/);
  });
});

describe('해시와 저장의 직렬화가 같다', () => {
  test('Date·배열 속 undefined 가 든 라운드 카드도 기록 후 읽기에서 통과한다', () => {
    const dir = join(tmpRoot, 'run-checkpoint-tojson');
    const bundle = buildCheckpointBundle({
      ...facts,
      roundCards: [
        { value: new Date('2026-10-15T01:02:03.000Z'), list: [1, undefined, 3], gone: undefined },
      ],
    });
    // 메모리 묶음이 이미 저장될 꼴이다 — Date 는 ISO 문자열, 배열 속 undefined 는 null.
    expect(bundle.roundCards?.[0]).toEqual({ value: '2026-10-15T01:02:03.000Z', list: [1, null, 3] });
    writeCheckpoint(bundle, dir);
    expect(readCheckpoint(runId, dir)).toEqual(bundle);
  });

  test('sha256Hex 는 toJSON 의미론을 따른다(Date 는 ISO 와 같은 다이제스트)', () => {
    const date = new Date('2026-10-15T01:02:03.000Z');
    expect(sha256Hex({ at: date })).toBe(sha256Hex({ at: date.toISOString() }));
    expect(sha256Hex([undefined])).toBe(sha256Hex([null]));
  });
});