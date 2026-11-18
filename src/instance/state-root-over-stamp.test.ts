/**
 * RESEARCH-HARNESS-ISOLATION-STATE-DIR — 운영 config override 가 격리 스탬프의 state 를 운영으로 끌어오지 않는다.
 *
 * 사건: 측정 러너가 `ELANOUS_STATE_DIR=<격리>` ⊕ `setElanousConfigDir(~/.elanous)` 로 돌자
 * research.turn 행이 운영 logs.db 에 쌓였다. config 축은 운영 그대로 읽고 state 축만 스탬프로 간다.
 *
 * ⛔ 운영 logs.db 를 열지 않는다 — 운영 루트는 경로 문자열로만 비교하고, 파일은 스탬프 경로임을 단언한 «뒤»에만 연다.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { elanousStateRoot } from '../autopilot/state-paths.js';
import { registerWhereCommand } from '../cli/where-cli.js';
import { debug } from '../debug/log.js';
import { resolveDataDir } from '../config.js';
import { getElanousConfigDir, getElanousConfigDirOverride, getElanousConfigDirOverrideSource, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { LogStore, logsDbPath, _resetDefaultLogStoreForTest } from '../mss/logging/log-store.js';
import { effectiveInstanceRoot, prodInstanceRoot, resetEffectiveInstanceRoot, resetStateRootSplitReportsForTesting, stateRootOverStamp } from './resolve.js';

const savedStateDir = process.env.ELANOUS_STATE_DIR;
const savedOverride = getElanousConfigDirOverride();
const savedOverrideSource = getElanousConfigDirOverrideSource();
const temps: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function restart(): void {
  _resetDefaultLogStoreForTest();
  resetElanousConfigDir();
  resetEffectiveInstanceRoot();
  resetStateRootSplitReportsForTesting();
}

async function whereJson(): Promise<{ actualRoot: string; stateRoot: string; stateRootSplit: boolean; configDir: string }> {
  const lines: string[] = [];
  const program = new Command();
  registerWhereCommand(program, { out: { log: (line) => lines.push(line) } });
  await program.parseAsync(['where', '--json'], { from: 'user' });
  return JSON.parse(lines.join('\n'));
}

beforeEach(() => restart());

afterEach(() => {
  restart();
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = savedStateDir;
  if (savedOverride !== undefined) setElanousConfigDir(savedOverride, savedOverrideSource);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stateRootOverStamp — state 축 규칙(순수)', () => {
  const prod = '/home/u/.elanous';
  test('코드가 건 운영 루트 ⊕ 격리 스탬프 → 스탬프(정규화)', () => {
    expect(stateRootOverStamp(prod, '/runs/r1/state/', prod, 'programmatic')).toBe('/runs/r1/state');
    expect(stateRootOverStamp(`${prod}/`, '/runs/r1/state', prod, 'programmatic')).toBe('/runs/r1/state');
  });
  test('사람·CLI 의 --config-dir 운영 ⊕ 상속 스탬프 → 운영(우주 선택이 이긴다)', () => {
    expect(stateRootOverStamp(prod, '/runs/r1/state', prod, 'flag')).toBe(prod);
  });
  test('override 없음 → 해석값 그대로', () => {
    expect(stateRootOverStamp('/runs/r1/state', '/runs/r1/state', prod, undefined)).toBe('/runs/r1/state');
    expect(stateRootOverStamp(prod, '/runs/r1/state', prod, undefined)).toBe(prod);
  });
  test('격리 override 는 다른 스탬프보다 이긴다(의도된 별개 우주)', () => {
    expect(stateRootOverStamp('/child/B', '/parent/A', prod, 'programmatic')).toBe('/child/B');
  });
  test('스탬프 없음·빈 스탬프·운영 스탬프 → 해석값 그대로', () => {
    expect(stateRootOverStamp(prod, undefined, prod, 'programmatic')).toBe(prod);
    expect(stateRootOverStamp(prod, '  ', prod, 'programmatic')).toBe(prod);
    expect(stateRootOverStamp(prod, `${prod}/`, prod, 'programmatic')).toBe(prod);
  });
});

describe('override 출처는 setter 가 구조로 남긴다', () => {
  test('기본 = programmatic · flag 는 명시 · reset 은 지운다', () => {
    setElanousConfigDir(prodInstanceRoot());
    expect(getElanousConfigDirOverrideSource()).toBe('programmatic');
    setElanousConfigDir(prodInstanceRoot(), 'flag');
    expect(getElanousConfigDirOverrideSource()).toBe('flag');
    resetElanousConfigDir();
    expect(getElanousConfigDirOverrideSource()).toBeUndefined();
  });
});

describe('명시 --config-dir 운영 ⊕ 상속 격리 스탬프 — 운영 우주 그대로', () => {
  test('state 는 운영 경로이고 where 가 같은 뿌리를 말한다', async () => {
    process.env.ELANOUS_STATE_DIR = tempRoot('tc-ris-inherited-');
    setElanousConfigDir(prodInstanceRoot(), 'flag');
    // 경로 문자열만 비교한다 — 운영 logs.db 는 열지 않는다.
    expect(elanousStateRoot()).toBe(prodInstanceRoot());
    expect(logsDbPath()).toBe(join(prodInstanceRoot(), 'logs', 'logs.db'));
    const where = await whereJson();
    expect(where.actualRoot).toBe(prodInstanceRoot());
    expect(where.stateRoot).toBe(prodInstanceRoot());
    expect(where.stateRootSplit).toBe(false);
  });
});

describe('코드가 건 config-dir(운영) ⊕ ELANOUS_STATE_DIR — logs.db 와 research.turn 은 스탬프로', () => {
  test('split 관측이 한 번 남고 where 가 두 뿌리를 모두 보인다', async () => {
    const stamp = tempRoot('tc-ris-split-');
    process.env.ELANOUS_STATE_DIR = stamp;
    setElanousConfigDir(prodInstanceRoot());
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      events.push({ category, event, data });
    }) as typeof debug.log);
    try {
      expect(elanousStateRoot()).toBe(stamp);
      expect(elanousStateRoot()).toBe(stamp);
      const where = await whereJson();
      expect(where.actualRoot).toBe(prodInstanceRoot());
      expect(where.configDir).toBe(prodInstanceRoot());
      expect(where.stateRoot).toBe(stamp);
      expect(where.stateRootSplit).toBe(true);
    } finally { spy.mockRestore(); }
    const splits = events.filter((entry) => entry.category === 'instance.identity' && entry.event === 'state-root-split');
    expect(splits).toHaveLength(1);
    expect(splits[0]?.data).toMatchObject({ configRoot: prodInstanceRoot(), stateRoot: stamp, overrideSource: 'programmatic' });
  });

  test('state 축은 스탬프, config 축은 운영 그대로', () => {
    const stamp = tempRoot('tc-ris-stamp-');
    process.env.ELANOUS_STATE_DIR = stamp;
    setElanousConfigDir(prodInstanceRoot());
    expect(getElanousConfigDir()).toBe(prodInstanceRoot());
    expect(elanousStateRoot()).toBe(stamp);
    expect(logsDbPath()).toBe(join(stamp, 'logs', 'logs.db'));
    const codeRoot = tempRoot('tc-ris-code-');
    expect(resolveDataDir(codeRoot, { hasGit: () => true })).toBe(join(codeRoot, 'data'));
  });

  test('research.turn 행은 스탬프 logs.db 에 남고 재기동·재해석 뒤에도 같은 파일이다', () => {
    const stamp = tempRoot('tc-ris-turn-');
    process.env.ELANOUS_STATE_DIR = stamp;
    setElanousConfigDir(prodInstanceRoot());
    const expected = join(stamp, 'logs', 'logs.db');
    // 경로를 먼저 단언한다 — 틀리면 여기서 멈춰 운영 파일을 열지 않는다.
    expect(logsDbPath()).toBe(expected);
    const writer = new LogStore(logsDbPath(), { instance: 'tc-ris' });
    try {
      writer.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'research.turn', event: 'question-plan-finished', data: { probe: 'tc-ris' } }, surface: 'test' }]);
    } finally { writer.close(); }

    restart();
    setElanousConfigDir(prodInstanceRoot());
    expect(logsDbPath()).toBe(expected);
    const reader = LogStore.openReadOnly(expected);
    try {
      expect(reader.query({ exactCategories: ['research.turn'] }).map((row) => row.event)).toEqual(['question-plan-finished']);
    } finally { reader.close(); }
  });
});

describe('기존 동작 보존', () => {
  test('config-dir 만(스탬프 없음) → state 는 그 config-dir 을 따라간다', () => {
    const configOnly = tempRoot('tc-ris-config-');
    delete process.env.ELANOUS_STATE_DIR;
    setElanousConfigDir(configOnly);
    expect(elanousStateRoot()).toBe(configOnly);
    expect(logsDbPath()).toBe(join(configOnly, 'logs', 'logs.db'));
  });

  test('격리 config-dir ⊕ 다른 스탬프 → config-dir 이 이긴다', () => {
    const child = tempRoot('tc-ris-child-');
    process.env.ELANOUS_STATE_DIR = tempRoot('tc-ris-parent-');
    setElanousConfigDir(child);
    expect(elanousStateRoot()).toBe(child);
  });

  test('운영 config-dir 만(스탬프 없음) → 운영 경로 문자열 그대로', () => {
    delete process.env.ELANOUS_STATE_DIR;
    setElanousConfigDir(prodInstanceRoot());
    expect(elanousStateRoot()).toBe(prodInstanceRoot());
  });

  test('스탬프만(override 없음) → 스탬프 그대로', () => {
    const stamp = tempRoot('tc-ris-stamp-only-');
    process.env.ELANOUS_STATE_DIR = stamp;
    expect(elanousStateRoot()).toBe(stamp);
    expect(effectiveInstanceRoot()).toBe(stamp);
  });

  test('둘 다 없음 → 운영 기본 그대로이고 우주 해석과 같다', () => {
    delete process.env.ELANOUS_STATE_DIR;
    expect(elanousStateRoot()).toBe(effectiveInstanceRoot());
    expect(elanousStateRoot()).toBe(prodInstanceRoot());
    restart();
    expect(elanousStateRoot()).toBe(prodInstanceRoot());
  });
});
