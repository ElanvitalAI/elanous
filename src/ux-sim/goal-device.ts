// src/ux-sim/goal-device — 골 발사가 «장치 먼저(DEVICE-FIRST-STAGE)» 로 만든 mock 장치 모음.
// 두 골이 같은 경로를 따로 열어 두 장치가 한 파일에 산다(병합 2026-10-22 · #30382 ⊕ #30385):
//   Ⓐ 미션 grounding 게이트 무대 — 부하 주입 · 타임아웃 시뮬레이션 · cwd seam 관측 (아래 첫 절)
//   Ⓑ 마크다운 계약 낭독 장치 — 절·표제 블록·보존 문면 대조 (아래 둘째 절 · CLI `compare`)
//
// 미션 grounding 게이트의 «부하 · 타임아웃 · cwd seam» 무대 — 시험마다 손으로 쓰던 세 가지를 한 장치로 모은다.
//
// 세 얼굴:
//   ① 부하 주입(startGoalLoadDevice) — 동시 표본 N(기본 50)을 실제로 돌려, 판정선 «부하≥50 표본»을
//      시험이 스스로 만든다. 표본은 매 조각마다 사건 루프에 한 바퀴를 내주므로 «부하»이지 «교착»이 아니다.
//   ② 타임아웃 시뮬레이션(driveTimeoutCwdSeam 의 searchTerms) — 의존성이 런 도중 cwd 를 임시 트리로
//      옮긴 뒤 마감을 넘겨 throw 한다. 타임아웃으로 버려지는 본문이 남기는 «옮겨진 cwd» 를 결정론으로 재현한다.
//   ③ cwd seam 관측 — 런이 시작한 자리(entryCwd) · 타임아웃 뒤 자리 · 다음 런이 seam 에서 실제로 읽은
//      자리(successorCwd)를 함께 기록한다. ⛔ 관측값은 장치가 정리하기 «전» 에 찍는다 — 장치의 정리가
//      생산의 누수를 가리면 자가 자기를 속인다.
//
// ⛔ 이 장치는 «실제 git 서브프로세스» 를 띄우지 않는다(goalDeviceExecFile 이 생산 검색 seam 을 대신 답한다).
//    부하 50 표본 밑에서 git 을 50번 띄우면 재는 것이 부하가 아니라 디스크가 된다.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundMissionInCodebase, setExecFileForTest, type ExecFileLike } from '../autopilot/mission-codebase-gate.js';

/** 부하 표본 기본값 — 판정선 «부하≥50 표본» 과 같은 수. */
export const GOAL_DEVICE_LOAD_SAMPLES = 50;

/**
 * 무대 검색어 — 워킹트리에 «없는» 값이어야 빈 코퍼스 시험이 성립한다.
 *
 * ⛔ 리터럴로 적지 않는다. 주입이 없을 때 생산 검색(`groundMissionInCodebase`)은 실물
 * `git grep` 으로 워킹트리를 훑으므로, 이 파일에 리터럴을 적으면 이 장치 자신이 그 검색어의
 * «코드 후보» 로 잡혀 `src/autopilot/mission-codebase-gate.test.ts` 의 빈 코퍼스 단언이
 * 오염된다(gate introduced 2). 조각을 런타임에 이어 «저장소에 없는 값» 불변식을 지킨다 —
 * 그 불변식은 `goal-device.test.ts` 가 실물 `git grep` 으로 함께 잰다.
 */
export const GOAL_DEVICE_SEAM_TERM = ['qxjvp', 'lmno'].join('');

const GOAL_DEVICE_TRACKED = ['src/goal-seam.ts', 'scripts/goal-seam-task.ts'];

const GOAL_DEVICE_CODE_ROWS: Record<string, string[]> = {
  [GOAL_DEVICE_SEAM_TERM]: ['src/goal-seam.ts:2'],
  goal: ['src/goal-seam.ts:2'],
};

export interface GoalLoadDevice {
  /** 시작한 표본 수. */
  readonly sampleCount: number;
  /** 실제로 동시에 살아 있던 최대 표본 수(관측값). */
  readonly peakActive: number;
  /** 표본들이 끝낸 부하 조각 수 — 0 이면 부하는 «켜진 척» 한 것이다. */
  readonly slices: number;
  readonly active: boolean;
  /** 표본별 끝낸 조각 수의 사본 — 두 시점을 비교해 «그 구간에 실제로 일한 표본 수» 를 잰다. */
  sliceSnapshot(): number[];
  stop(): Promise<void>;
}

/** 두 스냅샷 사이에 조각을 하나 이상 끝낸 표본 수 — «시작만 한» 표본은 세지 않는다. */
export function samplesWorkedBetween(before: readonly number[], after: readonly number[]): number {
  return after.filter((count, index) => count > (before[index] ?? 0)).length;
}

/** 생산 런이 «진행 중» 인 동안 모든 표본이 한 조각 이상 일할 때까지 기다린다 — 측정 구간이 부하 한 바퀴를
 *  반드시 품게 한다(타이머 길이에 기대지 않는다). 표본이 멈췄으면 무한 대기 대신 `maxWaitMs` 뒤 그대로 돌아간다. */
async function untilAllSamplesWorked(load: GoalLoadDevice, since: readonly number[], maxWaitMs = 10_000): Promise<void> {
  const deadline = performance.now() + maxWaitMs;
  while (samplesWorkedBetween(since, load.sliceSnapshot()) < load.sampleCount && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 부하 주입 — `samples` 개의 표본이 각자 `sliceMs` 만큼 실제 계산을 하고 사건 루프에 한 바퀴를 내준다.
 * 표본은 `stop()` 전까지 계속 돈다. ⛔ 표본이 사건 루프를 막으면 그것은 부하가 아니라 교착이므로,
 * 매 조각 끝에 타이머 0 으로 양보한다.
 */
export function startGoalLoadDevice(samples: number = GOAL_DEVICE_LOAD_SAMPLES, sliceMs = 4): GoalLoadDevice {
  if (!Number.isInteger(samples) || samples < 1) throw new Error('goal load samples must be a positive integer');
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw new Error('goal load slice must be a nonnegative finite number');
  let running = true;
  let alive = 0;
  let peak = 0;
  let slices = 0;
  const perSample = new Array<number>(samples).fill(0);
  const workers = Array.from({ length: samples }, async (_unused, index) => {
    alive += 1;
    peak = Math.max(peak, alive);
    try {
      while (running) {
        const until = performance.now() + sliceMs;
        while (performance.now() < until) { /* CPU 점유 — 표본이 실제로 부하를 만든다 */ }
        slices += 1;
        perSample[index] += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      alive -= 1;
    }
  });
  return {
    sampleCount: samples,
    get peakActive() { return peak; },
    get slices() { return slices; },
    get active() { return running; },
    sliceSnapshot() { return [...perSample]; },
    async stop() {
      running = false;
      await Promise.all(workers);
    },
  };
}

/** git 대역 — 생산 검색 seam(`setExecFileForTest`)에 꽂아 실제 저장소·서브프로세스 없이 고정 행을 답한다. */
export function goalDeviceExecFile(
  tracked: readonly string[] = GOAL_DEVICE_TRACKED,
  codeRows: Record<string, readonly string[]> = GOAL_DEVICE_CODE_ROWS,
  onCall?: (call: { args: readonly string[]; cwd: string | undefined }) => void,
): ExecFileLike {
  return async (_file, args, options) => {
    // 생산 검색이 git 에 넘긴 cwd 를 그대로 기록한다 — 그것이 seam 이 «실제로 읽은» 저장소 루트다.
    onCall?.({ args, cwd: options?.cwd });
    if (args[0] === 'ls-files') {
      const after = args.indexOf('--');
      const paths = after >= 0 ? args.slice(after + 1) : [];
      const rows = paths.length
        ? tracked.filter((file) => paths.some((path) => file === path || file.startsWith(`${path}/`)))
        : [...tracked];
      return { stdout: rows.join('\n') };
    }
    const term = args[args.indexOf('-e') + 1] ?? '';
    return { stdout: (codeRows[term] ?? []).join('\n') };
  };
}

export type GoalSeamGroundFn = (
  goal: string,
  deps: Parameters<typeof groundMissionInCodebase>[1],
) => ReturnType<typeof groundMissionInCodebase>;

export interface CwdSeamObservation {
  /** 런이 시작한 자리(process cwd). */
  entryCwd: string;
  /** 타임아웃으로 끝난 런 직후의 자리. */
  afterTimeoutCwd: string;
  /** 그 런이 스스로 자기 자리를 되돌렸나 — 생산 소유권의 관측값. */
  restored: boolean;
  /** 다음 런이 seam 에서 실제로 읽은 자리. */
  successorCwd: string;
  /** 다음 런이 모은 구현 후보(장치 git 대역이 생산 검색 경로를 지났다는 증거). */
  successorFiles: string[];
  loadSamples: number;
  peakLoadSamples: number;
  /** 측정 구간에서 표본들이 실제로 끝낸 부하 조각 수 — 0 이면 부하는 «켜진 척» 한 것이다. */
  loadSlices: number;
  /** 측정 구간(첫 생산 진입 직전 ~ 마지막 생산 진입 직후) 동안 조각을 하나 이상 끝낸 표본 수. */
  loadSamplesWorkedDuringWindow: number;
  /** 타임아웃 의존성이 실제로 마감을 넘겨 throw 했나(무대가 돌았다는 증거). */
  timedOutDependencyRan: boolean;
}

/**
 * 타임아웃 · cwd seam 무대 — 부하 표본을 켠 채 생산 진입(`groundMissionInCodebase`)을 두 번 지난다.
 *  ① 첫 런: 의존성(searchTerms)이 cwd 를 임시 트리로 옮기고 마감을 넘겨 throw(= 타임아웃으로 버려지는 본문).
 *  ② 둘째 런: `deps.cwd` 를 주지 않고 seam 이 `process.cwd()` 를 읽게 한다 ⇒ 첫 런이 새면 오염된 자리를 읽는다.
 * `ground` 는 관측 방향을 반증하기 위한 seam 이다(복원을 소유한 런 / 소유하지 않은 런).
 */
export async function driveTimeoutCwdSeam(options: {
  ground?: GoalSeamGroundFn;
  timeoutMs?: number;
  loadSamples?: number;
  loadSliceMs?: number;
} = {}): Promise<CwdSeamObservation> {
  const ground = options.ground ?? groundMissionInCodebase;
  const timeoutMs = options.timeoutMs ?? 40;
  const loadSamples = options.loadSamples ?? GOAL_DEVICE_LOAD_SAMPLES;
  const throwaway = mkdtempSync(join(tmpdir(), 'goal-device-cwd-'));
  const entryCwd = process.cwd();
  const load = startGoalLoadDevice(loadSamples, options.loadSliceMs);
  setExecFileForTest(goalDeviceExecFile());
  let timedOutDependencyRan = false;
  // 표본이 «시작» 한 것만으로는 부하가 아니다 — 측정 구간 앞뒤 스냅샷으로 «그 사이 일한» 표본을 센다.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const windowStart = load.sliceSnapshot();
  try {
    await ground('cwd seam timeout fixture', {
      searchTerms: async () => {
        process.chdir(throwaway);
        await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        await untilAllSamplesWorked(load, windowStart);
        timedOutDependencyRan = true;
        throw new Error('goal-device: grounding deadline exceeded');
      },
      persistent: false,
      skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    });
    // ⛔ 관측은 정리 «전» — 여기서 찍은 값이 생산 소유권의 판정 근거다.
    const afterTimeoutCwd = process.cwd();
    let successorCwd = '';
    const successor = await ground('cwd seam successor fixture', {
      searchTerms: async () => {
        successorCwd = process.cwd();
        return [GOAL_DEVICE_SEAM_TERM];
      },
      persistent: false,
      skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    });
    return {
      entryCwd,
      afterTimeoutCwd,
      restored: afterTimeoutCwd === entryCwd,
      // 빈 값이면 seam 이 안 읽힌 것이다 — process.cwd() 로 덮어 «복원된 것처럼» 보이게 하지 않는다.
      successorCwd,
      successorFiles: successor.files,
      loadSamples,
      peakLoadSamples: load.peakActive,
      loadSlices: load.slices,
      loadSamplesWorkedDuringWindow: samplesWorkedBetween(windowStart, load.sliceSnapshot()),
      timedOutDependencyRan,
    };
  } finally {
    // 장치 정리 — 생산이 새든 말든 이 시험 뒤의 세계는 시작 자리로 돌아간다.
    setExecFileForTest(null);
    await load.stop();
    if (process.cwd() !== entryCwd) process.chdir(entryCwd);
    rmSync(throwaway, { recursive: true, force: true });
  }
}

export interface AbandonedTimeoutObservation {
  /** 무대가 시작한 자리(process cwd). */
  entryCwd: string;
  /** 호출자의 마감이 런보다 먼저 왔나 — 런을 «버린» 무대가 성립했다는 증거. */
  abandonedAtDeadline: boolean;
  /** 마감 «뒤» 재개된 본문이 실제로 cwd 를 옮겼나. */
  lateMutationRan: boolean;
  /** 늦은 변경 직후, 버려진 런이 아직 끝나기 전의 process cwd(오염이 실제로 일어났다는 관측). */
  cwdWhileAbandonedPending: string;
  /** 겹쳐 들어온 다음 런이 생산 검색에서 git 에 넘긴 cwd 들 — seam 이 실제로 읽은 저장소 루트. */
  successorSeamRoots: string[];
  /** 다음 런이 모은 구현 후보. */
  successorFiles: string[];
  /** 다음 런이 끝난 직후(버려진 런은 아직 진행 중)의 process cwd. */
  cwdAfterSuccessor: string;
  /** 버려진 런까지 모두 끝난 뒤의 process cwd. */
  afterAllSettledCwd: string;
  restored: boolean;
  loadSamples: number;
  peakLoadSamples: number;
  loadSlices: number;
  /** 측정 구간 동안 조각을 하나 이상 끝낸 표본 수. */
  loadSamplesWorkedDuringWindow: number;
}

/**
 * 마감 뒤 재개 무대 — 호출자가 마감(`timeoutMs`)으로 런을 «버린» 뒤, 그 런의 본문(searchTerms)이 재개되어
 * cwd 를 임시 트리로 옮긴다. 버려진 런이 아직 끝나지 않은 사이 다음 런이 «겹쳐» 들어와 생산 검색을 지난다.
 *  - 관측 ①: 다음 런이 git 에 넘긴 cwd(= seam 이 읽은 루트)가 오염된 임시 트리인가, 시작 자리인가.
 *  - 관측 ②: 버려진 런이 끝나는 순간 cwd 가 시작 자리로 돌아오나.
 * 순서는 약속(gate)으로 고정한다 — 타이머 경합에 기대지 않아 부하 밑에서도 결정론이다.
 */
export async function driveAbandonedTimeoutCwdSeam(options: {
  ground?: GoalSeamGroundFn;
  timeoutMs?: number;
  loadSamples?: number;
  loadSliceMs?: number;
} = {}): Promise<AbandonedTimeoutObservation> {
  const ground = options.ground ?? groundMissionInCodebase;
  const timeoutMs = options.timeoutMs ?? 20;
  const loadSamples = options.loadSamples ?? GOAL_DEVICE_LOAD_SAMPLES;
  const throwaway = mkdtempSync(join(tmpdir(), 'goal-device-abandoned-'));
  const entryCwd = process.cwd();
  const load = startGoalLoadDevice(loadSamples, options.loadSliceMs);
  let phase: 'abandoned' | 'successor' = 'abandoned';
  const successorSeamRoots: string[] = [];
  setExecFileForTest(goalDeviceExecFile(undefined, undefined, ({ cwd }) => {
    if (phase === 'successor') successorSeamRoots.push(cwd ?? '');
  }));
  let releaseDeadline!: () => void;
  const deadlinePassed = new Promise<void>((resolve) => { releaseDeadline = resolve; });
  let markMutated!: () => void;
  const mutated = new Promise<void>((resolve) => { markMutated = resolve; });
  let releaseSuccessorDone!: () => void;
  const successorDone = new Promise<void>((resolve) => { releaseSuccessorDone = resolve; });
  let lateMutationRan = false;
  const noRecall = {
    persistent: false as const,
    skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
  };
  let abandoned: Promise<unknown> | null = null;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const windowStart = load.sliceSnapshot();
  try {
    abandoned = ground('abandoned timeout fixture', {
      ...noRecall,
      searchTerms: async () => {
        await deadlinePassed;
        await untilAllSamplesWorked(load, windowStart);
        process.chdir(throwaway);
        lateMutationRan = true;
        markMutated();
        await successorDone;
        throw new Error('goal-device: abandoned body resumed after deadline');
      },
    }).catch(() => undefined);
    const raced = await Promise.race([
      abandoned.then(() => 'settled' as const),
      new Promise<'deadline'>((resolve) => setTimeout(() => resolve('deadline'), timeoutMs)),
    ]);
    releaseDeadline();
    // 본문이 searchTerms 에 닿지 않고 끝나면 «늦은 변경» 은 없다 — 무대가 멈추지 않게 settle 과 경합한다.
    await Promise.race([mutated, abandoned]);
    const cwdWhileAbandonedPending = process.cwd();
    phase = 'successor';
    let successorFiles: string[] = [];
    try {
      const successor = await ground('cwd seam successor fixture', {
        ...noRecall,
        searchTerms: async () => [GOAL_DEVICE_SEAM_TERM],
      });
      successorFiles = successor.files;
    } finally {
      phase = 'abandoned';
    }
    const cwdAfterSuccessor = process.cwd();
    releaseSuccessorDone();
    await abandoned;
    // ⛔ 관측은 정리 «전».
    const afterAllSettledCwd = process.cwd();
    return {
      entryCwd,
      abandonedAtDeadline: raced === 'deadline',
      lateMutationRan,
      cwdWhileAbandonedPending,
      successorSeamRoots,
      successorFiles,
      cwdAfterSuccessor,
      afterAllSettledCwd,
      restored: afterAllSettledCwd === entryCwd,
      loadSamples,
      peakLoadSamples: load.peakActive,
      loadSlices: load.slices,
      loadSamplesWorkedDuringWindow: samplesWorkedBetween(windowStart, load.sliceSnapshot()),
    };
  } finally {
    releaseDeadline();
    releaseSuccessorDone();
    if (abandoned) await abandoned;
    setExecFileForTest(null);
    await load.stop();
    if (process.cwd() !== entryCwd) process.chdir(entryCwd);
    rmSync(throwaway, { recursive: true, force: true });
  }
}

// ─── Ⓑ 마크다운 계약 낭독 장치 ───────────────────────────────────────────────

export interface MarkdownSection {
  heading: string;
  level: number;
  line: number;
  body: string;
  bodyLines: string[];
}

export interface LabeledBlock {
  label: string;
  present: boolean;
  rows: number;
  body: string;
  lines: string[];
}

export interface PreservedSpec {
  label: string;
  rows: number;
  phrases: readonly string[];
}

export interface ContractSpec {
  section: string;
  items: readonly string[];
  preserved: readonly PreservedSpec[];
}

export interface PreservedReading extends LabeledBlock {
  expectedRows: number;
  missingPhrases: string[];
}

export interface BrokenPreserved {
  label: string;
  rows: number;
  expectedRows: number;
  missingPhrases: string[];
}

export interface DocContractReading {
  sectionFound: boolean;
  sectionHeading: string;
  items: LabeledBlock[];
  missingItems: string[];
  preserved: PreservedReading[];
  brokenPreserved: BrokenPreserved[];
  ok: boolean;
}

export interface SectionChange {
  heading: string;
  beforeDigest: string;
  afterDigest: string;
}

export interface SectionComparison {
  added: string[];
  removed: string[];
  changed: SectionChange[];
  unchanged: string[];
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const BOLD_LABEL = /^\*\*(.+?)\*\*$/;
const LABELED_HEADING = /^#{2,6}\s+(.+?)\s*$/;
const LIST_ITEM = /^(?:[-*+]|\d+\.)\s+\S/;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|$/;

function isLabelLine(line: string): boolean {
  const trimmed = line.trim();
  return BOLD_LABEL.test(trimmed) || LABELED_HEADING.test(trimmed);
}

function labelOf(line: string): string {
  const trimmed = line.trim();
  const bold = BOLD_LABEL.exec(trimmed);
  if (bold) return bold[1]!.trim();
  const heading = LABELED_HEADING.exec(trimmed);
  if (heading) return heading[1]!.trim();
  return '';
}

/**
 * 표 데이터 행과 목록 항목만 센다. 문단·표 머리행·구분행은 세지 않는다 —
 * 절이 «문면을 그대로 지켰는지» 를 문단 줄바꿈 차이에 흔들리지 않게 재기 위해서다.
 */
function countRows(lines: readonly string[]): number {
  let rows = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('|')) {
      if (TABLE_SEPARATOR.test(line)) {
        if (rows > 0) rows -= 1;
        continue;
      }
      rows += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) rows += 1;
  }
  return rows < 0 ? 0 : rows;
}

/** 마크다운을 제목 단계로 자른다. 하위 제목 절은 상위 절의 본문에 들어간다. */
export function readMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index]!);
    if (!match) continue;
    const level = match[1]!.length;
    const heading = match[2]!.trim();
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = HEADING.exec(lines[next]!);
      if (candidate && candidate[1]!.length <= level) {
        end = next;
        break;
      }
    }
    const bodyLines = lines.slice(index + 1, end);
    sections.push({ heading, level, line: index + 1, body: bodyLines.join('\n'), bodyLines });
  }
  return sections;
}

/** 절 본문에서 요청한 «굵은 표제 블록» 을 순서대로 낭독한다. 없으면 present=false 로 남긴다. */
export function readLabeledBlocks(bodyLines: readonly string[], labels: readonly string[]): LabeledBlock[] {
  const starts: { label: string; index: number }[] = [];
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index]!;
    if (!isLabelLine(line)) continue;
    starts.push({ label: labelOf(line), index });
  }

  return labels.map(label => {
    const start = starts.find(candidate => candidate.label === label);
    if (!start) {
      return { label, present: false, rows: 0, body: '', lines: [] };
    }
    const nextStart = starts.find(candidate => candidate.index > start.index);
    const lines = bodyLines.slice(start.index + 1, nextStart ? nextStart.index : bodyLines.length);
    return {
      label,
      present: true,
      rows: countRows(lines),
      body: lines.join('\n'),
      lines,
    };
  });
}

function collectBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = markdown.split('\n');
  const starts: { label: string; index: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isLabelLine(lines[index]!)) continue;
    starts.push({ label: labelOf(lines[index]!), index });
  }
  for (let position = 0; position < starts.length; position += 1) {
    const current = starts[position]!;
    const next = starts[position + 1];
    const body = lines.slice(current.index + 1, next ? next.index : lines.length).join('\n');
    if (!blocks.has(current.label)) blocks.set(current.label, body);
  }
  return blocks;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 두 문서(또는 두 판)의 표제 블록을 대조해 더해진·사라진·바뀐·그대로인 항목을 가른다. */
export function compareSections(beforeMarkdown: string, afterMarkdown: string): SectionComparison {
  const before = collectBlocks(beforeMarkdown);
  const after = collectBlocks(afterMarkdown);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: SectionChange[] = [];
  const unchanged: string[] = [];

  for (const label of after.keys()) {
    if (!before.has(label)) added.push(label);
  }
  for (const label of before.keys()) {
    if (!after.has(label)) removed.push(label);
  }
  for (const [label, beforeBody] of before) {
    const afterBody = after.get(label);
    if (afterBody === undefined) continue;
    const beforeDigest = digest(beforeBody);
    const afterDigest = digest(afterBody);
    if (beforeDigest === afterDigest) unchanged.push(label);
    else changed.push({ heading: label, beforeDigest, afterDigest });
  }

  return { added, removed, changed, unchanged };
}

const MISSING_SECTION = {
  sectionFound: false,
  sectionHeading: '',
  preserved: [] as PreservedReading[],
  brokenPreserved: [] as BrokenPreserved[],
  ok: false,
};

/** 파일 하나를 읽어 «절 존재 · 요청 항목 존재 · 보존 절 문면» 세 축을 한 번에 낭독한다. */
export function readDocContract(file: string, spec: ContractSpec): DocContractReading {
  const markdown = readFileSync(file, 'utf8');
  const matches = readMarkdownSections(markdown).filter(section => section.heading.includes(spec.section));
  if (matches.length === 0) {
    return {
      ...MISSING_SECTION,
      items: spec.items.map(label => ({ label, present: false, rows: 0, body: '', lines: [] })),
      missingItems: [...spec.items],
    };
  }

  const section = matches.reduce((deepest, candidate) => (candidate.level > deepest.level ? candidate : deepest));
  const items = readLabeledBlocks(section.bodyLines, spec.items);
  const missingItems = items.filter(item => !item.present).map(item => item.label);

  const preserved: PreservedReading[] = spec.preserved.map(entry => {
    const block = readLabeledBlocks(section.bodyLines, [entry.label])[0]!;
    const missingPhrases = entry.phrases.filter(phrase => !block.body.includes(phrase));
    return { ...block, expectedRows: entry.rows, missingPhrases };
  });
  const brokenPreserved: BrokenPreserved[] = preserved
    .filter(block => !block.present || block.rows !== block.expectedRows || block.missingPhrases.length > 0)
    .map(block => ({
      label: block.label,
      rows: block.rows,
      expectedRows: block.expectedRows,
      missingPhrases: block.missingPhrases,
    }));

  return {
    sectionFound: true,
    sectionHeading: section.heading,
    items,
    missingItems,
    preserved,
    brokenPreserved,
    ok: missingItems.length === 0 && brokenPreserved.length === 0,
  };
}

if (import.meta.main) {
  const [command, before, after] = process.argv.slice(2);
  if (command === 'compare' && before && after) {
    const comparison = compareSections(readFileSync(before, 'utf8'), readFileSync(after, 'utf8'));
    console.log(JSON.stringify(comparison, null, 2));
  } else {
    console.error('usage: bun src/ux-sim/goal-device.ts compare <before.md> <after.md>');
    process.exitCode = 1;
  }
}
