// First-boot wizard tests — Phase 4 PWA banner + step ordering.
//
// 기존에 first-boot-wizard 자체 test 가 없어서 (PWA share wizard 측 test
// 만 있음) 본 PR 에서 banner + step gating 을 lock. Pure — IO 는
// 메모리 buffer 로 capture · runLlmStep 은 spy.
// 0.2.29 PERSONA-STARTER — 직업 질문 «경영» 선택 → 스타터 계약 한 장 +
// 일반 선택 회귀(계약 없음 · 기존 banner/stepsRun 유지)를 추가. 계약은
// tmp persona 저장소에 실경로로 쓰고 파일 수·내용으로 입증한다.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

import type { WizardIO } from '../../onboarding.js';
import type { SetupCheckResult, SetupItem } from '../setup-status.js';
import type { TailscaleProbe } from './tailscale-probe.js';
import {
  buildPwaSetupUrls,
  normalizeOccupationChoice,
  runFirstBootWizard,
  type FirstBootWizardDeps,
  type StarterContractSummary,
} from './first-boot-wizard.js';

interface CapturedIO {
  io: WizardIO;
  printed: string[];
  asked: string[];
}

function makeIO(answers: string[] = []): CapturedIO {
  const printed: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const io: WizardIO = {
    ask: async (prompt) => {
      asked.push(prompt);
      return queue.length > 0 ? queue.shift()! : '';
    },
    print: (s: string) => { printed.push(s); },
    close: () => undefined,
  };
  return { io, printed, asked };
}

function makeStatus(llmPassed: boolean): SetupCheckResult {
  const llm: SetupItem = {
    id: 'llm',
    label: 'LLM provider',
    passed: llmPassed,
    hint: 'run `elanous setup llm`',
  };
  return { required: [llm], recommended: [], ok: llmPassed };
}

describe('buildPwaSetupUrls — Phase 4 URL composition', () => {
  test('returns localhost only when no tailscale', () => {
    const urls = buildPwaSetupUrls({ httpPort: 31415 });
    expect(urls).toEqual(['http://localhost:31415/app/setup/']);
  });

  test('prepends magicDNS host when tailscale alive', () => {
    const ts: TailscaleProbe = {
      installed: true,
      alive: true,
      magicDnsHost: 'mbp.tailnet-x.ts.net',
      ips: ['100.112.0.1'],
    };
    const urls = buildPwaSetupUrls({ httpPort: 31420, tailscale: ts });
    expect(urls[0]).toBe('http://mbp.tailnet-x.ts.net:31420/app/setup/');
    expect(urls[1]).toBe('http://100.112.0.1:31420/app/setup/');
    expect(urls[2]).toBe('http://localhost:31420/app/setup/');
  });

  test('omits magicDNS when tailscale installed but not alive', () => {
    const ts: TailscaleProbe = {
      installed: true,
      alive: false,
      magicDnsHost: 'mbp.tailnet-x.ts.net',
      ips: ['100.112.0.1'],
    };
    const urls = buildPwaSetupUrls({ httpPort: 31415, tailscale: ts });
    expect(urls).toEqual(['http://localhost:31415/app/setup/']);
  });

  test('omits IP when alive but no ips reported', () => {
    const ts: TailscaleProbe = { installed: true, alive: true, magicDnsHost: 'h.example' };
    const urls = buildPwaSetupUrls({ httpPort: 31415, tailscale: ts });
    expect(urls).toEqual([
      'http://h.example:31415/app/setup/',
      'http://localhost:31415/app/setup/',
    ]);
  });

  test('de-dupes when localhost == single tailscale IP', () => {
    const ts: TailscaleProbe = { installed: true, alive: true, ips: ['localhost'] };
    const urls = buildPwaSetupUrls({ httpPort: 31415, tailscale: ts });
    // Same URL appears as ips[0] + localhost — uniq.
    expect(urls.length).toBe(1);
  });
});

describe('runFirstBootWizard — Phase 4 banner gating', () => {
  test('no-tty short-circuit', async () => {
    const { io } = makeIO();
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: false,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    });
    expect(result.action).toBe('skipped');
    expect((result as { reason: string }).reason).toBe('no-tty');
  });

  test('all-set-up short-circuit', async () => {
    const { io, printed } = makeIO();
    let askCalls = 0;
    io.ask = async () => { askCalls += 1; return '1'; };
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(true),
      forceTty: true,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    });
    expect(result.action).toBe('skipped');
    expect((result as { reason: string }).reason).toBe('all-set-up');
    expect(askCalls).toBe(0);
    expect(printed.join('\n')).not.toContain('어떤 일');
  });

  test('llm step needed + pwaBuilt + httpPort → banner printed', async () => {
    const { io, printed } = makeIO();
    let llmCalled = false;
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      httpPort: 31415,
      pwaBuilt: true,
      runLlmStep: async () => { llmCalled = true; },
      runTailscaleWizard: async () => undefined,
    });
    expect(result.action).toBe('completed');
    expect(llmCalled).toBe(true);
    const banner = printed.join('\n');
    expect(banner).toContain('PWA setup');
    expect(banner).toContain('http://localhost:31415/app/setup/');
  });

  test('banner skipped when pwa not built', async () => {
    const { io, printed } = makeIO();
    await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      httpPort: 31415,
      pwaBuilt: false,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    });
    expect(printed.join('\n')).not.toContain('PWA setup');
  });

  test('banner skipped when httpPort missing', async () => {
    const { io, printed } = makeIO();
    await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      pwaBuilt: true,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    });
    expect(printed.join('\n')).not.toContain('PWA setup');
  });

  test('banner includes tailscale magicDNS when probe alive', async () => {
    const { io, printed } = makeIO();
    const tailscale: TailscaleProbe = {
      installed: true,
      alive: true,
      magicDnsHost: 'mbp.tailnet.ts.net',
      ips: ['100.99.0.42'],
    };
    await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      httpPort: 31425,
      pwaBuilt: true,
      tailscale,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    });
    const banner = printed.join('\n');
    expect(banner).toContain('mbp.tailnet.ts.net:31425');
    expect(banner).toContain('100.99.0.42:31425');
    expect(banner).toContain('localhost:31425');
  });

  test('llm step error is captured and does not abort', async () => {
    const { io } = makeIO();
    let tailscaleCalled = false;
    const errors: string[] = [];
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      shouldRunTailscale: true,
      out: { log: () => undefined, error: (s) => errors.push(s) },
      runLlmStep: async () => { throw new Error('boom'); },
      runTailscaleWizard: async () => { tailscaleCalled = true; },
    } satisfies FirstBootWizardDeps);
    expect(result.action).toBe('completed');
    expect((result as { stepsRun: string[] }).stepsRun).toEqual(['tailscale']);
    expect(tailscaleCalled).toBe(true);
    expect(errors[0]).toContain('llm step failed: boom');
  });
});

describe('PERSONA-STARTER (0.2.29) — 직업 질문 · 경영 스타터 계약', () => {
  function starterDir(): string {
    return mkdtempSync(join(tmpdir(), 'starter-contract-'));
  }

  test('normalizeOccupationChoice — 1·경영·management 만 경영, 나머지는 일반', () => {
    expect(normalizeOccupationChoice('1')).toBe('management');
    expect(normalizeOccupationChoice(' 경영 ')).toBe('management');
    expect(normalizeOccupationChoice('Management')).toBe('management');
    expect(normalizeOccupationChoice('2')).toBe('general');
    expect(normalizeOccupationChoice('일반')).toBe('general');
    expect(normalizeOccupationChoice('')).toBe('general');
  });

  test('«경영» 선택 → 경영 스타터 계약 정확히 한 개가 만들어진다', async () => {
    const dir = starterDir();
    const { io, printed } = makeIO(['1']);
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      starterContractDir: dir,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    } satisfies FirstBootWizardDeps);
    if (result.action !== 'completed') throw new Error('expected completed');
    // 계약은 정확히 한 장 — persona store 에 starter-management.yaml 하나.
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files).toEqual(['starter-management.yaml']);
    const data = parse(readFileSync(join(dir, 'starter-management.yaml'), 'utf8')) as Record<string, unknown>;
    expect(data.personaId).toBe('starter-management');
    expect(String(data.displayName)).toContain('경영');
    expect(String(data.systemPrompt)).toContain('경영 파트너');
    const summary: StarterContractSummary | undefined = result.starterContract;
    expect(summary?.personaId).toBe('starter-management');
    expect(summary?.path).toBe(join(dir, 'starter-management.yaml'));
    const banner = printed.join('\n');
    expect(banner).toContain('어떤 일');
    expect(banner).toContain('경영 스타터');
  });

  test('일반 선택 → 계약 없이 기존 흐름(stepsRun·banner) 유지', async () => {
    const dir = starterDir();
    const { io, printed } = makeIO(['2']);
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      httpPort: 31415,
      pwaBuilt: true,
      starterContractDir: dir,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    } satisfies FirstBootWizardDeps);
    if (result.action !== 'completed') throw new Error('expected completed');
    expect(result.stepsRun).toEqual(['llm']);
    expect(result.starterContract).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    const banner = printed.join('\n');
    expect(banner).toContain('PWA setup');            // 기존 banner 그대로
    expect(banner).toContain('어떤 일');               // 질문은 뜨되
    expect(banner).not.toContain('스타터 계약이 만들어졌습니다');
  });

  test('직업 질문 취소·입력 실패 → 기존 설정 결과를 유지하고 계약을 만들지 않는다', async () => {
    for (const reason of ['cancelled', 'input failed']) {
      const dir = starterDir();
      const errors: string[] = [];
      const { io } = makeIO();
      io.ask = async () => { throw new Error(reason); };
      const result = await runFirstBootWizard({
        io,
        setupStatus: makeStatus(false),
        forceTty: true,
        starterContractDir: dir,
        out: { log: () => undefined, error: (s) => errors.push(s) },
        runLlmStep: async () => undefined,
        runTailscaleWizard: async () => undefined,
      } satisfies FirstBootWizardDeps);
      if (result.action !== 'completed') throw new Error('expected completed');
      expect(result.stepsRun).toEqual(['llm']);
      expect(result.starterContract).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
      expect(errors).toEqual([`first-boot wizard: occupation question failed: ${reason}`]);
    }
  });

  test('nonInteractive IO → 질문 생략, 계약 없음', async () => {
    const dir = starterDir();
    const printed: string[] = [];
    let askCalls = 0;
    const io: WizardIO = {
      ask: async () => { askCalls += 1; return ''; },
      print: (s: string) => { printed.push(s); },
      close: () => undefined,
      nonInteractive: true,
    };
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      starterContractDir: dir,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    } satisfies FirstBootWizardDeps);
    if (result.action !== 'completed') throw new Error('expected completed');
    expect(askCalls).toBe(0);
    expect(result.starterContract).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(printed.join('\n')).not.toContain('어떤 일');
  });

  test('일반 선택 후에도 경영 선택은 여전히 동작한다(회귀 고정)', async () => {
    const dir = starterDir();
    const { io, printed } = makeIO(['경영']);
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      starterContractDir: dir,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    } satisfies FirstBootWizardDeps);
    if (result.action !== 'completed') throw new Error('expected completed');
    expect(result.starterContract?.personaId).toBe('starter-management');
    expect(readdirSync(dir).filter((f) => f.endsWith('.yaml'))).toEqual(['starter-management.yaml']);
    expect(printed.join('\n')).toContain('경영 스타터 계약이 만들어졌습니다');
  });
});

describe('PERSONA-STARTER-FU (0.2.35) — 마케팅 선택 스타터 · 첫 실행 문구', () => {
  function starterDir(): string {
    return mkdtempSync(join(tmpdir(), 'starter-marketing-'));
  }

  test('normalizeOccupationChoice — 3·마케팅·marketing 은 마케팅, 기존 1·경영·management·2·일반·빈값 회귀 없음', () => {
    expect(normalizeOccupationChoice('3')).toBe('marketing');
    expect(normalizeOccupationChoice(' 마케팅 ')).toBe('marketing');
    expect(normalizeOccupationChoice('Marketing')).toBe('marketing');
    expect(normalizeOccupationChoice('1')).toBe('management');
    expect(normalizeOccupationChoice('경영')).toBe('management');
    expect(normalizeOccupationChoice('Management')).toBe('management');
    expect(normalizeOccupationChoice('2')).toBe('general');
    expect(normalizeOccupationChoice('일반')).toBe('general');
    expect(normalizeOccupationChoice('')).toBe('general');
  });

  test('«마케팅» 선택 → 마케팅 스타터 계약 정확히 한 개가 만들어진다', async () => {
    const dir = starterDir();
    const { io, printed } = makeIO(['3']);
    const result = await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      starterContractDir: dir,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    } satisfies FirstBootWizardDeps);
    if (result.action !== 'completed') throw new Error('expected completed');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files).toEqual(['starter-marketing.yaml']);
    const data = parse(readFileSync(join(dir, 'starter-marketing.yaml'), 'utf8')) as Record<string, unknown>;
    expect(data.personaId).toBe('starter-marketing');
    expect(String(data.displayName)).toContain('마케팅');
    expect(String(data.systemPrompt)).toContain('마케팅');
    const summary: StarterContractSummary | undefined = result.starterContract;
    expect(summary?.personaId).toBe('starter-marketing');
    expect(summary?.path).toBe(join(dir, 'starter-marketing.yaml'));
    const banner = printed.join('\n');
    expect(banner).toContain('마케팅 스타터 계약이 만들어졌습니다');
  });

  test('첫 실행 문구 — 직업 질문에 마케팅 선택지가 나오고 기존 경영·일반 문구는 그대로', async () => {
    const dir = starterDir();
    const { io, printed, asked } = makeIO(['2']);
    await runFirstBootWizard({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      starterContractDir: dir,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    } satisfies FirstBootWizardDeps);
    const banner = printed.join('\n');
    expect(banner).toContain('어떤 일');
    expect(banner).toContain('1) 경영');
    expect(banner).toContain('마케팅');
    expect(banner).toContain('2) 일반');
    expect(asked).toContain('  선택 (1/2/3 · Enter=일반): ');
    expect(printed.filter((line) => line.includes('선택 ('))).toHaveLength(0);
    expect(banner).not.toContain('스타터 계약이 만들어졌습니다');
  });

  test('마케팅 선택 후 동일 선택 재실행 → fail-soft, 파일은 여전히 한 개', async () => {
    const dir = starterDir();
    const errors: string[] = [];
    const out = { log: () => undefined, error: (s: string) => errors.push(s) };
    const deps = (io: WizardIO): FirstBootWizardDeps => ({
      io,
      setupStatus: makeStatus(false),
      forceTty: true,
      starterContractDir: dir,
      out,
      runLlmStep: async () => undefined,
      runTailscaleWizard: async () => undefined,
    });
    const first = await runFirstBootWizard(deps(makeIO(['3']).io));
    const second = await runFirstBootWizard(deps(makeIO(['3']).io));
    if (first.action !== 'completed' || second.action !== 'completed') throw new Error('expected completed');
    expect(first.starterContract?.personaId).toBe('starter-marketing');
    expect(second.starterContract).toBeUndefined();
    expect(errors[0]).toContain('starter contract failed');
    expect(readdirSync(dir).filter((f) => f.endsWith('.yaml'))).toEqual(['starter-marketing.yaml']);
  });
});
