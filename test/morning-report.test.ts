// 종합 아침 브리핑 오케스트레이터. 섹션은 로컬 DB 를 읽고(이 머신엔 있고 CI 엔 없음)
// 각 fail-soft. 가드: 부작용 없이(upload:false·narrate:false) 비어있지 않은 에센셜을
// 조립하고 never throws. 상세 테이블(Backbone 등)은 이제 S3 상세 리포트로 이관됐으므로
// 에센셜엔 없다 — 에센셜 고유 계약만 검증.

import { describe, test, expect, mock } from 'bun:test';
import { composeMorningReport } from '../src/domains/morning-report.js';

// ── SWAP-BENCH-CRON 배선 시험 무대(mock 장치) ────────────────────────────────
// 생산 진입점 scripts/morning-report.ts 를 in-process 로 그대로 지나게 한다.
// 부작용 모듈(logs sink · user-config · firecrawl · finviz · telegram)은
// 전부 mock 장치로 갈아끼우고, composeMorningReport 만 가짜로 바꿔 opts 를 관측한다.
// ⚠️ mock.module 은 «절대 경로» 로 지정해야 스크립트 쪽 '../src/...' import 와 매칭된다.
const REPO_ROOT = new URL('..', import.meta.url).href.replace(/\/$/, '');
const SCRIPT_URL = new URL('../scripts/morning-report.js', import.meta.url).href;

interface CapturedOpts { narrate?: boolean; heatmapImageUrl?: string; upload?: boolean; model?: string }
let captured: CapturedOpts[] = [];

function stageMorningReportMocks(): void {
  mock.module(`${REPO_ROOT}/src/domains/morning-report.js`, () => ({
    composeMorningReport: async (_now: Date, opts: CapturedOpts): Promise<string> => {
      captured.push(opts);
      return 'MOCK-REPORT';
    },
  }));
  mock.module(`${REPO_ROOT}/src/domains/standalone-log-sink.js`, () => ({
    registerStandaloneLogSink: async (_label: string): Promise<void> => {},
  }));
  mock.module(`${REPO_ROOT}/src/user-config.js`, () => ({
    getUserConfig: () => ({ finance: { morningHeatmapImage: false, morningNarrative: false } }),
  }));
  mock.module(`${REPO_ROOT}/src/registry/discovery/config.js`, () => ({
    getFirecrawlConfig: () => ({}),
  }));
  mock.module(`${REPO_ROOT}/src/domains/finviz-image.js`, () => ({
    captureFinvizMapImageUrl: async (): Promise<string | null> => null,
  }));
  mock.module(`${REPO_ROOT}/src/telegram-report.js`, () => ({
    explainReportRoute: () => ({ reason: 'routed', hint: '' }),
    sendTelegramReport: async (): Promise<boolean> => true,
    sendReportPhoto: async (): Promise<boolean> => true,
  }));
}

async function runScriptOnce(argv: string[]): Promise<void> {
  const savedArgv = process.argv;
  captured = [];
  stageMorningReportMocks();
  process.argv = ['bun', 'scripts/morning-report.ts', ...argv];
  try {
    await import(SCRIPT_URL);
  } finally {
    process.argv = savedArgv;
  }
}

describe('composeMorningReport (에센셜)', () => {
  // 라이브 소스(omni-market·finviz·dispatch)를 타므로 넉넉한 타임아웃 — 데브머신 통합 가드.
  test('부작용 없이 fail-soft 에센셜 조립 — never throws', async () => {
    const md = await composeMorningReport(new Date('2026-07-05T08:00:00Z'), { upload: false, narrate: false });
    expect(typeof md).toBe('string');
    expect(md).toContain('아침 브리핑');
    expect(md).toContain('verify+HITL');
  }, 60_000);

  // LLM 시장서사는 strictly additive — narrate off(기본) 시 서사 블록 헤더가 없어야 한다.
  test('narrate off — 서사 블록 없음', async () => {
    const now = new Date('2026-07-05T08:00:00Z');
    const base = await composeMorningReport(now, { upload: false });
    expect(base).not.toContain('오늘의 시장');
  }, 60_000);
});

// 시나리오 무대: bun 모듈 캐시는 프로세스 안에서 한 번만 실행하므로,
// 시나리오별로 자식 프로세스 bun test 로 이 파일을 다시 띄워 생산 진입점을
// 새 모듈 레지스트리에서 실제로 실행한다(MORNING_WIRING_SCENARIO 로 재귀 차단).
const WIRING_SCENARIOS = [
  { name: 'flag', argv: ['--dry', '--no-narrate', '--no-upload', '--narrative-model', 'model-x'], expected: 'model-x' },
  { name: 'eq', argv: ['--dry', '--no-narrate', '--no-upload', '--narrative-model=model-x'], expected: 'model-x' },
  { name: 'default', argv: ['--dry', '--no-narrate', '--no-upload'], expected: undefined },
] as const;

const childScenario = process.env.MORNING_WIRING_SCENARIO;

if (childScenario) {
  const s = WIRING_SCENARIOS.find((x) => x.name === childScenario);
  if (!s) throw new Error(`unknown MORNING_WIRING_SCENARIO: ${childScenario}`);
  test(`(자식 무대:${s.name}) 스크립트 진입점이 --narrative-model을 composeMorningReport opts.model로 전달한다`, async () => {
    await runScriptOnce([...s.argv]);
    expect(captured.length).toBeGreaterThan(0);
    if (s.expected === undefined) expect(captured[0]!.model).toBeUndefined();
    else expect(captured[0]!.model).toBe(s.expected);
  }, 30_000);
} else {
  describe('SWAP-BENCH-CRON: 생산 진입점 --narrative-model 배선 (mock 무대)', () => {
    // 무대 이름: test/morning-report.test.ts in-process mock 무대(mock.module 장치) ⊕
    // 시나리오별 자식 프로세스 bun test 무대(MORNING_WIRING_SCENARIO).
    test('스크립트 진입점이 --narrative-model <model>을 composeMorningReport opts.model로 전달한다(3 시나리오)', async () => {
      for (const s of WIRING_SCENARIOS) {
        const proc = Bun.spawnSync(['bun', 'test', import.meta.path], {
          env: { ...process.env, MORNING_WIRING_SCENARIO: s.name },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (proc.exitCode !== 0) {
          throw new Error(`wiring scenario '${s.name}' failed (exit=${proc.exitCode}): ${proc.stderr.toString().slice(-2000)}`);
        }
      }
    }, 120_000);
  });
}
