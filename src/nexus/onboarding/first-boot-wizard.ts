import type { WizardIO } from '../../onboarding.js';
import type { SetupCheckResult } from '../setup-status.js';
import type { TailscaleProbe } from './tailscale-probe.js';
import { clonePreset, createManagementStarterContract, type PersonaPreset, type PersonaWriteOptions, type PersonaWriteResult } from '../../persona/presets.js';

export interface FirstBootWizardDeps {
  io: WizardIO;
  setupStatus: SetupCheckResult;
  runLlmStep: (io: WizardIO) => Promise<void>;
  runTailscaleWizard: (io: WizardIO) => Promise<void>;
  shouldRunTailscale?: boolean;
  forceTty?: boolean;
  out?: { log: (s: string) => void; error: (s: string) => void };
  // Phase 4 (2026-05-19) — PWA `/setup` link 표시용. 모두 optional —
  // 부족하면 banner skip 하고 기존 TUI 흐름만.
  /** Daemon HTTP bind port. Banner 의 PWA URL 에 사용. */
  httpPort?: number;
  /** PWA static export 가 빌드되어 있는지. false 면 banner 미표시. */
  pwaBuilt?: boolean;
  /** Tailscale probe 결과 (alive 시 magicDNS / IP 도 banner 에 노출). */
  tailscale?: TailscaleProbe;
  /** 0.2.29 PERSONA-STARTER — «경영» 스타터 계약을 쓸 persona 저장소 경로.
   *  생략하면 기본 상태 저장소(resolveStatePersonaDir) — 운영 첫 실행 경로. */
  starterContractDir?: string;
}

export type FirstBootStep = 'llm' | 'tailscale';

/** 0.2.29 PERSONA-STARTER — 직업 질문에서 «경영»을 골랐을 때 만들어진 스타터 계약 한 장. */
export interface StarterContractSummary {
  personaId: string;
  displayName: string;
  path: string;
}

export type FirstBootResult =
  | { action: 'completed'; stepsRun: FirstBootStep[]; starterContract?: StarterContractSummary }
  | { action: 'skipped'; reason: 'no-tty' | 'all-set-up' };

/** 직업 질문 답의 정규화 — «1»·«경영»·«management» 는 경영,
 *  나머지(빈 답 포함)는 일반(현재 첫 실행 동작 유지). */
export type OccupationChoice = 'management' | 'marketing' | 'general';

export function normalizeOccupationChoice(input: string): OccupationChoice {
  const v = input.trim().toLowerCase();
  if (v === '1' || v === '경영' || v === 'management') return 'management';
  if (v === '3' || v === '마케팅' || v === 'marketing') return 'marketing';
  return 'general';
}

function isTty(force?: boolean): boolean {
  if (force === true) return true;
  if (force === false) return false;
  return Boolean(process.stdin.isTTY);
}

/** Build the PWA `/setup` URLs the banner shows.
 *
 *  Order of preference (most-routable first):
 *    1. Tailscale magicDNS host (if probe alive + DNS name present)
 *    2. Tailscale IPv4 (if alive)
 *    3. localhost (always)
 *
 *  Each URL points at `/app/setup/` per PWA's `basePath: '/app'` +
 *  `trailingSlash: true` (apps/pwa/next.config.ts).
 *
 *  Pure — exported for tests so URL composition can be locked
 *  independently of the prompt flow.
 */
export function buildPwaSetupUrls(deps: {
  httpPort: number;
  tailscale?: TailscaleProbe;
}): string[] {
  const urls: string[] = [];
  const port = deps.httpPort;
  const ts = deps.tailscale;
  if (ts?.alive) {
    if (ts.magicDnsHost && ts.magicDnsHost.length > 0) {
      urls.push(`http://${ts.magicDnsHost}:${port}/app/setup/`);
    }
    if (ts.ips && ts.ips.length > 0) {
      // First IPv4 only — IPv6 second; keep banner tight.
      urls.push(`http://${ts.ips[0]}:${port}/app/setup/`);
    }
  }
  urls.push(`http://localhost:${port}/app/setup/`);
  // De-dupe in case magicDNS == localhost on a single-host tailnet.
  return Array.from(new Set(urls));
}

function shouldShowPwaBanner(deps: FirstBootWizardDeps, llmStepNeeded: boolean): boolean {
  if (!llmStepNeeded) return false;
  if (!deps.pwaBuilt) return false;
  if (typeof deps.httpPort !== 'number' || deps.httpPort <= 0) return false;
  return true;
}

function printPwaSetupBanner(deps: FirstBootWizardDeps): void {
  if (typeof deps.httpPort !== 'number') return;
  const urls = buildPwaSetupUrls({
    httpPort: deps.httpPort,
    ...(deps.tailscale ? { tailscale: deps.tailscale } : {}),
  });
  deps.io.print('  ┌── PWA setup ──────────────────────────────────────────');
  deps.io.print('  │ 터미널 prompt 대신 브라우저 / iPhone 에서 셋업하려면:');
  for (const url of urls) {
    deps.io.print(`  │   ${url}`);
  }
  deps.io.print('  │ (LLM provider 선택 + API key 1 화면 · 30초)');
  deps.io.print('  └───────────────────────────────────────────────────────');
  deps.io.print('');
}

/** 0.2.35 PERSONA-STARTER-FU — 첫 실행 «마케팅» 스타터 계약 원본. 경계 계약상
 *  완료 경계 코드(first-boot-wizard.ts) 안에서 기존 clonePreset 파이프라인으로
 *  persona store 에 정확히 한 장 쓴다. */
const MARKETING_STARTER_PRESET: PersonaPreset = {
  personaId: 'starter-marketing',
  displayName: '마케팅 스타터',
  names: ['마케팅 스타터', '마케팅', 'starter-marketing'],
  role: '마케팅 파트너',
  title: '첫 실행 스타터',
  oneLine: '고객·메시지·채널을 같이 세우는 짝.',
  voice: {
    rule: '짧고 단정하게 — 고객 말로 먼저, 근거 한 줄.',
    examples: [
      '이번 주 메시지는 하나로 좁힙니다 — 첫 화면에서 5초 안에 남는 문장.',
      '그 채널은 도달 근거가 부족합니다 — 가장 싼 실험부터 하시죠.',
    ],
  },
  tasks: [
    { when: '아침 루프', what: '채널 반응·미결 발행물을 한 화면에 모아 첫 판단을 준다' },
    { when: '메시지가 갈릴 때', what: '후보 문장을 셋으로 좁혀 고객·채널·되돌림 수단을 나란히 놓는다' },
    { when: '주간 정산', what: '지난 발행과 실제 반응을 대조해 다음 메시지 기준을 고친다' },
  ],
  tools: [],
  firstQuestions: [
    '지금 가장 급한 고객 메시지는 무엇인가요?',
    '이번 주에 꼭 내보낼 채널이 있나요?',
  ],
  doesNot: [
    '고객 개인정보를 외부에 전송하지 않는다',
    '합의되지 않은 광고·발행을 대신 실행하지 않는다',
  ],
  forWhom: '처음 elanous 를 여는 마케터 — 고객·메시지·채널을 함께 시작하려는 사람.',
};

/** 첫 실행 «마케팅» 선택이 부르는 유일한 제작 입구 — 스타터 계약 한 장을 persona store 에 쓴다. */
export function createMarketingStarterContract(opts: PersonaWriteOptions = {}): PersonaWriteResult {
  return clonePreset(MARKETING_STARTER_PRESET, MARKETING_STARTER_PRESET.displayName, opts);
}

/** 0.2.29 PERSONA-STARTER — 직업 질문. «경영»이면 경영 스타터 계약 한 장을
 *  만들고, 일반이면 계약 없이 현재 흐름 그대로. 계약 생성이 실패해도
 *  wizard 결과는 completed 로 유지한다(fail-soft). */
async function askOccupationAndCreateStarter(
  deps: FirstBootWizardDeps,
  out: { log: (s: string) => void; error: (s: string) => void },
): Promise<StarterContractSummary | undefined> {
  const io = deps.io;
  if (io.nonInteractive) return undefined;
  io.print('');
  io.print('  어떤 일을 하세요? 고르면 스타터 계약 한 장을 만듭니다.');
  io.print('    1) 경영 — 방향·판단·운영을 함께 세우는 경영 스타터');
  io.print('    3) 마케팅 — 고객·메시지·채널을 함께 세우는 마케팅 스타터');
  io.print('    2) 일반 — 지금처럼 계속 (스타터 계약 없이)');
  let answer: string;
  try {
    answer = await io.ask('  선택 (1/2/3 · Enter=일반): ');
  } catch (err) {
    out.error(`first-boot wizard: occupation question failed: ${(err as Error).message}`);
    return undefined;
  }
  const choice = normalizeOccupationChoice(answer);
  if (choice === 'general') return undefined;
  try {
    const written = choice === 'management'
      ? createManagementStarterContract(
          deps.starterContractDir ? { dir: deps.starterContractDir } : {},
        )
      : createMarketingStarterContract(
          deps.starterContractDir ? { dir: deps.starterContractDir } : {},
        );
    io.print(`  ✓ ${choice === 'management' ? '경영' : '마케팅'} 스타터 계약이 만들어졌습니다: ${written.path}`);
    return { personaId: written.personaId, displayName: written.displayName, path: written.path };
  } catch (err) {
    out.error(`first-boot wizard: starter contract failed: ${(err as Error).message}`);
    return undefined;
  }
}

export async function runFirstBootWizard(
  deps: FirstBootWizardDeps,
): Promise<FirstBootResult> {
  if (!isTty(deps.forceTty)) {
    return { action: 'skipped', reason: 'no-tty' };
  }

  const stepsToRun: FirstBootStep[] = [];
  const llm = deps.setupStatus.required.find((item) => item.id === 'llm');
  const llmNeeded = !llm?.passed;
  if (llmNeeded) stepsToRun.push('llm');
  if (deps.shouldRunTailscale) stepsToRun.push('tailscale');

  if (stepsToRun.length === 0) {
    return { action: 'skipped', reason: 'all-set-up' };
  }

  const out = deps.out ?? console;
  deps.io.print('');
  deps.io.print('  elanous NEXUS · first-boot setup');
  deps.io.print('  Press Ctrl-C anytime to skip remaining steps.');
  deps.io.print('');

  if (shouldShowPwaBanner(deps, llmNeeded)) {
    printPwaSetupBanner(deps);
  }

  const stepsRun: FirstBootStep[] = [];
  for (const step of stepsToRun) {
    try {
      if (step === 'llm') await deps.runLlmStep(deps.io);
      else await deps.runTailscaleWizard(deps.io);
      stepsRun.push(step);
    } catch (err) {
      out.error(`first-boot wizard: ${step} step failed: ${(err as Error).message}`);
    }
  }

  const starterContract = await askOccupationAndCreateStarter(deps, out);

  return { action: 'completed', stepsRun, ...(starterContract ? { starterContract } : {}) };
}
