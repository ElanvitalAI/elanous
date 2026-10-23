// 장치 계약 시험 — goal-device 의 두 장치(Ⓐ 부하·타임아웃·cwd-seam 무대 · Ⓑ 마크다운 계약 낭독)를 함께 잰다.
// Ⓐ 는 «부하 주입 · 타임아웃 시뮬레이션 · cwd-seam 관측» 세 얼굴을 갖는다.
// 이 시험은 장치만 재고, 생산 복원 소유권은 src/autopilot/mission-codebase-gate.test.ts 가 잰다
// (여기서 생산 동작을 단언하면 장치가 아니라 생산 코드의 시험이 되어 단계 경계가 무너진다).
import { afterEach, describe, expect, it, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundMissionInCodebase } from '../autopilot/mission-codebase-gate.js';
import {
  GOAL_DEVICE_SEAM_TERM,
  compareSections,
  driveAbandonedTimeoutCwdSeam,
  driveTimeoutCwdSeam,
  goalDeviceExecFile,
  readDocContract,
  readLabeledBlocks,
  readMarkdownSections,
  startGoalLoadDevice,
} from './goal-device.js';

const suiteEntryCwd = process.cwd();
afterEach(() => {
  // The device deliberately exercises a leaking cwd; timeout must still leave
  // the next test at the file's entry directory.
  try {
    if (process.cwd() !== suiteEntryCwd) process.chdir(suiteEntryCwd);
  } catch {
    process.chdir(suiteEntryCwd);
  }
});

describe('goal-device — 부하 주입 표본', () => {
  test('요청한 표본 수만큼 동시에 살아 있고, 그 사이에도 사건 루프가 타이머를 돌린다', async () => {
    const load = startGoalLoadDevice(50);
    try {
      expect(load.sampleCount).toBe(50);
      expect(load.active).toBe(true);
      expect(load.peakActive).toBeGreaterThanOrEqual(50);
      // 부하 표본이 사건 루프를 «막지» 않는지 — 막으면 이 타이머가 영원히 안 깨어난다.
      const ticked = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), 20);
        setTimeout(() => { clearTimeout(timer); resolve(false); }, 2_000);
      });
      expect(ticked).toBe(true);
      expect(load.active).toBe(true);
      // 표본이 «켜진 척» 이 아니라 실제로 계산 조각을 끝냈다.
      expect(load.slices).toBeGreaterThan(0);
    } finally {
      await load.stop();
    }
    expect(load.active).toBe(false);
  });

  test('표본 수 0 은 조용히 통과하지 않고 거부한다', () => {
    expect(() => startGoalLoadDevice(0)).toThrow();
  });
});

describe('goal-device — cwd seam 관측(생산 진입을 그대로 지나는 무대)', () => {
  test('복원을 소유한 런은 복원됐다고 관측하고, 다음 런의 seam 은 시작 자리를 읽는다', async () => {
    const restoring = async (
      goal: string,
      deps: Parameters<typeof groundMissionInCodebase>[1],
    ) => {
      const entry = process.cwd();
      try {
        return await groundMissionInCodebase(goal, deps);
      } finally {
        if (process.cwd() !== entry) process.chdir(entry);
      }
    };
    const entry = process.cwd();
    const observed = await driveTimeoutCwdSeam({ ground: restoring, loadSamples: 50, timeoutMs: 20 });

    expect(observed.loadSamples).toBe(50);
    expect(observed.peakLoadSamples).toBeGreaterThanOrEqual(50);
    expect(observed.loadSlices).toBeGreaterThan(0);
    expect(observed.timedOutDependencyRan).toBe(true);
    // 타임아웃 경로에서 의존성이 옮긴 cwd 를 런이 소유해 되돌렸다.
    expect(observed.restored).toBe(true);
    expect(observed.afterTimeoutCwd).toBe(observed.entryCwd);
    // 다음 런이 읽은 seam 은 시작 자리다(오염된 임시 트리가 아니다).
    expect(observed.successorCwd).toBe(observed.entryCwd);
    expect(observed.successorCwd).toBe(entry);
    // 그 런은 실제로 코드 후보를 모았다 — 장치의 git 대역이 생산 검색 경로를 지났다는 증거.
    expect(observed.successorFiles).toContain('src/goal-seam.ts');
  }, 30_000);

  test('복원을 빠뜨린 런은 새는 것으로 관측되고, 다음 런의 seam 이 옮겨진 자리를 읽는다', async () => {
    const awayRoots: string[] = [];
    const leaking = async (
      goal: string,
      deps: Parameters<typeof groundMissionInCodebase>[1],
    ) => {
      const result = await groundMissionInCodebase(goal, deps);
      const away = mkdtempSync(join(tmpdir(), 'goal-device-away-'));
      awayRoots.push(away);
      process.chdir(away);
      return result;
    };
    const entry = process.cwd();
    try {
      const observed = await driveTimeoutCwdSeam({ ground: leaking, loadSamples: 50, timeoutMs: 20 });
      expect(observed.restored).toBe(false);
      expect(observed.successorCwd).not.toBe(observed.entryCwd);
      // 장치는 자기 정리로 시작 자리를 되돌린다(관측값은 이미 새어나간 상태 그대로 기록됐다).
      expect(process.cwd()).toBe(entry);
    } finally {
      if (process.cwd() !== entry) process.chdir(entry);
      for (const away of awayRoots) rmSync(away, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('goal-device — 마감 뒤 재개 무대', () => {
  test('버려진 본문이 마감 뒤 cwd 를 옮기는 순서를 결정론으로 세우고, 복원 안 하는 런은 새는 것으로 관측한다', async () => {
    // 복원을 소유하지 않는 가짜 런 — 의존성만 지나고 git 대역도 부르지 않는다(장치만 잰다).
    const nonOwning = async (goal: string, deps: Parameters<typeof groundMissionInCodebase>[1]) => {
      await Promise.resolve(deps?.searchTerms?.(goal)).catch(() => undefined);
      return { files: [] } as unknown as Awaited<ReturnType<typeof groundMissionInCodebase>>;
    };
    const entry = process.cwd();
    try {
      const observed = await driveAbandonedTimeoutCwdSeam({ ground: nonOwning, loadSamples: 50, timeoutMs: 10 });
      expect(observed.abandonedAtDeadline).toBe(true);
      expect(observed.lateMutationRan).toBe(true);
      expect(observed.cwdWhileAbandonedPending).not.toBe(observed.entryCwd);
      expect(observed.successorSeamRoots).toEqual([]);
      expect(observed.restored).toBe(false);
      expect(observed.peakLoadSamples).toBeGreaterThanOrEqual(50);
      // 장치 정리는 시작 자리를 되돌린다.
      expect(process.cwd()).toBe(entry);
    } finally {
      if (process.cwd() !== entry) process.chdir(entry);
    }
  }, 30_000);
});

describe('goal-device — git 대역', () => {
  test('ls-files 와 term grep 을 실제 서브프로세스 없이 고정 행으로 답한다', async () => {
    const exec = goalDeviceExecFile();
    const tracked = await exec('git', ['ls-files', '--', 'src', 'scripts'], { encoding: 'utf-8', maxBuffer: 8_000_000 });
    expect(tracked.stdout.split('\n')).toContain('src/goal-seam.ts');

    const hits = await exec('git', ['grep', '-c', '-i', '-I', '-e', 'goal', '--', 'src'], { encoding: 'utf-8', maxBuffer: 8_000_000 });
    expect(hits.stdout).toContain('src/goal-seam.ts');

    const misses = await exec('git', ['grep', '-c', '-i', '-I', '-e', 'no-such-term-xyz', '--', 'src'], { encoding: 'utf-8', maxBuffer: 8_000_000 });
    expect(misses.stdout).toBe('');
  });
});

describe('goal-device — 무대 검색어 불변식', () => {
  test('무대 검색어는 워킹트리 비시험 추적 소스에 리터럴로 없다 — 실물 git grep -F', () => {
    const paths = ['src', 'scripts', 'docs'];
    let rows: string[] = [];
    try {
      const stdout = execFileSync(
        'git',
        ['grep', '-n', '-i', '-I', '-F', '-e', GOAL_DEVICE_SEAM_TERM, '--', ...paths],
        { encoding: 'utf-8', maxBuffer: 8_000_000 },
      );
      rows = stdout.split('\n').filter(Boolean);
    } catch (error) {
      // git grep 은 «매치 0» 을 rc=1 로 알린다 — 그 한 경우만 «없는 검색어» 로 읽는다.
      const status = (error as { status?: number | null }).status;
      if (status !== 1) throw error;
    }
    const offenders = rows
      .map((row) => row.split(':')[0] ?? '')
      .filter((path) => path.length > 0 && !path.includes('.test.'));
    expect(offenders).toEqual([]);
  }, 30_000);
});


const FIXTURE = [
  '# RFC fixture',
  '',
  '## S — 지금',
  '',
  '본문',
  '',
  '### A11. 바깥 목소리 — 표준 등급',
  '',
  '> 인용',
  '',
  '**담당 일**',
  '',
  '1. 피처 문서화 — DOC-GEN',
  '2. 외부 메시지 — CHANNEL-STD',
  '',
  '**승인 경계**',
  '',
  '- 게시는 승인 대기열에서 승인된 항목만',
  '- 첫 공개는 대표 승인 전용',
  '',
  '**M0~M3 — 설계 단계와 구현 상태를 분리**',
  '',
  '| 단계 | 산출·판정선 | 현 상태 |',
  '|---|---|---|',
  '| **M0 계약·목록** | 고정한다 | 아직 확인되지 않았다 |',
  '| **M1 근거 기반 생성** | 생성한다 | 계획이며 연결되지 않았다 |',
  '',
  '## 범위 밖',
  '',
  '- 없음',
  '',
].join('\n');

function withFixture(markdown: string, run: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'goal-device-'));
  const file = join(dir, 'RFC-fixture.md');
  try {
    writeFileSync(file, markdown);
    run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SPEC = {
  section: '바깥 목소리',
  items: ['담당 일', '승인 경계'],
  preserved: [
    { label: 'M0~M3 — 설계 단계와 구현 상태를 분리', rows: 2, phrases: ['**M0 계약·목록**', '**M1 근거 기반 생성**', '현 상태'] },
  ],
} as const;

describe('goal-device: 마크다운 계약 낭독 장치', () => {
  it('절을 제목 단계로 자르고 하위 제목을 상위 절 본문에 넣지 않는다', () => {
    const sections = readMarkdownSections(FIXTURE);
    const target = sections.find(section => section.heading.includes('바깥 목소리'));
    expect(target).toBeDefined();
    expect(target!.level).toBe(3);
    expect(target!.line).toBe(7);
    expect(target!.body).toContain('**승인 경계**');
    expect(target!.body).not.toContain('## 범위 밖');
    expect(sections.filter(section => section.level === 2).map(section => section.heading))
      .toEqual(['S — 지금', '범위 밖']);
  });

  it('요청한 항목의 본문과 행 수를 읽고 없는 항목은 present=false 로 남긴다', () => {
    const section = readMarkdownSections(FIXTURE).find(candidate => candidate.heading.includes('바깥 목소리'))!;
    const blocks = readLabeledBlocks(section.bodyLines, ['담당 일', '승인 경계', '없는 항목']);
    expect(blocks.map(block => block.label)).toEqual(['담당 일', '승인 경계', '없는 항목']);
    expect(blocks.map(block => block.present)).toEqual([true, true, false]);
    expect(blocks[0]!.rows).toBe(2);
    expect(blocks[0]!.body).toContain('CHANNEL-STD');
    expect(blocks[0]!.body).not.toContain('게시는 승인 대기열');
    expect(blocks[1]!.rows).toBe(2);
    expect(blocks[2]!.body).toBe('');
  });

  it('두 항목과 보존 절이 다 있으면 ok=true 이고 표 행 수를 센다', () => {
    withFixture(FIXTURE, file => {
      const reading = readDocContract(file, SPEC);
      expect(reading.sectionFound).toBe(true);
      expect(reading.sectionHeading).toBe('A11. 바깥 목소리 — 표준 등급');
      expect(reading.missingItems).toEqual([]);
      expect(reading.brokenPreserved).toEqual([]);
      expect(reading.preserved[0]!.rows).toBe(2);
      expect(reading.ok).toBe(true);
    });
  });

  it('항목이 빠지면 missingItems 에 이름을 남기고 ok=false 다', () => {
    const damaged = FIXTURE.replace('**승인 경계**', '**다른 절**');
    withFixture(damaged, file => {
      const reading = readDocContract(file, SPEC);
      expect(reading.missingItems).toEqual(['승인 경계']);
      expect(reading.ok).toBe(false);
    });
  });

  it('보존 절의 문면·행 수가 훼손되면 brokenPreserved 로 짚는다', () => {
    const damaged = FIXTURE
      .replace('| **M3 채널 게시·drift 증명** | 게시한다 | 계획 |', '')
      .replace('| **M1 근거 기반 생성** | 생성한다 | 계획이며 연결되지 않았다 |', '');
    withFixture(damaged, file => {
      const reading = readDocContract(file, SPEC);
      expect(reading.ok).toBe(false);
      expect(reading.brokenPreserved).toHaveLength(1);
      expect(reading.brokenPreserved[0]!.label).toBe('M0~M3 — 설계 단계와 구현 상태를 분리');
      expect(reading.brokenPreserved[0]!.rows).toBe(1);
      expect(reading.brokenPreserved[0]!.expectedRows).toBe(2);
      expect(reading.brokenPreserved[0]!.missingPhrases).toEqual(['**M1 근거 기반 생성**']);
    });
  });

  it('절이 없으면 ok=false 이고 보존 문제를 보고하지 않는다', () => {
    withFixture('# 다른 문서\n\n## 범위 밖\n', file => {
      const reading = readDocContract(file, SPEC);
      expect(reading.sectionFound).toBe(false);
      expect(reading.sectionHeading).toBe('');
      expect(reading.missingItems).toEqual(['담당 일', '승인 경계']);
      expect(reading.ok).toBe(false);
    });
  });

  it('전후 문면을 대조해 더해진 항목·사라진 항목·바뀐 항목을 가른다', () => {
    const before = FIXTURE.replace('**담당 일**', '**임시 자리**').replace('- 첫 공개는 대표 승인 전용', '- 첫 공개는 자유');
    const comparison = compareSections(before, FIXTURE);
    expect(comparison.added).toContain('담당 일');
    expect(comparison.removed).toContain('임시 자리');
    expect(comparison.changed.map(change => change.heading)).toEqual(['승인 경계']);
    expect(comparison.unchanged).toContain('M0~M3 — 설계 단계와 구현 상태를 분리');
    expect(comparison.changed[0]!.beforeDigest).not.toBe(comparison.changed[0]!.afterDigest);
  });
});
